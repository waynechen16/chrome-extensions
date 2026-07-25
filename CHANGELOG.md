# Changelog

## live-translate-extension

### v0.4.0 — 2026-07-25
- 字色回復（原文淺灰、譯文白）、抬頭 bar 可拖曳、interim 動態原文加大加亮
- v0.3：字體縮小 20%、面板 50% 透明、歷史區縮為兩組字幕
- v0.2：固定位置面板、捲動歷史+捲軸、中英同字級、原文/譯文/合併存檔
- v0.1：初版——tabCapture 收音、Deepgram nova-3 逐字稿、DeepL 翻譯、浮動字幕

## meeting-scribe-extension

### v0.2.1 — 2026-07-25
- 修正「重新顯示字幕面板」按鈕無作用：外掛更新/重載後，舊 content script 的 context 已失效但注入旗標殘留，導致重新注入被跳過。改為 background 先 PING 確認 script 存活，沒回應才設強制接管旗標重新注入；並在 popup 顯示明確錯誤（如瀏覽器內部頁面、需重新整理網頁）

### v0.2.0 — 2026-07-25
- 講者標籤更即時：interim 依講者切段、只顯示最新講者的段落，換人時標籤立刻切換（純本地運算，不增加翻譯延遲）
- 中英夾雜句必出完整譯文：句中含英文即翻完整中文、含中文即翻完整英文；只有純中文/純英文句才跳過該方向（省額度）；Gemini prompt 同步要求不留混雜輸出
- 面板 ✕ 改為「隱藏」不再移除；popup 新增「重新顯示字幕面板」按鈕；重開且已有記錄時面板內詢問「接續記錄 / 重新開始」
- 譯文與原文相同時不重複顯示（修正純英文句 EN 行重複）；匯出檔案仍含完整三欄位

### v0.1.0 — 2026-07-25
- 自 live-translate-extension v0.4.0 fork
- Deepgram `language=multi` + `diarize=true`：中英夾雜、多講者切段
- 每句雙語輸出（繁中＋英文），依原文主語言只翻缺的方向
- 翻譯 provider 可切換：DeepL（預設）/ Gemini
- Speaker A/B/C chip 與講者命名視窗（依網址持久化）
- 匯出：原文 / 中文 / 英文 / Markdown 會議記錄
