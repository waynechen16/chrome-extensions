// worklet.js — AudioWorkletProcessor
// 把瀏覽器的 float32 音訊（通常 48kHz）降採樣成 16kHz 16-bit PCM，丟回主執行緒

class PCMDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this._buf = [];
    this._ratio = sampleRate / this.targetRate; // sampleRate 是 worklet 全域變數
    this._pos = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    // 若雙聲道，混成單聲道
    const ch0 = input[0];
    const ch1 = input[1];
    const mono = new Float32Array(ch0.length);
    for (let i = 0; i < ch0.length; i++) {
      mono[i] = ch1 ? (ch0[i] + ch1[i]) / 2 : ch0[i];
    }
    // 簡單線性插值降採樣
    const out = [];
    while (this._pos < mono.length) {
      const idx = Math.floor(this._pos);
      const frac = this._pos - idx;
      const next = idx + 1 < mono.length ? mono[idx + 1] : mono[idx];
      const sample = mono[idx] * (1 - frac) + next * frac;
      const s = Math.max(-1, Math.min(1, sample));
      out.push(s < 0 ? s * 0x8000 : s * 0x7fff);
      this._pos += this._ratio;
    }
    this._pos -= mono.length;
    if (out.length) {
      const pcm = new Int16Array(out);
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
    return true;
  }
}

registerProcessor('pcm-downsampler', PCMDownsampler);
