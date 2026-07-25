// offscreen.js — 在 offscreen document 中執行
// 職責：1) 用 streamId 取得分頁音訊 2) 保持原音播放 3) 降採樣成 16k PCM
//       4) WebSocket 串流到 Deepgram 5) final 逐字稿丟 DeepL 翻譯 6) 回報字幕

let audioCtx = null;
let mediaStream = null;
let ws = null;
let keepAliveTimer = null;
let cfg = null;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'OFFSCREEN_START') start(msg.streamId, msg.settings);
  if (msg.type === 'OFFSCREEN_STOP') stop();
});

async function start(streamId, settings) {
  cfg = settings;
  if (!cfg.deepgramKey) return reportError('尚未設定 Deepgram API key（點外掛圖示 → 設定）');
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId }
      },
      video: false
    });
  } catch (e) {
    return reportError('無法擷取分頁聲音：' + e.message);
  }

  // 關鍵：接回喇叭，否則使用者會聽不到原本的聲音
  audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(mediaStream);
  source.connect(audioCtx.destination);

  // AudioWorklet 降採樣 → PCM16 @16kHz
  await audioCtx.audioWorklet.addModule('worklet.js');
  const worklet = new AudioWorkletNode(audioCtx, 'pcm-downsampler');
  source.connect(worklet);

  connectDeepgram();

  worklet.port.onmessage = (e) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(e.data);
  };
}

function connectDeepgram() {
  const params = new URLSearchParams({
    model: 'nova-3',
    language: cfg.sourceLang,          // 例如 'en'；多語言可改 'multi'
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    punctuate: 'true',
    interim_results: 'true',
    smart_format: 'true',
    endpointing: '300'
  });
  // 瀏覽器 WebSocket 不能自訂 header，Deepgram 支援用子協定帶 token
  ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, ['token', cfg.deepgramKey]);

  ws.onopen = () => {
    // 每 8 秒送 KeepAlive，避免無聲時被斷線
    keepAliveTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'KeepAlive' }));
      }
    }, 8000);
  };

  ws.onmessage = async (event) => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (data.type !== 'Results') return;
    const alt = data.channel?.alternatives?.[0];
    const transcript = alt?.transcript?.trim();
    if (!transcript) return;

    if (data.is_final) {
      // 只翻譯 final 結果，節省 DeepL 字元額度
      const translation = await translate(transcript);
      sendCaption(transcript, translation, true);
    } else {
      sendCaption(transcript, '', false);
    }
  };

  ws.onerror = () => reportError('Deepgram 連線錯誤（請檢查 API key 與網路）');
  ws.onclose = () => { if (keepAliveTimer) clearInterval(keepAliveTimer); };
}

async function translate(text) {
  if (!cfg.deeplKey) return '(未設定 DeepL key)';
  // Free key 以 ":fx" 結尾 → 用 api-free 網域
  const endpoint = cfg.deeplKey.endsWith(':fx')
    ? 'https://api-free.deepl.com/v2/translate'
    : 'https://api.deepl.com/v2/translate';
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `DeepL-Auth-Key ${cfg.deeplKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text: [text], target_lang: cfg.targetLang })
    });
    if (!res.ok) return `(翻譯失敗 ${res.status})`;
    const data = await res.json();
    return data.translations?.[0]?.text || '';
  } catch (e) {
    return '(翻譯連線失敗)';
  }
}

function sendCaption(transcript, translation, isFinal) {
  chrome.runtime.sendMessage({ type: 'CAPTION', transcript, translation, isFinal }).catch(() => {});
}

function reportError(error) {
  chrome.runtime.sendMessage({ type: 'CAPTURE_ERROR', error }).catch(() => {});
}

function stop() {
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  if (ws) { try { ws.send(JSON.stringify({ type: 'CloseStream' })); } catch {} ws.close(); ws = null; }
  if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
  if (audioCtx) { audioCtx.close(); audioCtx = null; }
}
