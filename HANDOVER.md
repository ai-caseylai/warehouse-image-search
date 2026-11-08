# Warehouse Image Search — 開發交接（Ken）

> 呢份文件可以入 repo；**唔包含任何帳號密碼／API key**。  
> 敏感 access 由 Casey 另外用私人文件／密碼管理器交畀你。

## 1. 專案係咩

倉庫／五金店貨品拍照搜尋 WebApp：

- 拍照自動產生 12 位碼
- 以圖搜碼、文字搜碼、掃 12 位條碼
- 重複入庫提示
- 1cm 方格量度 W × D（足印；CV，可拖框）
- AI 估算尺寸（fallback，僅參考）
- 同款多尺寸批量建碼
- 軟刪除

## 2. 環境

| | 免費 Demo | 舊 Production |
|---|---|---|
| URL | https://image-vector-search-free.chunking0503.workers.dev | https://image-vector-search.ai-caseylai.workers.dev |
| Cloudflare account | Casey 嘅新 account（私人文件有 ID） | 老細 account `Ai.caseylai` |
| Worker | `image-vector-search-free` | `image-vector-search` |
| 圖片儲存 | KV（`IMAGES`） | R2（`image-vectors`） |
| 向量 | Vectorize `image-vectors-free`（256d, cosine） | Vectorize `image-vectors`（768d） |
| Embedding | Jina CLIP v2 | DashScope `tongyi-embedding-vision-flash` |
| 尺寸 AI | Workers AI `@cf/llava-hf/llava-1.5-7b-hf` | DashScope `qwen-vl-max` |
| Config | `wrangler.free.jsonc` | `wrangler.jsonc` |
| 狀態 | 最新 code（commit `2d18207`） | **舊版（SW v25）未 deploy 最新 code** |

⚠️ 舊 production 唔好用嚟試新功能；新功能只喺免費 Demo。

## 3. Repo

- GitHub：https://github.com/ai-caseylai/warehouse-image-search（public）
- Branch：`main`
- 最新 commit：`167843f`（可見裁剪框 + Canvas 真正前端裁切）
- 相關 commits：
  - `cd5318e` 動態網格 homography
  - `1e5b905` 以圖搜碼結果顯示相片
  - `46e2af3` 免費模式 KV/Jina/Workers AI + 方格量度
- Working tree：clean

## 4. 架構

```
手機 PWA (assets/index.html + measure.js)
        │
Cloudflare Worker (src/index.js)
   ├── static assets
   ├── KV (free) / R2 (production) 圖片
   ├── Vectorize 向量搜尋
   ├── Jina CLIP v2 (free) / DashScope (production) embedding
   ├── Workers AI (free) / DashScope qwen-vl-max (production) 尺寸估算
   └── /photos /search /codes /files /estimate-size
```

### 主要檔案

| 檔案 | 作用 |
|---|---|
| `src/index.js` | 成個 Worker；R2/KV、DashScope/Jina、Workers AI 自動切換 |
| `assets/index.html` | PWA UI；量度 dialog、上傳壓縮、搜尋 |
| `assets/measure.js` | 前端 CV：格線交點 + local homography + 物件框 + W×D |
| `wrangler.jsonc` | 正式版（R2 + 768d Vectorize + DashScope） |
| `wrangler.free.jsonc` | 免費版（KV + 256d Vectorize + Jina + Workers AI） |
| `FREE-DEMO.md` | 免費版建立／限制 |
| `scripts/setup-free.mjs` | 免費版一鍵 setup（KV／Vectorize／secret／deploy） |

## 5. 已完成／實測

- 免費 Demo 上線；3 件真實貨品（7 張相）已搬
- 文字搜尋、以圖搜尋、重複提示、Workers AI 估尺寸：實測 200
- UI E2E（Playwright + 假鏡頭）：16/16
- 方格量度：
  - 動態格線交點 + 局部 homography（物件附近 ±3.5 格）
  - 格點自檢：RMS px、格邊誤差 %
  - 嚴重校正失敗（X/Y 差 >1.6 或無物件／比例）→ 清空 W/D，要求重拍或手動校準；其他誤差顯示數值＋警告
  - **手動 1cm 校準**：格紙太波浪／自動偵測失敗時，按「📏 校準 1cm」點兩條相鄰格線，唔需要鋼尺
  - 長條物件（螺絲/pin）唔會合併附近陰影／紙邊
  - 只量 **W × D（足印）**；H 未做
- 相機：
  - 預覽有可見裁剪框（12px inset）
  - 按下快門時用 Canvas **真正裁切**框內內容 → JPEG Blob → FormData 上傳
  - Preview / 後端分析相片範圍一致（WYSIWYG）
- AI 尺寸 fallback：
  - Prompt 要求忽略手指／手部／背景；格紙唔清回 0
  - UI 合理性檢查：<1cm、>50cm、confidence low、note 含手指／看不到 → 拒絕，唔覆蓋 CV
- 樣本結果：
  - 5cm × 1.5cm pin：**1.71 × 4.94 cm**（長度準；闊度包埋法蘭）
  - 長條 bolt：**6.04 × 1.92 cm**（未再包陰影）
  - 其他樣本見 commit 訊息／測試紀錄

## 6. 已知限制（唔好當 production）

1. **無鑑權**：任何人拿到 URL 可上傳／刪除／燒 AI quota。
2. `/files/*` 可讀／硬刪除任意 key（包括 `codes/*.json`）。
3. SVG 上傳可造成同源 XSS。
4. 併發開新碼會撞碼／覆蓋（未修）。
5. 反光金屬自動框仍可能漏邊；需人手拉角或用 SAM。
6. **免費版 AI 尺寸估算不可靠**：Workers AI LLaVA 會亂估（例如見到手指回 0.5×0.5）；現在會被 UI 拒絕，但唔應該當佢係量度工具。要準 → CV + 手動 1cm 校準；AI 只做建議。
7. 新 vector 索引延遲 1–3 分鐘；即場入貨唔會即刻搜到。
8. Jina 免費 key 100k tokens/min；連續上傳會 429。
9. 舊 production 未 deploy 最新 code。
10. 冇還原 UI、冇 audit log、冇 rate limit、冇角色權限。
11. H（高度）未量；只量 W × D。

## 7. 本機開發

- Node 22；wrangler（Casey 部機用 e-plus repo 內嘅 wrangler，Ken 自己 `npm i -D wrangler` 亦可）
- Clone：
  ```bash
  git clone https://github.com/ai-caseylai/warehouse-image-search
  cd warehouse-image-search
  ```
- 免費版 deploy：
  ```bash
  npx wrangler deploy --config wrangler.free.jsonc
  ```
- 設定 secret（自己嘅 Jina key）：
  ```bash
  npx wrangler secret put JINA_API_KEY --config wrangler.free.jsonc
  ```
- 正式版 deploy（**要老細批准**）：
  ```bash
  npx wrangler deploy
  ```
- 免費版資源建立：見 `FREE-DEMO.md` 或 `scripts/setup-free.mjs`。

## 8. 測試

- 本地 API mock（R2 + DashScope）：23/23
- 免費模式 mock（KV + Jina + Workers AI）：14/14
- UI E2E（Playwright + 假鏡頭）：16/16
- CV 樣本：1–5.jpg；結果見上面
- 測試 harness 目前喺 Casey 部機嘅 temp 目錄；如要入 repo，我可以另外整理 `tests/`。
- 唔好喺正式 production 做破壞性測試；用 mock 或免費 Demo。

## 9. 下一步 roadmap（建議次序）

1. **SAM / instance segmentation**（低信心 fallback）改善反光金屬框
2. **H 高度**：側拍或人手輸入
3. **還原 UI**（軟刪除 undo）
4. **鑑權 / 角色**（admin/staff/viewer）
5. **Audit log**
6. **Rate limit + CORS 白名單**
7. **`/files` key 白名單 + MIME 白名單（擋 SVG）**
8. **併發配碼**（原子 claim / 隨機 suffix）
9. **正式 production deploy**（要老細批准）
10. **監控／成本 dashboard**

## 10. 工作流程

- 新功能開 branch → PR → 測試 → merge。
- 唔好直接 push `main`（除非 Casey／老細同意）。
- 唔好將 token／key 放入 repo；用 `wrangler secret`。
- Deploy production 前一定要：
  - `git fetch` + 確認包含 `origin/main`
  - 確認 deploy 嘅 account／worker 正確
  - 通知 Casey／老細
- 免費 Demo 可以自由 deploy；production 要批准。

## 11. 你（Ken）需要嘅 access

由 Casey 用私人文件／密碼管理器提供，**唔好喺 chat 貼**：

| Access | 用途 | 點樣分享 |
|---|---|---|
| GitHub repo write | push branch／PR | GitHub → Settings → Collaborators → Add people |
| Cloudflare 免費 account member 或 scoped token | deploy 免費 Demo、KV／Vectorize／Workers AI | Manage Account → Members invite；或 API token（Workers Scripts:Edit、KV:Edit、Vectorize:Edit，設 expiry） |
| Jina API key（新 key） | 圖片／文字 embedding | Jina dashboard 開新 key；用 1Password／Bitwarden 分享 |
| Production Cloudflare account（如需要） | deploy 正式版 | 老細 invite；唔好共用 master token |
| DashScope API key（如需要） | production qwen-vl-max | 老細提供；唔好入 repo |

## 12. 交接 meeting agenda

1. 15 分鐘：demo 免費 URL（拍照、搜尋、量度）
2. 15 分鐘：repo 結構 + 兩個 wrangler config
3. 15 分鐘：本地 setup + deploy 免費版
4. 15 分鐘：測試（mock/UI/CV）
5. 15 分鐘：已知限制 + roadmap + 權限界線
6. 最後：Ken 自己 clone、deploy 一次免費版、跑一次 UI test
