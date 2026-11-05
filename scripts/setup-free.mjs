#!/usr/bin/env node
/**
 * 免費版一鍵設定（只做技術步驟；account 同 Jina key 要你自己開）
 *
 * 用法：
 *   node scripts/setup-free.mjs --check   # 只檢查準備好未，唔會改任何嘢
 *   node scripts/setup-free.mjs           # 建立 KV / Vectorize / secret / deploy
 *
 * 憑證（任選一種）：
 *   CLOUDFLARE_API_TOKEN 環境變數，或檔案 ~/.cf_api_token_warehouse（或 ~/.cf_api_token）
 *   JINA_API_KEY         環境變數，或檔案 ~/.jina_api_key
 *   CLOUDFLARE_ACCOUNT_ID（可選）
 *
 * 注意：唔會 print token / key。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = path.join(ROOT, "wrangler.free.jsonc");
const INDEX_NAME = "image-vectors-free";
const DIMENSIONS = 256;
const CHECK_ONLY = process.argv.includes("--check");

const home = os.homedir();
function readFileIf(p) {
  try { return fs.readFileSync(p, "utf8").trim(); } catch { return ""; }
}
function firstNonEmpty(...v) { return v.find((x) => x && x.trim()) || ""; }

/* ---------- locate wrangler ---------- */
const wranglerCandidates = [
  process.env.WRANGLER_BIN,
  "C:/Users/User/Documents/GitHub/e-plus-d1/node_modules/wrangler/bin/wrangler.js",
  path.join(ROOT, "node_modules/wrangler/bin/wrangler.js"),
].filter(Boolean);
const WRANGLER = wranglerCandidates.find((p) => fs.existsSync(p));
if (!WRANGLER) {
  console.error("❌ 搵唔到 wrangler。請設定 WRANGLER_BIN 或安裝 wrangler。");
  process.exit(1);
}

/* ---------- credentials ---------- */
// 優先次序：環境變數 / 新 account token 檔 → wrangler login（OAuth）→ 舊 ~/.cf_api_token（只作最後後備）
const newToken = firstNonEmpty(
  process.env.CLOUDFLARE_API_TOKEN,
  readFileIf(path.join(home, ".cf_api_token_warehouse")),
);
const legacyToken = readFileIf(path.join(home, ".cf_api_token"));
const accountId = firstNonEmpty(
  process.env.CLOUDFLARE_ACCOUNT_ID,
  readFileIf(path.join(home, ".cf_account_id_warehouse")),
);
const jinaKey = firstNonEmpty(
  process.env.JINA_API_KEY,
  readFileIf(path.join(home, ".jina_api_key")),
  readFileIf(path.join(home, "jina-key.txt")),
  readFileIf(path.join(home, "jina_api_key.txt")),
);
const YES = process.argv.includes("--yes");
const ALLOW_LEGACY = process.argv.includes("--allow-legacy-token");

const env = { ...process.env };
// 唔好一開始就塞舊 token，否則會蓋走 wrangler login 嘅新 account
if (newToken) env.CLOUDFLARE_API_TOKEN = newToken;
else delete env.CLOUDFLARE_API_TOKEN;
if (accountId) env.CLOUDFLARE_ACCOUNT_ID = accountId;

function run(args, input) {
  if (!CHECK_ONLY) console.log("▶ wrangler " + args.join(" "));
  return execFileSync(process.execPath, [WRANGLER, ...args], {
    cwd: ROOT,
    env,
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
  });
}
function runSoft(args, input) {
  try { return { ok: true, out: run(args, input) }; }
  catch (e) { return { ok: false, out: String(e.stdout || ""), err: String(e.stderr || e.message || e) }; }
}

let usedLegacy = false;
function authOk(r) {
  const txt = String(r.out || "") + String(r.err || "");
  return r.ok && !/not authenticated|not logged in|please run `wrangler login`/i.test(txt);
}
function detectAuth() {
  // 先用新 token 或 wrangler login（OAuth）
  let who = runSoft(["whoami"]);
  // 兩者都唔得，先至試舊 ~/.cf_api_token（避免誤 deploy 去舊 account）
  if (!authOk(who) && legacyToken && !newToken) {
    env.CLOUDFLARE_API_TOKEN = legacyToken;
    usedLegacy = true;
    who = runSoft(["whoami"]);
  }
  if (!authOk(who)) who.ok = false;
  return who;
}

/* ---------- check mode ---------- */
if (CHECK_ONLY) {
  console.log("wrangler :", WRANGLER);
  console.log("config   :", fs.existsSync(CONFIG) ? CONFIG : "❌ 找唔到 wrangler.free.jsonc");
  console.log("token    :", newToken
    ? "✓ 新 account token（唔會顯示）"
    : (legacyToken ? "⚠ 只有舊 ~/.cf_api_token（可能係舊 account）" : "❌ 未找到 → 先開 Cloudflare account，再 wrangler login 或放 ~/.cf_api_token_warehouse"));
  console.log("account  :", accountId || "(由 wrangler 自動判斷)");
  console.log("jina key :", jinaKey ? "✓ 已找到（唔會顯示）" : "❌ 未找到 → 去 jina.ai 開免費 key，放 ~/.jina_api_key 或 ~/jina-key.txt");
  if (fs.existsSync(CONFIG)) {
    const cfg = fs.readFileSync(CONFIG, "utf8");
    console.log("KV id    :", cfg.includes("REPLACE_WITH_KV_NAMESPACE_ID") ? "未填（script 會自動填）" : "已填");
  }
  const who = detectAuth();
  console.log("whoami   :", who.ok ? "✓ 已登入" : "❌ 未登入／token 無效");
  if (who.ok) {
    console.log("登入 account：");
    console.log(who.out.split("\n").filter(Boolean).slice(0, 10).join("\n"));
    if (usedLegacy) console.log("⚠ 用緊舊 ~/.cf_api_token（可能係舊 account）");
  } else {
    console.log("           " + who.err.split("\n").slice(0, 3).join("\n           "));
  }
  process.exit(who.ok ? 0 : 1);
}

/* ---------- real setup ---------- */
console.log("=== 免費版一鍵設定 ===");
console.log("wrangler:", WRANGLER);

const who = detectAuth();
if (!who.ok) {
  console.error("\n❌ 未登入 Cloudflare。請先做其中一樣：");
  console.error("   1) node \"" + WRANGLER + "\" login   （開 browser 登入新 account）");
  console.error("   2) 去 Dashboard 開 API token，存去 ~/.cf_api_token_warehouse");
  console.error(who.err.split("\n").slice(0, 5).join("\n"));
  process.exit(1);
}
console.log("登入 account：");
console.log(who.out.split("\n").filter(Boolean).slice(0, 10).join("\n"));
if (usedLegacy) {
  console.error("\n⚠ 而家用緊舊 ~/.cf_api_token（可能係舊 account）。");
  console.error("   如果唔係特登想 deploy 去舊 account，請先 wrangler login 新 account，或放新 token 去 ~/.cf_api_token_warehouse。");
  if (!ALLOW_LEGACY) {
    console.error("   確定要繼續就加 --allow-legacy-token。");
    process.exit(1);
  }
}
if (!YES) {
  console.error("\n⚠ 以上係將會 deploy 嘅 Cloudflare account。");
  console.error("   確認正確後，加 --yes 再行：");
  console.error("   node scripts/setup-free.mjs --yes");
  process.exit(1);
}

if (!fs.existsSync(CONFIG)) {
  console.error("❌ 找唔到 wrangler.free.jsonc");
  process.exit(1);
}
if (!jinaKey) {
  console.error("\n❌ 未找到 JINA_API_KEY。");
  console.error("   去 https://jina.ai/ 註冊 → API key（免費 10M tokens，唔使卡）");
  console.error("   然後用 Notepad 存去：C:\\Users\\User\\jina-key.txt");
  console.error("   或 Git Bash：echo '你的key' > ~/jina-key.txt");
  process.exit(1);
}

/* 1) KV namespace */
console.log("\n=== 1/4 KV namespace ===");
let kvId = "";
const kvList = runSoft(["kv", "namespace", "list"]);
if (kvList.ok) {
  let arr = [];
  try { arr = JSON.parse(kvList.out); } catch {}
  const hit = Array.isArray(arr)
    ? arr.find((n) => /IMAGES/i.test(String(n.title || n.name || "")))
    : null;
  if (hit?.id) { kvId = hit.id; console.log("✓ 已存在 KV namespace:", hit.title || hit.name, kvId); }
}
if (!kvId) {
  const created = run(["kv", "namespace", "create", "IMAGES"]);
  kvId = (created.match(/id"?\s*[:=]\s*"([^"]+)"/) || [])[1] || "";
  if (!kvId) {
    console.error("❌ 建立 KV namespace 失敗，output:\n" + created);
    process.exit(1);
  }
  console.log("✓ 已建立 KV namespace:", kvId);
}

let cfg = fs.readFileSync(CONFIG, "utf8");
if (cfg.includes("REPLACE_WITH_KV_NAMESPACE_ID")) {
  cfg = cfg.replace("REPLACE_WITH_KV_NAMESPACE_ID", kvId);
  fs.writeFileSync(CONFIG, cfg);
  console.log("✓ 已將 KV id 寫入 wrangler.free.jsonc");
} else {
  console.log("ℹ wrangler.free.jsonc 已經有 KV id，跳過");
}

/* 2) Vectorize index */
console.log("\n=== 2/4 Vectorize index ===");
let vectorExists = false;
const vList = runSoft(["vectorize", "list", "--json"]);
if (vList.ok) {
  let arr = [];
  try { const j = JSON.parse(vList.out); arr = Array.isArray(j) ? j : (j.result || []); } catch {}
  vectorExists = arr.some((v) => (v.name || v.index_name) === INDEX_NAME);
}
if (vectorExists) {
  console.log("✓ Vectorize index 已存在:", INDEX_NAME);
} else {
  const created = run(["vectorize", "create", INDEX_NAME, `--dimensions=${DIMENSIONS}`, "--metric=cosine"]);
  console.log(created.trim());
  console.log("✓ 已建立 Vectorize index:", INDEX_NAME, `(${DIMENSIONS} dims, cosine)`);
}

/* 3) Jina secret */
console.log("\n=== 3/4 Jina secret ===");
run(["secret", "put", "JINA_API_KEY", "--config", "wrangler.free.jsonc"], jinaKey + "\n");
console.log("✓ 已設定 JINA_API_KEY");

/* 4) Deploy + verify */
console.log("\n=== 4/4 Deploy ===");
const dep = run(["deploy", "--config", "wrangler.free.jsonc"]);
console.log(dep.trim().split("\n").slice(-12).join("\n"));
const url = (dep.match(/https:\/\/[^\s]+\.workers\.dev/) || [])[0];

if (!url) {
  console.log("\n⚠ 搵唔到 deploy URL，請睇上面 output。");
  process.exit(0);
}
console.log("\n=== 驗證 ===");
try {
  const res = await fetch(url + "/health", { headers: { "cache-control": "no-cache" } });
  const health = await res.json();
  console.log(url + "/health →", res.status);
  console.log(JSON.stringify(health, null, 2));
  if (health.storage === "kv" && health.embedProvider === "jina" && health.visionProvider === "workers-ai") {
    console.log("\n✅ 免費版設定完成！開 " + url + " 試拍。");
  } else {
    console.log("\n⚠ health 顯示嘅 provider 唔係預期，請檢查 config。");
  }
} catch (e) {
  console.log("⚠ health 驗證失敗:", e.message || e);
}
