// offscreen.js — Meeting Scribe English（純英文分支，自 v0.4.1 分出）
// 音訊擷取（分頁＋選用麥克風混音）→ Deepgram (language=en + diarize)
//   → 句子聚合器 → 原文先上、雙語譯文補入 → 回報字幕
// 並行分支：PCM → lamejs 即時增量 MP3 編碼（錄音存檔用，不在翻譯路徑上，不增加延遲）

let audioCtx = null;
let mediaStream = null;
let micStream = null;   // 本地麥克風（選用，與分頁聲音混音）
let ws = null;
let keepAliveTimer = null;
let cfg = null;

// ==== MP3 錄音（即時增量編碼；記憶體只留壓縮後資料 ≈ 18MB/小時） ====
const MP3_KBPS = 40;   // 單聲道語音；壓縮優先，聽得清楚即可
let mp3 = null;        // { chunks: [Uint8Array], encoder, rate }
let pcmQueue = [];
let pcmQueued = 0;

function mp3NewEncoder(rate) {
  if (typeof lamejs === 'undefined') return;  // 編碼器載入失敗時不影響字幕主流程
  if (!mp3) mp3 = { chunks: [], encoder: null, rate };
  mp3.rate = rate;
  mp3.encoder = new lamejs.Mp3Encoder(1, rate, MP3_KBPS);
}

function feedPcm(buf) {
  if (!mp3 || !mp3.encoder) return;
  const arr = new Int16Array(buf);
  pcmQueue.push(arr);
  pcmQueued += arr.length;
  if (pcmQueued >= 4608) flushPcmQueue();  // 湊滿數個 MP3 frame 再編碼，降低呼叫開銷
}

function flushPcmQueue() {
  if (!mp3 || !mp3.encoder || !pcmQueued) { pcmQueue = []; pcmQueued = 0; return; }
  const all = new Int16Array(pcmQueued);
  let o = 0;
  for (const a of pcmQueue) { all.set(a, o); o += a.length; }
  pcmQueue = []; pcmQueued = 0;
  const d = mp3.encoder.encodeBuffer(all);
  if (d.length) mp3.chunks.push(new Uint8Array(d));
}

function mp3FinishEncoder() {
  if (!mp3 || !mp3.encoder) return;
  flushPcmQueue();
  const d = mp3.encoder.flush();
  if (d.length) mp3.chunks.push(new Uint8Array(d));
  mp3.encoder = null;
}

// 「重新開始」：清掉累積的錄音；若正在擷取中則立刻以新 encoder 續錄
function audioReset() {
  pcmQueue = []; pcmQueued = 0;
  pendingSeg = null;
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!mp3) return;
  const wasEncoding = !!mp3.encoder;
  mp3.chunks = [];
  mp3.encoder = null;
  if (wasEncoding) mp3NewEncoder(mp3.rate);
}

// 「音檔」存檔：收尾目前的流 → 產生 blob URL 交給 background 下載；
// 若仍在擷取中就開新 encoder 續錄（之後再存會包含全程，MP3 流串接可正常播放）
function audioSave() {
  if (!mp3) return { ok: false, error: '尚無錄音資料' };
  mp3FinishEncoder();
  if (!mp3.chunks.length) return { ok: false, error: '尚無錄音資料' };
  const blob = new Blob(mp3.chunks, { type: 'audio/mpeg' });
  const url = URL.createObjectURL(blob);
  setTimeout(() => URL.revokeObjectURL(url), 120000);
  if (mediaStream) mp3NewEncoder(mp3.rate);
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const filename = `meeting-audio-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.mp3`;
  return { ok: true, url, filename };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'OFFSCREEN_START') start(msg.streamId, msg.settings);
  if (msg.type === 'OFFSCREEN_STOP') stop();
  if (msg.type === 'AUDIO_RESET') audioReset();
  if (msg.type === 'AUDIO_SAVE') sendResponse(audioSave());
  if (msg.type === 'AUDIO_DOWNLOAD_FALLBACK') {
    // chrome.downloads 對 blob URL 失敗時的備援：由本文件直接觸發下載
    const a = document.createElement('a');
    a.href = msg.url;
    a.download = msg.filename;
    a.click();
    sendResponse({ ok: true });
  }
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

  // 麥克風混音（把「我自己的發言」也納入辨識與錄音）
  // echoCancellation 會把喇叭放出的遠端聲音從麥克風訊號中消掉；戴耳機效果最好。
  // 授權失敗時降級為只錄分頁聲音（不中斷會議記錄）。
  micStream = null;
  if (cfg.micEnabled) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
    } catch (e) {
      reportError('無法取得麥克風，將只記錄分頁聲音（請從外掛設定重新授權）');
    }
  }

  audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(mediaStream);
  source.connect(audioCtx.destination); // 保持原音播放（僅分頁聲音；麥克風不外放，避免回授）

  await audioCtx.audioWorklet.addModule('worklet.js');
  const worklet = new AudioWorkletNode(audioCtx, 'pcm-converter');
  const mixer = audioCtx.createGain();
  source.connect(mixer);
  if (micStream) {
    const micSource = audioCtx.createMediaStreamSource(micStream);
    micSource.connect(mixer);
  }
  mixer.connect(worklet);

  // 錄音：上一段若未收尾先收，然後開新 encoder（既有 chunks 保留＝預設接續；
  // 「重新開始」由 content 端另發 AUDIO_RESET 清除）
  mp3FinishEncoder();
  mp3NewEncoder(audioCtx.sampleRate);

  connectDeepgram(audioCtx.sampleRate);

  worklet.port.onmessage = (e) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(e.data);
    feedPcm(e.data);   // 並行餵給 MP3 編碼器，不影響上行
  };
}

function connectDeepgram(sampleRate) {
  const params = new URLSearchParams({
    model: 'nova-3',
    language: 'en',               // 純英文分支：英文專用模型，準確率優於 multi
    diarize: 'true',              // 講者分離
    encoding: 'linear16',
    sample_rate: String(sampleRate),  // v0.4.0：原生取樣率（見 worklet.js 說明）
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
      // 依 speaker + 停頓切段 → 句子聚合器（合併破碎片段後定稿）
      const segments = splitBySpeaker(alt.words || [], transcript);
      for (const seg of segments) enqueueSegment(seg);
    } else {
      // interim 只送原文；同時記錄活動時間（「真閒置」偵測用）
      lastInterimAt = Date.now();
      sendCaption(null, transcript, '', '', false);
    }
  };

  ws.onerror = () => reportError('Deepgram 連線錯誤（請檢查 API key 與網路）');
  ws.onclose = () => { if (keepAliveTimer) clearInterval(keepAliveTimer); };
}

// ---- 依講者 + 停頓切段 ----
// v0.4.0：除了講者編號改變之外，同講者間隔超過 GAP_SPLIT_SEC 的長停頓也切段。
// diarization 偶爾漏掉換人時，長停頓通常就是換人點——至少讓句子分開成獨立條目，
// 也讓每段更短、講者標籤的顆粒度更細。
const GAP_SPLIT_SEC = 2.0;   // 1 秒太激進（換氣就切）；細顆粒交給聚合器

function splitBySpeaker(words, fallbackText) {
  if (!words.length) return [{ speaker: null, text: fallbackText, start: null, end: null }];
  const segments = [];
  let cur = null;
  let prevEnd = null;
  for (const w of words) {
    const spk = (typeof w.speaker === 'number') ? w.speaker : null;
    const token = w.punctuated_word || w.word || '';
    const gap = (prevEnd != null && typeof w.start === 'number') ? w.start - prevEnd : 0;
    if (!cur || cur.speaker !== spk || gap > GAP_SPLIT_SEC) {
      if (cur) segments.push(cur);
      cur = { speaker: spk, tokens: [], start: (typeof w.start === 'number') ? w.start : null, end: null };
    }
    cur.tokens.push(token);
    if (typeof w.end === 'number') { prevEnd = w.end; cur.end = w.end; }
  }
  if (cur) segments.push(cur);
  return segments.map(s => ({ speaker: s.speaker, text: joinTokens(s.tokens), start: s.start, end: s.end }));
}

// ---- 句子聚合器（自主線 v1.1–v1.3 移植）----
// 把破碎的 final 片段合併成完整句子再定稿；定稿後「原文先上、譯文補入」。
//   立即定稿：句末標點／軟定稿：≥3 秒＋停頓標點／硬定稿：≥6 秒
//   保底：講者改變／停頓 >2 秒／真閒置 0.7 秒（interim 停跳才算）／120 字
const FLUSH_IDLE_MS = 700;
const INTERIM_ACTIVE_MS = 500;   // 必須小於 FLUSH_IDLE_MS，否則第一次檢查幾乎必定重排、實際延遲翻倍
const MAX_PENDING_CHARS = 120;
// v0.5.4.1 測試版：時長上限「保留但停用」。實測 3/6 秒上限是否為斷句過碎的主因；
// 若長段落遲遲不定稿反而更糟，把 SPAN_LIMIT_ENABLED 改回 true 即可原樣恢復。
// 停用期間的保底：句末標點／講者改變／停頓 >2 秒／真閒置 0.7 秒／120 字。
const SPAN_LIMIT_ENABLED = false;
const MAX_SPAN_SEC = 6;
const SOFT_SPAN_SEC = 3;
const SENT_END = /[。．.？?！!…]["』」)）]?\s*$/;
const SOFT_END = /[，、；,;：:]\s*$/;
let pendingSeg = null;
let flushTimer = null;
let lastInterimAt = 0;
let capId = 0;
let captionChain = Promise.resolve();

function appendText(a, b) {
  if (!a) return b;
  const needSpace = /[A-Za-z0-9]$/.test(a) && /^[A-Za-z0-9]/.test(b);
  return a + (needSpace ? ' ' : '') + b;
}

function flushPendingSeg() {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!pendingSeg) return;
  const seg = pendingSeg;
  pendingSeg = null;
  const id = ++capId;
  sendCaption(seg.speaker, seg.text, '', '', true, id);   // 原文先上（零等待）
  const p = bilingual(seg.text);                           // 雙語翻譯平行發出
  captionChain = captionChain.then(async () => {           // 依序補入
    const { zh, en } = await p;
    if (zh || en) {
      chrome.runtime.sendMessage({ type: 'CAPTION_UPDATE', id, zh, en }).catch(() => {});
    }
  });
}

function enqueueSegment(seg) {
  if (!seg.text) return;
  if (pendingSeg) {
    const gap = (seg.start != null && pendingSeg.end != null) ? seg.start - pendingSeg.end : 0;
    if (pendingSeg.speaker !== seg.speaker || gap > GAP_SPLIT_SEC ||
        pendingSeg.text.length >= MAX_PENDING_CHARS) {
      flushPendingSeg();
    }
  }
  if (pendingSeg) {
    pendingSeg.text = appendText(pendingSeg.text, seg.text);
    if (seg.end != null) pendingSeg.end = seg.end;
  } else {
    pendingSeg = { speaker: seg.speaker, text: seg.text, start: seg.start, end: seg.end };
  }
  const span = (pendingSeg.start != null && pendingSeg.end != null)
    ? pendingSeg.end - pendingSeg.start : 0;
  const spanLimitHit = SPAN_LIMIT_ENABLED &&
    (span >= MAX_SPAN_SEC || (span >= SOFT_SPAN_SEC && SOFT_END.test(pendingSeg.text)));
  if (SENT_END.test(pendingSeg.text) || spanLimitHit) {
    flushPendingSeg();
  } else {
    scheduleIdleFlush();
  }
}

function scheduleIdleFlush() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (!pendingSeg) return;
    if (Date.now() - lastInterimAt < INTERIM_ACTIVE_MS) scheduleIdleFlush();
    else flushPendingSeg();
  }, FLUSH_IDLE_MS);
}

// 英文 token 之間留空格，中日韓字元之間不留
function joinTokens(tokens) {
  return tokens.join(' ')
    .replace(/([㐀-鿿豈-﫿　-〿，。、；：？！）】」』])\s+(?=[㐀-鿿豈-﫿（【「『，。、；：？！])/g, '$1')
    .trim();
}

// ---- 雙語翻譯 ----
async function bilingual(text) {
  if (cfg.provider === 'gemini') return geminiBoth(text);
  // 規則：只要句中含英文（即使中英夾雜）就翻出「完整中文」；
  //       只要句中含中文就翻出「完整英文」。
  //       只有純中文句跳過中譯、純英文句跳過英譯（省 DeepL 額度）。
  const hasCJK = /[㐀-鿿豈-﫿]/.test(text);
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
function sendCaption(speaker, transcript, zh, en, isFinal, id) {
  chrome.runtime.sendMessage({ type: 'CAPTION', speaker, transcript, zh, en, isFinal, id }).catch(() => {});
}

function reportError(error) {
  chrome.runtime.sendMessage({ type: 'CAPTURE_ERROR', error }).catch(() => {});
}

function stop() {
  if (keepAliveTimer) clearInterval(keepAliveTimer);
  flushPendingSeg();   // 聚合器中最後一句定稿送出
  if (ws) { try { ws.send(JSON.stringify({ type: 'CloseStream' })); } catch {} ws.close(); ws = null; }
  if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  if (audioCtx) { audioCtx.close(); audioCtx = null; }
  mp3FinishEncoder();  // 收尾 MP3 流；資料保留，停止後仍可按「音檔」匯出
}
