# Changelog

## live-translate-extension

### v0.4.0 — 2026-07-25
- 字色回復（原文淺灰、譯文白）、抬頭 bar 可拖曳、interim 動態原文加大加亮
- v0.3：字體縮小 20%、面板 50% 透明、歷史區縮為兩組字幕
- v0.2：固定位置面板、捲動歷史+捲軸、中英同字級、原文/譯文/合併存檔
- v0.1：初版——tabCapture 收音、Deepgram nova-3 逐字稿、DeepL 翻譯、浮動字幕

## meeting-scribe-extension

### v0.1.0 — 2026-07-25
- 自 live-translate-extension v0.4.0 fork
- Deepgram `language=multi` + `diarize=true`：中英夾雜、多講者切段
- 每句雙語輸出（繁中＋英文），依原文主語言只翻缺的方向
- 翻譯 provider 可切換：DeepL（預設）/ Gemini
- Speaker A/B/C chip 與講者命名視窗（依網址持久化）
- 匯出：原文 / 中文 / 英文 / Markdown 會議記錄
