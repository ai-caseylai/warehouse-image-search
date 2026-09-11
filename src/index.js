// 大家庭集團貨品條碼庫 Worker
// 拍照 → 向量重複檢查（已入庫通知）→ 自動 12 位碼 → R2 + Vectorize
// 查碼：掃碼／輸入碼；搜尋：文字／圖片 → 查一維碼
// 刪除一律為軟刪除（保留檔案與向量，可經 /restore 還原）；?hard=1 先會真正移除
const EMBED_API =
  "https://dashscope-intl.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding";
const MAX_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_PER_CODE = 6;
const EXT = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/gif": ".gif",
};

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
    },
  });
}

function checkAuth(env, req, url) {
  if (!env.AUTH_TOKEN) return true;
  const h = req.headers.get("authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : url.searchParams.get("token");
  return token === env.AUTH_TOKEN;
}

/* ===== 千問多模態向量 ===== */
async function embed(env, content) {
  const res = await fetch(EMBED_API, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.DASHSCOPE_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: env.EMBED_MODEL || "tongyi-embedding-vision-flash",
      input: { contents: [content] },
    }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || d.code || !d.output?.embeddings?.[0]) {
    throw new Error(d.message || `Embedding API error (${res.status})`);
  }
  return d.output.embeddings[0].embedding;
}
async function toDataURI(bytes, type) {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return `data:${type};base64,${btoa(bin)}`;
}
const vecIdOf = (key) => key.replace(/\.[^.]+$/, "");

/* ===== 12 位獨一無二碼：YYMMDDHHMMSS（碰撞自動順延）===== */
function baseCode(now = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return (
    String(now.getFullYear() % 100) + p(now.getMonth() + 1) + p(now.getDate()) +
    p(now.getHours()) + p(now.getMinutes()) + p(now.getSeconds())
  );
}
async function newUniqueCode(env) {
  for (let i = 0; i < 600; i++) {
    const code = baseCode(new Date(Date.now() + i * 1000));
    if (!(await env.IMAGES.head(`codes/${code}.json`))) return code;
  }
  throw new Error("無法生成唯一碼，請稍後再試");
}
async function getReg(env, code) {
  const obj = await env.IMAGES.get(`codes/${code}.json`);
  if (!obj) return null;
  try { return JSON.parse(await obj.text()); } catch { return null; }
}
function regImages(reg) {
  return (reg?.images || []).map((im) => ({ ...im, url: `/files/${im.key}` }));
}
function activeImages(reg) {
  return (reg?.images || []).filter((im) => !im.deletedAt);
}
function regActiveImages(reg) {
  return activeImages(reg).map((im) => ({ ...im, url: `/files/${im.key}` }));
}
async function saveReg(env, reg) {
  await env.IMAGES.put(`codes/${reg.code}.json`, JSON.stringify(reg), {
    httpMetadata: { contentType: "application/json" },
  });
}
function cleanField(v, max = 60) {
  return String(v ?? "").trim().slice(0, max);
}
async function loadAllRegs(env) {
  const entries = [];
  let cursor;
  do {
    const page = await env.IMAGES.list({ prefix: "codes/", cursor, limit: 500 });
    entries.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const regs = await Promise.all(
    entries.map(async (o) => {
      try { return JSON.parse(await (await env.IMAGES.get(o.key)).text()); } catch { return null; }
    }),
  );
  return regs.filter(Boolean);
}

/* ===== POST /photos：拍照入庫 =====
   無 code：先向量查重複 → 撞中現有貨品就回 duplicate 提示（不入庫）
   有 code / force=1：直接入庫 */
async function handlePhotos(req, env) {
  const ct = req.headers.get("content-type") || "";
  if (!ct.startsWith("multipart/form-data")) {
    return jsonResp({ error: "請用 multipart/form-data 上傳，欄位名稱 'file'" }, 400);
  }
  const fd = await req.formData();
  const files = fd.getAll("file").filter((f) => f && f.arrayBuffer);
  if (!files.length) return jsonResp({ error: "沒有相片" }, 400);

  let code = String(fd.get("code") || "").replace(/\D/g, "");
  const force = fd.get("force") === "1";
  const dupThreshold = Number(env.DUP_THRESHOLD) || 0.85;
  const info = {
    name: cleanField(fd.get("name")),
    spec: cleanField(fd.get("spec")),
    price: cleanField(fd.get("price"), 20),
    size: cleanField(fd.get("size"), 30),
  };

  // 讀取所有相片
  const items = [];
  for (const f of files) {
    const type = (f.type || "image/jpeg").split(";")[0];
    if (!type.startsWith("image/")) { items.push({ name: f.name, error: "不是圖片格式" }); continue; }
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (bytes.length > MAX_BYTES) { items.push({ name: f.name, error: "檔案太大（上限 10MB）" }); continue; }
    items.push({ bytes, type, name: f.name });
  }
  const valid = items.filter((it) => it.bytes);
  if (!valid.length) return jsonResp({ error: items[0]?.error || "沒有有效相片" }, 400);

  // 重複入庫偵測（只在開新碼時執行）
  if (!code && !force) {
    try {
      const qv = await embed(env, { image: await toDataURI(valid[0].bytes, valid[0].type) });
      const res = await env.VECTOR_INDEX.query(qv, { topK: 3, returnMetadata: true });
      let hit = null;
      for (const m of res.matches) {
        if (!m.metadata?.code || m.score < dupThreshold) continue;
        const hreg = await getReg(env, m.metadata.code);
        if (!hreg || hreg.deletedAt) continue; // 已刪除的碼不提示
        if (m.metadata.key && !activeImages(hreg).some((im) => im.key === m.metadata.key)) continue; // 已刪除的相片不提示
        hit = { m, reg: hreg };
        break;
      }
      if (hit) {
        const { m, reg: hreg } = hit;
        return jsonResp({
          duplicate: true,
          message: `⚠️ 這件貨可能已經入庫（相似度 ${Math.round(m.score * 100)}%）`,
          match: {
            code: m.metadata.code,
            score: Number(m.score.toFixed(4)),
            similarity: Math.round(m.score * 100),
            url: `/files/${m.metadata.key}`,
            count: activeImages(hreg).length,
            name: hreg?.name || "",
            size: hreg?.size || "",
          },
        });
      }
    } catch (e) {
      // 向量服務失敗不阻塞入庫
      console.warn("dup-check failed:", String(e.message || e));
    }
  }

  // 編碼
  let reg = null;
  let created = false;
  if (code) {
    if (code.length !== 12) return jsonResp({ error: "碼必須是 12 位數字" }, 400);
    reg = await getReg(env, code);
    if (reg?.deletedAt) return jsonResp({ error: `碼 ${code} 已刪除，請先還原`, code, deleted: true }, 400);
  } else {
    code = await newUniqueCode(env);
    created = true;
  }
  if (!reg) {
    reg = { code, createdAt: new Date().toISOString(), images: [], name: info.name, spec: info.spec, price: info.price, size: info.size };
    created = true;
  }
  const activeCount = activeImages(reg).length;
  if (activeCount + valid.length > MAX_PER_CODE) {
    return jsonResp(
      { error: `每個碼最多 ${MAX_PER_CODE} 張相片（${code} 已有 ${activeCount} 張）`, code, count: activeCount },
      400,
    );
  }

  // 入庫：R2 + 向量
  const added = [];
  for (const it of valid) {
    const ext = EXT[it.type] || ".jpg";
    let seq = reg.images.reduce((mx, im) => Math.max(mx, im.seq || 0), 0) + 1;
    let key = `img/${code}/${seq}${ext}`;
    while (reg.images.some((im) => im.key === key)) { seq++; key = `img/${code}/${seq}${ext}`; }
    const uploadedAt = new Date().toISOString();
    await env.IMAGES.put(key, it.bytes, {
      httpMetadata: { contentType: it.type },
      customMetadata: { code, seq: String(seq), uploadedAt },
    });
    try {
      const values = await embed(env, { image: await toDataURI(it.bytes, it.type) });
      await env.VECTOR_INDEX.upsert([
        { id: vecIdOf(key), values, metadata: { code, key, seq, uploadedAt: Date.now() } },
      ]);
    } catch (e) {
      console.warn("embed failed for", key, String(e.message || e));
    }
    reg.images.push({ key, seq, type: it.type, size: it.bytes.length, uploadedAt });
    added.push({ key, seq, url: `/files/${key}` });
  }

  await env.IMAGES.put(`codes/${code}.json`, JSON.stringify(reg), {
    httpMetadata: { contentType: "application/json" },
  });

  return jsonResp({
    ok: true,
    code,
    created,
    count: activeImages(reg).length,
    max: MAX_PER_CODE,
    added,
    images: regActiveImages(reg),
    createdAt: reg.createdAt,
    name: reg.name || "",
    spec: reg.spec || "",
    price: reg.price || "",
    size: reg.size || "",
  });
}

/* ===== POST /search：文字／圖片 → 查一維碼 ===== */
async function handleSearch(req, env, url) {
  const topK = Math.min(Number(url.searchParams.get("topK")) || 10, 30);
  const ct = req.headers.get("content-type") || "";
  let qv, mode, textQuery = "";
  if (ct.startsWith("multipart/form-data")) {
    const fd = await req.formData();
    const f = fd.get("file") || fd.get("image");
    if (!f || !f.arrayBuffer) return jsonResp({ error: "缺少圖片檔案" }, 400);
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (bytes.length > MAX_BYTES) return jsonResp({ error: "檔案太大（上限 10MB）" }, 400);
    qv = await embed(env, { image: await toDataURI(bytes, f.type || "image/jpeg") });
    mode = "image";
  } else {
    const body = await req.json().catch(() => ({}));
    if (body.text) {
      textQuery = String(body.text).slice(0, 500);
      qv = await embed(env, { text: textQuery });
      mode = "text";
    } else if (body.image) {
      qv = await embed(env, { image: body.image });
      mode = "image";
    } else {
      return jsonResp({ error: "請提供 {text}、{image: dataURI} 或 multipart 圖片" }, 400);
    }
  }
  const res = await env.VECTOR_INDEX.query(qv, { topK, returnMetadata: true });
  // 以「碼」為單位聚合結果（跳過已軟刪除的碼與相片）
  const byCode = new Map();
  const regCache = new Map();
  for (const m of res.matches) {
    const code = m.metadata?.code;
    if (!code) continue; // 舊測試資料無碼，略過
    if (!regCache.has(code)) regCache.set(code, await getReg(env, code));
    const reg = regCache.get(code);
    if (!reg || reg.deletedAt) continue;
    if (m.metadata.key && !activeImages(reg).some((im) => im.key === m.metadata.key)) continue;
    if (!byCode.has(code)) {
      byCode.set(code, { code, bestScore: m.score, images: [], count: 0 });
    }
    const g = byCode.get(code);
    g.bestScore = Math.max(g.bestScore, m.score);
    if (m.metadata.key) g.images.push({ key: m.metadata.key, url: `/files/${m.metadata.key}`, score: Number(m.score.toFixed(4)) });
  }
  const groups = [...byCode.values()].sort((a, b) => b.bestScore - a.bestScore);
  // 補充每個碼的相片數
  for (const g of groups) {
    const reg = regCache.get(g.code);
    const act = activeImages(reg);
    g.count = act.length;
    g.createdAt = reg?.createdAt || null;
    if (act.length) g.images = regActiveImages(reg);
    g.similarity = Math.round(g.bestScore * 100);
    g.name = reg?.name || "";
    g.spec = reg?.spec || "";
    g.price = reg?.price || "";
    g.size = reg?.size || "";
    delete g.bestScore;
  }
  let out = groups;
  if (mode === "text" && textQuery.trim()) {
    // 名稱／規格文字配對（優先於向量結果）
    const q = textQuery.trim().toLowerCase();
    const regs = await loadAllRegs(env);
    const matched = [];
    for (const reg of regs) {
      if (reg.deletedAt) continue;
      const hay = `${reg.name || ""} ${reg.spec || ""}`.toLowerCase();
      if ((reg.name || reg.spec) && hay.includes(q)) {
        matched.push({
          code: reg.code, nameMatch: true, similarity: 100,
          count: activeImages(reg).length, createdAt: reg.createdAt,
          images: regActiveImages(reg),
          name: reg.name || "", spec: reg.spec || "", price: reg.price || "", size: reg.size || "",
        });
      }
    }
    if (matched.length) {
      const hitCodes = new Set(matched.map((x) => x.code));
      out = [...matched, ...groups.filter((g) => !hitCodes.has(g.code))];
    }
  }
  return jsonResp({ mode, results: out });
}


/* ===== 舊版相容路由（供未更新到新版介面的裝置過渡）===== */
async function handleListLegacy(env) {
  const entries = [];
  let cursor;
  do {
    const page = await env.IMAGES.list({ cursor, limit: 500 });
    entries.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const out = entries
    .filter((o) => !o.key.startsWith("codes/"))
    .map((o) => ({
      key: o.key,
      url: `/files/${o.key}`,
      filename: o.key.split("/").pop(),
      size: o.size,
      uploadedAt: o.uploaded ? new Date(o.uploaded).toISOString() : null,
    }))
    .sort((a, b) => String(b.uploadedAt || "").localeCompare(String(a.uploadedAt || "")));
  return jsonResp({ count: out.length, images: out });
}

/* ===== GET /codes：碼清單（預設只列有效碼；?deleted=1 列出已軟刪除的碼）===== */
async function handleListCodes(env, url) {
  const wantDeleted = url.searchParams.get("deleted") === "1";
  const regs = await loadAllRegs(env);
  const out = regs
    .filter((r) => (wantDeleted ? Boolean(r.deletedAt) : !r.deletedAt))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .map((r) => {
      const act = activeImages(r);
      return {
        code: r.code,
        createdAt: r.createdAt,
        deletedAt: r.deletedAt || null,
        count: act.length,
        firstImage: act[0] ? `/files/${act[0].key}` : null,
        name: r.name || "",
        spec: r.spec || "",
        price: r.price || "",
        size: r.size || "",
      };
    });
  return jsonResp({ count: out.length, max: MAX_PER_CODE, codes: out });
}

/* ===== GET /codes/{code}：查碼 ===== */
async function handleGetCode(env, code) {
  const reg = await getReg(env, code);
  if (!reg) return jsonResp({ error: `找不到碼 ${code}`, code }, 404);
  if (reg.deletedAt) return jsonResp({ error: `碼 ${code} 已刪除（可還原）`, code, deleted: true, deletedAt: reg.deletedAt }, 404);
  return jsonResp({
    code: reg.code, createdAt: reg.createdAt, count: activeImages(reg).length, max: MAX_PER_CODE,
    name: reg.name || "", spec: reg.spec || "", price: reg.price || "", size: reg.size || "",
    images: regActiveImages(reg),
  });
}

/* ===== DELETE /codes/{code}：軟刪除（?hard=1 先會真正移除檔案＋向量）===== */
async function handleDeleteCode(env, code, url) {
  const reg = await getReg(env, code);
  if (!reg) return jsonResp({ error: `找不到碼 ${code}`, code }, 404);
  if (url.searchParams.get("hard") === "1") {
    const keys = reg.images.map((im) => im.key);
    await env.IMAGES.delete([`codes/${code}.json`, ...keys]);
    await env.VECTOR_INDEX.deleteByIds(keys.map(vecIdOf)).catch(() => {});
    return jsonResp({ deleted: code, photos: keys.length, hard: true });
  }
  reg.deletedAt = new Date().toISOString();
  await saveReg(env, reg);
  return jsonResp({ deleted: code, photos: activeImages(reg).length, soft: true, restore: `POST /codes/${code}/restore` });
}

/* ===== POST /codes/{code}/restore：還原已軟刪除的碼 ===== */
async function handleRestoreCode(env, code) {
  const reg = await getReg(env, code);
  if (!reg) return jsonResp({ error: `找不到碼 ${code}`, code }, 404);
  if (!reg.deletedAt) return jsonResp({ ok: true, code, note: "碼未被刪除" });
  delete reg.deletedAt;
  reg.restoredAt = new Date().toISOString();
  await saveReg(env, reg);
  return jsonResp({ restored: code, count: activeImages(reg).length });
}

/* ===== PATCH /codes/{code}：更新貨品資料（名稱／規格／價錢）===== */
async function handlePatchCode(req, env, code) {
  const reg = await getReg(env, code);
  if (!reg) return jsonResp({ error: `找不到碼 ${code}`, code }, 404);
  if (reg.deletedAt) return jsonResp({ error: `碼 ${code} 已刪除，請先還原`, code, deleted: true }, 400);
  const body = await req.json().catch(() => ({}));
  if (typeof body.name === "string") reg.name = cleanField(body.name);
  if (typeof body.spec === "string") reg.spec = cleanField(body.spec);
  if (typeof body.price === "string") reg.price = cleanField(body.price, 20);
  if (typeof body.size === "string") reg.size = cleanField(body.size, 30);
  reg.updatedAt = new Date().toISOString();
  await env.IMAGES.put(`codes/${code}.json`, JSON.stringify(reg), {
    httpMetadata: { contentType: "application/json" },
  });
  return jsonResp({ ok: true, code, name: reg.name || "", spec: reg.spec || "", price: reg.price || "", size: reg.size || "" });
}


/* ===== POST /estimate-size：AI 粗估尺寸（方格紙每格 1cm，VLM 數格估算）===== */
const VISION_API =
  "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";

async function dataURIFromCode(env, code) {
  const reg = await getReg(env, code);
  if (!reg || reg.deletedAt) return { error: `找不到碼 ${code}`, status: 404 };
  const act = activeImages(reg);
  if (!act.length) return { error: "此碼沒有相片可估算", status: 400 };
  const im = act[act.length - 1];
  const obj = await env.IMAGES.get(im.key);
  if (!obj) return { error: "相片檔案遺失", status: 404 };
  return { dataURI: await toDataURI(new Uint8Array(await obj.arrayBuffer()), im.type || "image/jpeg") };
}

async function handleEstimateSize(req, env, url) {
  let dataURI = null;
  const ct = req.headers.get("content-type") || "";
  if (ct.startsWith("multipart/form-data")) {
    const fd = await req.formData();
    const f = fd.get("file");
    if (f && f.arrayBuffer) {
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (bytes.length > MAX_BYTES) return jsonResp({ error: "檔案太大（上限 10MB）" }, 400);
      dataURI = await toDataURI(bytes, (f.type || "image/jpeg").split(";")[0]);
    } else {
      const code = String(fd.get("code") || "").replace(/\D/g, "");
      if (code.length !== 12) return jsonResp({ error: "請提供相片檔案或 12 位碼" }, 400);
      const got = await dataURIFromCode(env, code);
      if (got.error) return jsonResp({ error: got.error }, got.status);
      dataURI = got.dataURI;
    }
  } else {
    const body = await req.json().catch(() => ({}));
    if (typeof body.image === "string" && body.image.startsWith("data:")) {
      dataURI = body.image;
    } else if (body.code) {
      const got = await dataURIFromCode(env, String(body.code).replace(/\D/g, ""));
      if (got.error) return jsonResp({ error: got.error }, got.status);
      dataURI = got.dataURI;
    } else {
      return jsonResp({ error: "請提供 {code}、{image: dataURI} 或 multipart 相片" }, 400);
    }
  }

  const prompt = [
    "這是倉庫貨品照片，背景是方格紙（每格 1cm × 1cm）。",
    "請觀察貨品本身（不是方格紙），數一數它佔了多少格，估算它的最大闊度和最大高度（cm，可估到 0.5）。",
    "只回覆一行 JSON，不要輸出任何其他文字：",
    '{"width_cm": 數字, "height_cm": 數字, "confidence": "high/medium/low", "note": "10字以內說明"}',
    '如果看不到方格紙或無法估算，回覆 {"width_cm":0,"height_cm":0,"confidence":"low","note":"看不到方格紙"}',
  ].join("\n");

  const res = await fetch(VISION_API, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.DASHSCOPE_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: env.VISION_MODEL || "qwen-vl-max",
      input: { messages: [{ role: "user", content: [{ image: dataURI }, { text: prompt }] }] },
      parameters: { result_format: "message" },
    }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || d.code) {
    return jsonResp({ error: d.message || `Vision API 錯誤（${res.status}）` }, 502);
  }
  let content = d.output?.choices?.[0]?.message?.content ?? d.output?.text;
  if (Array.isArray(content)) content = content.map((c) => c.text || "").join("");
  content = String(content || "").trim();
  const jm = content.match(/\{[\s\S]*\}/);
  if (!jm) return jsonResp({ error: "AI 回覆無法識別", raw: content }, 502);
  let est;
  try { est = JSON.parse(jm[0]); } catch { return jsonResp({ error: "AI 回覆解析失敗", raw: content }, 502); }
  const w = Number(est.width_cm), h = Number(est.height_cm);
  if (!w || !h || w <= 0 || h <= 0) {
    return jsonResp({ ok: false, error: est.note || "無法估算（請確保相片內有方格紙）", raw: content });
  }
  return jsonResp({
    ok: true,
    width_cm: w,
    height_cm: h,
    size: `${w} × ${h} cm`,
    confidence: String(est.confidence || "medium"),
    note: String(est.note || ""),
    raw: content,
  });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
          "access-control-allow-headers": "authorization,content-type",
        },
      });
    }

    // 靜態資源（介面、manifest、service worker、icon）
    const isApi =
      p === "/photos" || p === "/codes" || p.startsWith("/codes/") ||
      p.startsWith("/files/") || p === "/search" || p === "/estimate-size" || p === "/health";
    if (req.method === "GET" && !isApi) {
      const res = await env.ASSETS.fetch(new Request(req.url, req));
      if (res.status !== 404) {
        if (p === "/" || p.endsWith(".html")) {
          const r = new Response(res.body, res);
          r.headers.set("cache-control", "no-cache, must-revalidate");
          return r;
        }
        return res;
      }
    }

    // 相片檔案
    if (p.startsWith("/files/")) {
      const key = decodeURIComponent(p.slice("/files/".length));
      if (req.method === "POST" && p.endsWith("/restore")) {
        if (!checkAuth(env, req, url)) return jsonResp({ error: "未授權" }, 401);
        const fkey = decodeURIComponent(p.slice("/files/".length, -"/restore".length));
        const m3 = fkey.match(/^img\/(\d{12})\//);
        if (!m3) return jsonResp({ error: "無法識別的相片路徑" }, 400);
        const reg3 = await getReg(env, m3[1]);
        if (!reg3) return jsonResp({ error: `找不到碼 ${m3[1]}` }, 404);
        const im3 = (reg3.images || []).find((x) => x.key === fkey);
        if (!im3) return jsonResp({ error: "找不到該相片記錄" }, 404);
        if (!im3.deletedAt) return jsonResp({ ok: true, key: fkey, note: "相片未被刪除" });
        delete im3.deletedAt;
        await saveReg(env, reg3);
        return jsonResp({ restored: fkey });
      }
      if (req.method === "DELETE") {
        if (!checkAuth(env, req, url)) return jsonResp({ error: "未授權" }, 401);
        const m2 = key.match(/^img\/(\d{12})\//);
        const reg2 = m2 ? await getReg(env, m2[1]) : null;
        if (url.searchParams.get("hard") === "1") {
          await env.IMAGES.delete(key);
          await env.VECTOR_INDEX.deleteByIds([vecIdOf(key)]).catch(() => {});
          if (reg2) {
            reg2.images = reg2.images.filter((im) => im.key !== key);
            await saveReg(env, reg2);
          }
          return jsonResp({ deleted: key, hard: true });
        }
        if (reg2) {
          const im2 = (reg2.images || []).find((x) => x.key === key);
          if (!im2) return jsonResp({ error: "找不到該相片記錄" }, 404);
          im2.deletedAt = new Date().toISOString();
          await saveReg(env, reg2);
        }
        return jsonResp({ deleted: key, soft: true, restore: `POST /files/${encodeURIComponent(key)}/restore` });
      }
      const obj = await env.IMAGES.get(key);
      if (!obj) return new Response("Not found", { status: 404 });
      return new Response(obj.body, {
        headers: {
          "content-type": obj.httpMetadata?.contentType || "application/octet-stream",
          "cache-control": "public, max-age=31536000, immutable",
          "access-control-allow-origin": "*",
        },
      });
    }

    if (!checkAuth(env, req, url)) return jsonResp({ error: "未授權：請提供 Bearer token" }, 401);

    try {
      // 舊版介面相容（已安裝舊 PWA 的裝置過渡用）
      if (p === "/images" && req.method === "GET") return await handleListLegacy(env);
      if (p === "/images" && req.method === "POST") {
        const resp = await handlePhotos(req, env);
        const d = await resp.json();
        if (d.duplicate) {
          return jsonResp({ indexed: [{ name: "photo", error: d.message + "（現有碼 " + d.match.code + "）" }] }, 400);
        }
        if (!resp.ok) return jsonResp({ indexed: [{ error: d.error }] }, resp.status);
        return jsonResp({
          code: d.code,
          indexed: d.added.map((a) => ({ id: vecIdOf(a.key), key: a.key, filename: a.key.split("/").pop(), url: a.url })),
        });
      }
      if (p === "/photos" && req.method === "POST") return await handlePhotos(req, env);
      if (p === "/search" && req.method === "POST") return await handleSearch(req, env, url);
      if (p === "/estimate-size" && req.method === "POST") return await handleEstimateSize(req, env, url);
      if (p === "/codes" && req.method === "GET") return await handleListCodes(env, url);
      const mr = p.match(/^\/codes\/(\d{12})\/restore$/);
      if (mr && req.method === "POST") return await handleRestoreCode(env, mr[1]);
      const m = p.match(/^\/codes\/(\d{12})$/);
      if (m && req.method === "GET") return await handleGetCode(env, m[1]);
      if (m && req.method === "DELETE") return await handleDeleteCode(env, m[1], url);
      if (m && req.method === "PATCH") return await handlePatchCode(req, env, m[1]);
      if (p === "/health") {
        return jsonResp({
          ok: true,
          app: "大家庭集團貨品條碼庫",
          model: env.EMBED_MODEL || "tongyi-embedding-vision-flash",
          maxPerCode: MAX_PER_CODE,
          dupThreshold: Number(env.DUP_THRESHOLD) || 0.85,
          auth: Boolean(env.AUTH_TOKEN),
        });
      }
      return jsonResp(
        { error: "找不到路由", routes: ["POST /photos", "POST /search", "GET /codes", "GET /codes/{code}", "PATCH /codes/{code}", "DELETE /codes/{code}（軟刪除）", "POST /codes/{code}/restore", "GET /files/{key}", "DELETE /files/{key}（軟刪除）", "POST /files/{key}/restore", "POST /estimate-size"] },
        404,
      );
    } catch (e) {
      return jsonResp({ error: String(e.message || e) }, 500);
    }
  },
};
