# Live Translate Captions（直播即時翻譯字幕外掛）

擷取分頁聲音 → Deepgram 即時逐字稿 → DeepL 翻譯 → 網頁上可拖曳的浮動字幕。

## 安裝（開發模式）

1. 打開 Chrome，網址列輸入 `chrome://extensions`
2. 右上角打開「開發人員模式」
3. 點「載入未封裝項目」，選這個資料夾
4. 點外掛圖示 → 填入 Deepgram / DeepL 的 API Key → 到 YouTube 或 Twitch 分頁按「開始翻譯這個分頁」

## 需要的帳號

- Deepgram：https://console.deepgram.com 註冊，新帳號有 $200 免費額度，建 API Key
- DeepL API：https://www.deepl.com/pro-api 註冊「API Free」方案（Key 結尾為 `:fx`）

## 檔案結構

| 檔案 | 職責 |
|---|---|
| `manifest.json` | MV3 設定、權限宣告 |
| `background.js` | Service worker：取得 tabCapture streamId、建立 offscreen、轉發字幕 |
| `offscreen.html/js` | 實際抓音訊的地方：getUserMedia、保持原音播放、降採樣、Deepgram WS、DeepL 翻譯 |
| `worklet.js` | AudioWorklet：float32 48kHz → int16 16kHz |
| `content.js/css` | 網頁上的字幕面板（固定底部置中、可捲動歷史、原文/譯文/合併存檔） |
| `popup.html/js` | 開始/停止 + API Key 與語言設定 |

## 已知限制

- Netflix 等 DRM 網站擋 tabCapture；YouTube、Twitch 正常
- `chrome://` 等瀏覽器內部頁面無法擷取
- 只翻譯 final 逐字稿（省 DeepL 額度）；interim 只顯示原文（灰色斜體）
- API Key 存在 `chrome.storage.local`，僅供個人使用；若要上架商店應改走自建後端代理
