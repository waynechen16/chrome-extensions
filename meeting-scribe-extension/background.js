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

// 確保 content script 活著。先 PING：有回應就不動它（保留記錄）；
// 沒回應（從未注入，或外掛重載後舊 script 的 context 已失效、只剩殘留旗標）
// 就設定強制接管旗標後重新注入。
async function ensureContentScript(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    if (r?.ok) return true;
  } catch (e) { /* 無接收者 → 需要注入 */ }
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => { window.__msForceReinject = true; }
    });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return true;
  } catch (e) {
    console.warn('inject failed:', e.message);
    return false;
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
        await ensureContentScript(tab.id);
        // 通知 content script 新的記錄 session 開始（處理講者名重置/接續詢問）
        await chrome.tabs.sendMessage(tab.id, { type: 'SESSION_START' }).catch(() => {});
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
          if (tab && /^(chrome|edge|about|chrome-extension):/.test(tab.url || '')) {
            return sendResponse({ ok: false, error: '此頁面無法顯示面板（瀏覽器內部頁面）' });
          }
          tabId = tab?.id ?? null;
        }
        if (tabId == null) return sendResponse({ ok: false, error: '找不到分頁' });
        const ok = await ensureContentScript(tabId);
        if (!ok) return sendResponse({ ok: false, error: '無法載入面板，請重新整理網頁後再試' });
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
