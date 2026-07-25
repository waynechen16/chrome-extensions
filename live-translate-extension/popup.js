// popup.js — 開始/停止 + 設定儲存
const $ = (id) => document.getElementById(id);
const toggle = $('toggle');
const status = $('status');
let capturing = false;

const FIELDS = ['deepgramKey', 'deeplKey', 'sourceLang', 'targetLang'];

async function init() {
  const saved = await chrome.storage.local.get(FIELDS);
  for (const f of FIELDS) if (saved[f]) $(f).value = saved[f];
  const s = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
  setCapturing(s?.capturing || false);
}

function setCapturing(on) {
  capturing = on;
  toggle.textContent = on ? '■ 停止翻譯' : '▶ 開始翻譯這個分頁';
  toggle.className = on ? 'stop' : 'start';
}

async function saveSettings() {
  const data = {};
  for (const f of FIELDS) data[f] = $(f).value.trim();
  await chrome.storage.local.set(data);
}

for (const f of FIELDS) $(f).addEventListener('change', saveSettings);

toggle.addEventListener('click', async () => {
  await saveSettings();
  if (!capturing) {
    const { deepgramKey } = await chrome.storage.local.get('deepgramKey');
    if (!deepgramKey) { status.textContent = '請先填入 Deepgram API Key'; return; }
    const res = await chrome.runtime.sendMessage({ type: 'START_CAPTURE' });
    if (res?.ok) { setCapturing(true); status.textContent = '擷取中…字幕會出現在網頁上'; }
    else { status.textContent = res?.error || '啟動失敗'; }
  } else {
    await chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' });
    setCapturing(false);
    status.textContent = '已停止';
  }
});

init();
