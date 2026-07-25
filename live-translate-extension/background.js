// background.js — MV3 service worker
// 職責：1) 回應 popup 的開始/停止 2) 建立 offscreen document 3) 取得 tabCapture streamId
//       4) 把 offscreen 產生的字幕轉發給被擷取分頁的 content script

let capturedTabId = null;

async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument();
  if (existing) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: '在背景擷取分頁聲音並串流至語音辨識服務'
  });
}

async function injectContentScript(tabId) {
  // 動態注入，避免對所有網站常駐 content script
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (e) {
    console.warn('inject failed (可能已注入):', e.message);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'START_CAPTURE': {
        // 必須由使用者手勢（popup 按鈕）觸發
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) return sendResponse({ ok: false, error: '找不到目前分頁' });
        if (/^(chrome|edge|about|chrome-extension):/.test(tab.url || '')) {
          return sendResponse({ ok: false, error: '此頁面無法擷取（瀏覽器內部頁面）' });
        }
        capturedTabId = tab.id;
        await injectContentScript(tab.id);
        await ensureOffscreen();
        const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
        const settings = await chrome.storage.local.get([
          'deepgramKey', 'deeplKey', 'sourceLang', 'targetLang'
        ]);
        chrome.runtime.sendMessage({
          type: 'OFFSCREEN_START',
          streamId,
          settings: {
            deepgramKey: settings.deepgramKey || '',
            deeplKey: settings.deeplKey || '',
            sourceLang: settings.sourceLang || 'en',
            targetLang: settings.targetLang || 'ZH-HANT'
          }
        });
        sendResponse({ ok: true });
        break;
      }
      case 'STOP_CAPTURE': {
        chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' });
        if (capturedTabId != null) {
          chrome.tabs.sendMessage(capturedTabId, { type: 'CAPTION_END' }).catch(() => {});
        }
        capturedTabId = null;
        sendResponse({ ok: true });
        break;
      }
      case 'CAPTION': {
        // 來自 offscreen：{ transcript, translation, isFinal }
        if (capturedTabId != null) {
          chrome.tabs.sendMessage(capturedTabId, msg).catch(() => {});
        }
        break;
      }
      case 'CAPTURE_ERROR': {
        if (capturedTabId != null) {
          chrome.tabs.sendMessage(capturedTabId, msg).catch(() => {});
        }
        break;
      }
      case 'GET_STATUS': {
        sendResponse({ capturing: capturedTabId != null, tabId: capturedTabId });
        break;
      }
    }
  })();
  return true; // 保留 sendResponse 的非同步通道
});

// 分頁關閉時自動停止
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === capturedTabId) {
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' }).catch(() => {});
    capturedTabId = null;
  }
});
