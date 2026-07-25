# Meeting Scribe 會議雙語筆記

會議情境的即時逐字稿外掛：多講者分離、中英夾雜辨識、每句同時輸出繁中＋英文譯文、講者可命名、會議記錄匯出。自 `live-translate-extension` v0.4.0 fork。

## 安裝（開發模式）

1. `chrome://extensions` → 開發人員模式 → 載入未封裝項目 → 選這個資料夾
2. 點外掛圖示填入 API Key：Deepgram（必填）＋ DeepL 或 Gemini（擇一，翻譯引擎下拉選）
3. 到會議 / 影片分頁按「開始記錄這個分頁」

## 功能

- **多講者**：Deepgram `diarize=true`，自動標 Speaker A/B/C（chip 各配固定色）
- **中英夾雜**：`language=multi`（nova-3 code-switching）
- **雙語譯文**：每句輸出繁中＋英文；DeepL 模式依原文主語言只翻缺的方向省額度，Gemini 模式單次回傳雙語
- **講者命名**：面板「講者」按鈕展開名單，輸入姓名即時套用到歷史與匯出（依網址記憶）
- **匯出**：原文 / 中文 / 英文（.txt，含時間戳與講者名）＋ Markdown 會議記錄
- 沿用：可拖曳面板、捲動歷史、interim 動態原文、50% 透明

## 已知限制

- tabCapture 只收「分頁播出」的聲音＝遠端與會者；**你自己對麥克風說的話不會被記錄**（麥克風混音為未來選配功能）
- diarize 的講者編號在長時間靜音後偶爾會重排；發現接錯人時用講者命名功能校正
- Netflix 等 DRM 網站與 `chrome://` 頁面無法擷取
