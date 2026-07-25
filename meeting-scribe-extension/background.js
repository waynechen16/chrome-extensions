// background.js — MV3 service worker (Meeting Scribe)
// 職責：popup 開始/停止 → 建 offscreen → 取 tabCapture streamId → 轉發字幕給 content script

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
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab) return sendResponse({ ok: false, error: '找不到目前分頁' });
        if (/^(chrome|edge|about|chrome-extension):/.test(tab.url || '')) {
          return sendResponse({ ok: false, error: '此頁面無法擷取（瀏覽器內部頁面）' });
        }
        capturedTabId = tab.id;
        await injectContentScript(tab.id);
        await ensureOffscreen();
        const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
        const s = await chrome.storage.local.get([
          'deepgramKey', 'deeplKey', 'geminiKey', 'provider'
        ]);
        chrome.runtime.sendMessage({
          type: 'OFFSCREEN_START',
          streamId,
          settings: {
            deepgramKey: s.deepgramKey || '',
            deeplKey: s.deeplKey || '',
            geminiKey: s.geminiKey || '',
            provider: s.provider || 'deepl'
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
        // 來自 offscreen：{ speaker, transcript, zh, en, isFinal }
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
      case 'SHOW_PANEL': {
        // popup 要求重新顯示字幕面板：優先用擷取中的分頁，否則用目前分頁
        let tabId = capturedTabId;
        if (tabId == null) {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          tabId = tab?.id ?? null;
        }
        if (tabId == null) return sendResponse({ ok: false, error: '找不到分頁' });
        await injectContentScript(tabId);
        chrome.tabs.sendMessage(tabId, { type: 'SHOW_PANEL' }).catch(() => {});
        sendResponse({ ok: true });
        break;
      }
      case 'GET_STATUS': {
        sendResponse({ capturing: capturedTabId != null, tabId: capturedTabId });
        break;
      }
    }
  })();
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === capturedTabId) {
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' }).catch(() => {});
    capturedTabId = null;
  }
});
