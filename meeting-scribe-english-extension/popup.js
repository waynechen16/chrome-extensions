// popup.js — Meeting Scribe
const $ = (id) => document.getElementById(id);
const toggle = $('toggle');
const status = $('status');
let capturing = false;

const FIELDS = ['deepgramKey', 'deeplKey', 'geminiKey', 'provider'];

async function init() {
  const saved = await chrome.storage.local.get([...FIELDS, 'micEnabled']);
  for (const f of FIELDS) if (saved[f]) $(f).value = saved[f];
  $('micEnabled').checked = !!saved.micEnabled;
  const s = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
  setCapturing(s?.capturing || false);
}

function setCapturing(on) {
  capturing = on;
  toggle.textContent = on ? '■ 停止記錄' : '▶ 開始記錄這個分頁';
  toggle.className = on ? 'stop' : 'start';
}

async function saveSettings() {
  const data = {};
  for (const f of FIELDS) data[f] = $(f).value.trim();
  data.micEnabled = $('micEnabled').checked;
  await chrome.storage.local.set(data);
}

for (const f of FIELDS) $(f).addEventListener('change', saveSettings);

// 麥克風開關：勾選時若尚未授權，開授權分頁完成一次授權
$('micEnabled').addEventListener('change', async () => {
  await saveSettings();
  if (!$('micEnabled').checked) return;
  let state = 'prompt';
  try { state = (await navigator.permissions.query({ name: 'microphone' })).state; } catch {}
  if (state !== 'granted') {
    chrome.tabs.create({ url: chrome.runtime.getURL('mic-permission.html') });
    status.textContent = '請在新分頁完成麥克風授權後再開始記錄';
  } else if (capturing) {
    status.textContent = '麥克風設定將在下次開始記錄時生效';
  }
});

toggle.addEventListener('click', async () => {
  await saveSettings();
  if (!capturing) {
    const s = await chrome.storage.local.get(FIELDS);
    if (!s.deepgramKey) { status.textContent = '請先填入 Deepgram API Key'; return; }
    if (s.provider === 'gemini' && !s.geminiKey) { status.textContent = '選用 Gemini 需填 Gemini API Key'; return; }
    if ((s.provider || 'deepl') === 'deepl' && !s.deeplKey) { status.textContent = '選用 DeepL 需填 DeepL API Key'; return; }
    const res = await chrome.runtime.sendMessage({ type: 'START_CAPTURE' });
    if (res?.ok) { setCapturing(true); status.textContent = '記錄中…字幕會出現在網頁上'; }
    else { status.textContent = res?.error || '啟動失敗'; }
  } else {
    await chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' });
    setCapturing(false);
    status.textContent = '已停止';
  }
});

$('showPanel').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'SHOW_PANEL' });
  status.textContent = res?.ok ? '已顯示字幕面板' : (res?.error || '無法顯示面板');
});

init();
