// content.js — 固定位置字幕面板：雙行原文/譯文、可捲動歷史、字幕存檔
(() => {
  if (window.__ltcInjected) return;
  window.__ltcInjected = true;

  const box = document.createElement('div');
  box.id = 'ltc-caption-box';
  box.innerHTML = `
    <div id="ltc-header">
      <span id="ltc-title">即時翻譯字幕</span>
      <span id="ltc-buttons">
        <button class="ltc-btn" id="ltc-save-en" title="下載原文逐字稿">存原文</button>
        <button class="ltc-btn" id="ltc-save-zh" title="下載譯文">存譯文</button>
        <button class="ltc-btn" id="ltc-save-both" title="下載原文+譯文對照">存合併</button>
        <button class="ltc-btn" id="ltc-close" title="關閉">✕</button>
      </span>
    </div>
    <div id="ltc-history"></div>
    <div id="ltc-interim"></div>
  `;
  document.documentElement.appendChild(box);

  const historyEl = box.querySelector('#ltc-history');
  const interimEl = box.querySelector('#ltc-interim');
  const headerEl = box.querySelector('#ltc-header');
  box.querySelector('#ltc-close').addEventListener('click', () => box.remove());

  // ---- 拖曳（抓住抬頭 bar 移動；按鈕不觸發拖曳）----
  let dragging = false, offX = 0, offY = 0;
  headerEl.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.ltc-btn')) return;
    dragging = true;
    const r = box.getBoundingClientRect();
    offX = e.clientX - r.left;
    offY = e.clientY - r.top;
    headerEl.setPointerCapture(e.pointerId);
  });
  headerEl.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    box.style.left = `${e.clientX - offX}px`;
    box.style.top = `${e.clientY - offY}px`;
    box.style.bottom = 'auto';
    box.style.transform = 'none';
  });
  headerEl.addEventListener('pointerup', () => { dragging = false; });
  headerEl.addEventListener('pointercancel', () => { dragging = false; });

  // 完整字幕紀錄（存檔用）：{ time, en, zh }
  const records = [];

  function timestamp(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  function nearBottom() {
    return historyEl.scrollHeight - historyEl.scrollTop - historyEl.clientHeight < 48;
  }

  function addEntry(en, zh) {
    const now = new Date();
    records.push({ time: timestamp(now), en, zh });
    const stick = nearBottom();
    const entry = document.createElement('div');
    entry.className = 'ltc-entry';
    const enDiv = document.createElement('div');
    enDiv.className = 'ltc-en';
    enDiv.textContent = en;
    const zhDiv = document.createElement('div');
    zhDiv.className = 'ltc-zh';
    zhDiv.textContent = zh;
    entry.append(enDiv, zhDiv);
    historyEl.appendChild(entry);
    if (stick) historyEl.scrollTop = historyEl.scrollHeight;
  }

  // ---- 存檔 ----
  function download(filename, text) {
    const blob = new Blob(['﻿' + text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  function fileStamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  }

  box.querySelector('#ltc-save-en').addEventListener('click', () => {
    download(`captions-original-${fileStamp()}.txt`,
      records.map(r => `[${r.time}] ${r.en}`).join('\n'));
  });
  box.querySelector('#ltc-save-zh').addEventListener('click', () => {
    download(`captions-translated-${fileStamp()}.txt`,
      records.map(r => `[${r.time}] ${r.zh}`).join('\n'));
  });
  box.querySelector('#ltc-save-both').addEventListener('click', () => {
    download(`captions-combined-${fileStamp()}.txt`,
      records.map(r => `[${r.time}]\n${r.en}\n${r.zh}\n`).join('\n'));
  });

  // ---- 接收字幕 ----
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'CAPTION') {
      if (msg.isFinal) {
        interimEl.textContent = '';
        addEntry(msg.transcript, msg.translation);
      } else {
        interimEl.textContent = msg.transcript;
      }
    }
    if (msg.type === 'CAPTURE_ERROR') {
      interimEl.textContent = '⚠ ' + msg.error;
    }
    if (msg.type === 'CAPTION_END') {
      box.querySelector('#ltc-title').textContent = '已停止（字幕可存檔）';
    }
  });
})();
