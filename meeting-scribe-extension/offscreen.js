// offscreen.js — Meeting Scribe
// 音訊擷取 → Deepgram (language=multi + diarize) → 依講者切段 → 雙語翻譯 → 回報字幕

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
  if (!cfg.deepgramKey) return reportError('尚未設定 Deepgram API key');
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
      video: false
    });
  } catch (e) {
    return reportError('無法擷取分頁聲音：' + e.message);
  }

  audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(mediaStream);
  source.connect(audioCtx.destination); // 保持原音播放

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
    language: 'multi',            // 中英夾雜 code-switching
    diarize: 'true',              // 講者分離
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    punctuate: 'true',
    interim_results: 'true',
    smart_format: 'true',
    endpointing: '300'
  });
  ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, ['token', cfg.deepgramKey]);

  ws.onopen = () => {
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
      // 依 speaker 把 words 切段
      const segments = splitBySpeaker(alt.words || [], transcript);
      for (const seg of segments) {
        const { zh, en } = await bilingual(seg.text);
        sendCaption(seg.speaker, seg.text, zh, en, true);
      }
    } else {
      // interim：依講者切段後只顯示「最後一段」＝目前正在說話的人。
      // 換人時最新的字都掛在新講者身上，標籤立即切換；純本地運算，不增加延遲。
      const words = alt.words || [];
      if (words.length) {
        const segs = splitBySpeaker(words, transcript);
        const last = segs[segs.length - 1];
        sendCaption(last.speaker, last.text, '', '', false);
      } else {
        sendCaption(null, transcript, '', '', false);
      }
    }
  };

  ws.onerror = () => reportError('Deepgram 連線錯誤（請檢查 API key 與網路）');
  ws.onclose = () => { if (keepAliveTimer) clearInterval(keepAliveTimer); };
}

// ---- 依講者切段 ----
function splitBySpeaker(words, fallbackText) {
  if (!words.length) return [{ speaker: null, text: fallbackText }];
  const segments = [];
  let cur = null;
  for (const w of words) {
    const spk = (typeof w.speaker === 'number') ? w.speaker : null;
    const token = w.punctuated_word || w.word || '';
    if (!cur || cur.speaker !== spk) {
      if (cur) segments.push(cur);
      cur = { speaker: spk, tokens: [] };
    }
    cur.tokens.push(token);
  }
  if (cur) segments.push(cur);
  return segments.map(s => ({ speaker: s.speaker, text: joinTokens(s.tokens) }));
}

// 英文 token 之間留空格，中日韓字元之間不留
function joinTokens(tokens) {
  return tokens.join(' ')
    .replace(/([㐀-鿿豈-﫿　-〿，。、；：？！）】」』])\s+(?=[㐀-鿿豈-﫿（【「『，。、；：？！])/g, '$1')
    .trim();
}

// ---- 雙語翻譯 ----
async function bilingual(text) {
  if (cfg.provider === 'gemini') return geminiBoth(text);
  // 規則：只要句中含英文（即使中英夾雜）就翻出「完整中文」；
  //       只要句中含中文就翻出「完整英文」。
  //       只有純中文句跳過中譯、純英文句跳過英譯（省 DeepL 額度）。
  const hasCJK = /[\u3400-\u9fff\uf900-\ufaff]/.test(text);
  const hasLatin = /[A-Za-z]/.test(text);
  const needZh = !(hasCJK && !hasLatin);   // 非純中文 → 需要中譯
  const needEn = !(hasLatin && !hasCJK);   // 非純英文 → 需要英譯
  const [zh, en] = await Promise.all([
    needZh ? deepl(text, 'ZH-HANT') : Promise.resolve(text),
    needEn ? deepl(text, 'EN-US') : Promise.resolve(text)
  ]);
  return { zh, en };
}

async function deepl(text, target) {
  if (!cfg.deeplKey) return '(未設定 DeepL key)';
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
      body: JSON.stringify({ text: [text], target_lang: target })
    });
    if (!res.ok) return `(翻譯失敗 ${res.status})`;
    const data = await res.json();
    return data.translations?.[0]?.text || '';
  } catch {
    return '(翻譯連線失敗)';
  }
}

async function geminiBoth(text) {
  if (!cfg.geminiKey) return { zh: '(未設定 Gemini key)', en: '(未設定 Gemini key)' };
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=' + cfg.geminiKey;
  const prompt =
    'You are a meeting interpreter. The utterance below may be Chinese, English, or mixed. ' +
    'Return ONLY JSON: {"zh":"Traditional Chinese version","en":"English version"}. ' +
    'If the utterance mixes languages, FULLY convert it into each target language — ' +
    '"zh" must be pure Traditional Chinese with no English words left (except proper nouns/acronyms), ' +
    'and "en" must be pure English. ' +
    'If the utterance is already entirely in one target language, copy it as-is for that language.\n\nUtterance: ' + text;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.1 }
      })
    });
    if (!res.ok) return { zh: `(翻譯失敗 ${res.status})`, en: `(翻譯失敗 ${res.status})` };
    const data = await res.json();
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    const parsed = JSON.parse(raw);
    return { zh: parsed.zh || '', en: parsed.en || '' };
  } catch {
    return { zh: '(翻譯連線失敗)', en: '(翻譯連線失敗)' };
  }
}

// ---- 回報 ----
function sendCaption(speaker, transcript, zh, en, isFinal) {
  chrome.runtime.sendMessage({ type: 'CAPTION', speaker, transcript, zh, en, isFinal }).catch(() => {});
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
