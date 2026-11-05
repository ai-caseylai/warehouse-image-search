# 免費 Demo 版（Workers Free + KV + Vectorize Free + Jina CLIP v2 + Workers AI）

呢個版本同正式版**共用同一份 `src/index.js`**，分別只在於用邊個 `wrangler` config：

| | 正式版 | 免費 Demo 版 |
|---|---|---|
| Config | `wrangler.jsonc` | `wrangler.free.jsonc` |
| 圖片儲存 | R2（要綁付款方式） | **KV（唔使卡）** |
| 向量搜尋 | Vectorize（768 維） | **Vectorize 免費 tier（256 維）** |
| 圖片向量 | DashScope `tongyi-embedding-vision-flash` | **Jina `jina-clip-v2`（免費 key）** |
| AI 估尺寸 | DashScope `qwen-vl-max` | **Workers AI（免費 10,000 neurons/day）** |

`src/index.js` 會自動偵測：
- `env.IMAGES.head` 存在 → R2；否則 → KV
- `EMBED_PROVIDER=jina` 或只有 `JINA_API_KEY` → Jina；否則 → DashScope
- `VISION_PROVIDER=workers-ai` 且 `env.AI` 存在 → Workers AI；否則 → DashScope

---

## 一次性設定（完全唔使綁信用卡）

### 1. 開 Cloudflare Free account
- https://dash.cloudflare.com/sign-up
- **唔好開 Workers Paid、唔好開 R2**；Free plan 就夠
- 喺 Workers & Pages 第一次 deploy 時，設定一個 `workers.dev` subdomain

### 2. 登入 wrangler
```bash
WR="/c/Users/User/Documents/GitHub/e-plus-d1/node_modules/wrangler/bin/wrangler.js"
node "$WR" login
node "$WR" whoami
```

### 3. 建立 KV namespace
```bash
cd /c/Users/User/Documents/GitHub/warehouse-image-search
node "$WR" kv namespace create IMAGES --config wrangler.free.jsonc
```
輸出會有 `id = "xxxxxxxx..."`，將佢貼入 `wrangler.free.jsonc`：
```jsonc
"kv_namespaces": [
  { "binding": "IMAGES", "id": "貼呢度" }
]
```

### 4. 建立 Vectorize index（256 維）
```bash
node "$WR" vectorize create image-vectors-free --dimensions=256 --metric=cosine
node "$WR" vectorize list
```
> ⚠️ `EMBED_DIMENSIONS=256` 一定要同 index 嘅 `dimensions` 一樣；建立後唔可以改。

### 5. 攞 Jina 免費 key
- https://jina.ai/ → 註冊 → API key（Free：10M tokens 一次性，唔使卡）
- 設 secret：
```bash
node "$WR" secret put JINA_API_KEY --config wrangler.free.jsonc
```

### 6. Deploy
```bash
node "$WR" deploy --config wrangler.free.jsonc
```
輸出會係：
```
https://image-vector-search-free.<你的-subdomain>.workers.dev
```

### 7. 驗證
```bash
curl https://<新-url>/health
```
應該見到：
```json
{
  "ok": true,
  "storage": "kv",
  "embedProvider": "jina",
  "model": "jina-clip-v2",
  "embedDimensions": 256,
  "visionProvider": "workers-ai",
  ...
}
```
再開網址，試：
1. 拍照 → 出 12 位碼
2. 再拍同款 → 重複提示
3. 以圖搜尋 → 有結果
4. AI 粗估尺寸 → 有數字

---

## 免費額度（大約）

| 資源 | 免費額度 | 大約夠幾多 |
|---|---|---|
| Workers | 100k requests/day、10ms CPU、128MB | 一般 demo 夠 |
| KV | 1GB、100k reads/day、**1k writes/day**、25MB/value | 每日約 500 張相（每張 2 writes） |
| Vectorize | 5M stored dims、30M queried dims/月 | **256 維 → 約 19,500 張向量**；約 117k 次搜尋/月 |
| Jina CLIP v2 | 10M tokens 一次性 | 約 625 張全尺寸圖／2,500 張 512×512 |
| Workers AI | 10,000 neurons/day | AI 估尺寸幾十次／日 |

> 以上係 demo／pilot 規模；長期大倉庫要升級或者換返 R2／DashScope。

---

## 注意事項

1. **R2 唔用**：R2 就算免費額度都要綁信用卡，所以免費版用 KV。KV 係 **eventually consistent**，上傳／刪除後即刻再讀可能短暫讀到舊資料。
2. **KV 寫入限制**：同一個 key 每秒最多 1 次寫入；每日 1,000 次。多人同時寫同一個碼會更容易衝突（現有 code 本身已經有 race，正式版都未修）。
3. **Workers Free CPU 10ms**：前端已自動縮圖（上傳 1024px、搜尋 512px）；`visionWorkersAI` 亦會拒絕 >2MB 嘅相。
4. **Jina 10M tokens 一次性 + 每分鐘 100k tokens 上限**：
   - 1920×1080 全尺寸一張 = 約 48k tokens；縮到 1024px = 約 16k；搜尋 512px = 約 4k。
   - 免費 key 每分鐘最多約 6 張 1024px 上傳，或約 25 次 512px 搜尋。**唔好連續狂 upload**，否則第 4 張起會 429（相片會入庫但冇向量）。
   - 正常上傳（非 force）已改成**重用查重嗰個向量**，一張相只 embed 一次。
5. **Jina 分數**：`DUP_THRESHOLD=0.82` 係起點，要用真實相片 calibrate；太敏感會成日誤報重複。
6. **Workers AI model ID**：`@cf/llava-hf/llava-1.5-7b-hf` 係預設；如果 Cloudflare 改咗 model 名，喺 Dashboard → Workers AI 揀一個 vision model，改 `WORKERS_AI_VISION_MODEL`。
7. **兩個 config 唔好同時 deploy 同一個 worker name**：正式版同免費版用唔同 name（`image-vector-search` vs `image-vector-search-free`），互不影響。
8. **`wrangler.free.jsonc` 已填入真實 KV id**（`e6323d1e991c4d738d094aad18675494`）；呢個 id 唔係 secret，可以留喺 repo。
9. **Vectorize 有索引延遲**：新 upsert 嘅 vector 通常要 **1–3 分鐘**先 searchable。Demo 前請預先入好貨品，唔好即場入完即刻搜。

---

## 2026-10-24 實測（免費版已上線）

- URL：https://image-vector-search-free.chunking0503.workers.dev
- Account：`Chunking0503@gmail.com's Account`（`e8a950b245b9b0f8c3b6e96c789d41ce`）
- Bindings：KV `IMAGES` + Vectorize `image-vectors-free`（256d, cosine）+ Workers AI
- Secrets：`JINA_API_KEY` 已設
- 已搬 3 件真實貨品（7 張相）：
  - `260905061439` 不銹鋼圓角小合頁（2 張，32x45）
  - `260903075019` 不銹鋼角碼（3 張，50x50x17）
  - `260903074606` 不銹鋼平介子（2 張）
- 實測結果：
  - 文字搜尋 200（名稱符合 + 向量結果）
  - 以圖搜尋 200（正確貨品 100%）
  - 重複入庫提示 200（100%）
  - Workers AI 估尺寸 200（實測 16×16 圖回 0.48 × 0.59 cm）
- 注意：Vectorize 索引延遲約 1–3 分鐘；Jina 每分鐘 100k tokens 上限（見上面第 4 點）。

---

## 方格量度（2026-11-06）

- 貨品放 **1cm × 1cm 方格紙** 上俯拍；按 **📐 量度**。
- CV 自動偵測格距 + 自動框，量 **W × D（足印）**；框可拖動／拉角修正。
- **H（高度）唔會由俯拍計**；需要人手量度（未來可加側拍模式）。
- CV 信心低（反光、格線唔清）時，可按 **🤖 AI 估算（備用）**；只會喺按掣時 call AI，平時 0 token。
- 量度邏輯喺 `assets/measure.js`，純前端，唔經 Worker／AI。

---

## 本機測試（唔使 Cloudflare account）

`src/index.js` 可以用 Node + mock bindings 測試，唔會掂生產：
- R2 模式：用有 `head` 嘅 mock
- KV 模式：用有 `getWithMetadata`、冇 `head` 嘅 mock
- Jina / Workers AI：mock `fetch` / `env.AI.run`

呢個 repo 嘅改動已經用本地 mock 測試過（唔會 deploy）。
