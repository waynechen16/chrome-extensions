// content.js — Meeting Scribe 字幕面板
// 講者 chip + 原文 + 繁中 + 英文；講者命名視窗；可拖曳；四種匯出
(() => {
  // 注入防護：正常情況下已注入就跳出。
  // 但外掛更新/重載後，舊 script 的 context 失效、旗標卻殘留，
  // 此時 background 會先設 __msForceReinject 再注入 → 接管並移除殘留面板。
  if (window.__msInjected && !window.__msForceReinject) return;
  if (window.__msInjected) document.getElementById('ms-box')?.remove();
  window.__msForceReinject = false;
  window.__msInjected = true;

  const box = document.createElement('div');
  box.id = 'ms-box';
  box.innerHTML = `
    <div id="ms-header">
      <span id="ms-title">Meeting Scribe</span>
      <span id="ms-buttons">
        <button class="ms-btn" id="ms-speakers-btn" title="編輯講者名稱">講者</button>
        <button class="ms-btn" id="ms-save-src" title="下載原文逐字稿">原文</button>
        <button class="ms-btn" id="ms-save-zh" title="下載中文">中文</button>
        <button class="ms-btn" id="ms-save-en" title="下載英文">英文</button>
        <button class="ms-btn" id="ms-save-md" title="下載 Markdown 會議記錄">MD</button>
        <button class="ms-btn" id="ms-close" title="關閉">✕</button>
      </span>
    </div>
    <div id="ms-speaker-panel" hidden></div>
    <div id="ms-history"></div>
    <div id="ms-interim"></div>
  `;
  document.documentElement.appendChild(box);

  const historyEl = box.querySelector('#ms-history');
  const interimEl = box.querySelector('#ms-interim');
  const headerEl = box.querySelector('#ms-header');
  const spkPanel = box.querySelector('#ms-speaker-panel');
  // ✕ 只隱藏面板（記錄與擷取照常進行），可從 popup「重新顯示字幕面板」找回
  box.querySelector('#ms-close').addEventListener('click', () => { box.style.display = 'none'; });

  // ---- 拖曳 ----
  let dragging = false, offX = 0, offY = 0;
  headerEl.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.ms-btn')) return;
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

  // ---- 講者 ----
  const SPK_COLORS = ['#4f9cf9', '#f97066', '#4fd1a5', '#e3b341', '#b98af9', '#f472b6', '#67d4e4', '#a3b18a'];
  // 講者名只存在「當次會議」的記憶體中，不做跨會議永久儲存——
  // 因為 Deepgram 的講者編號每次連線都會重新分配，上次的 Speaker 0 ≠ 這次的 Speaker 0。
  let names = {};                    // { "0": "Wayne", ... }
  const seen = new Set();            // 出現過的 speaker 編號
  let sessionHref = null;            // 本次記錄 session 開始時的網址

  const letter = (spk) => spk == null ? '?' : String.fromCharCode(65 + (spk % 26));
  const nameOf = (spk) => spk == null ? '' : (names[spk] || `Speaker ${letter(spk)}`);
  const colorOf = (spk) => spk == null ? '#999' : SPK_COLORS[spk % SPK_COLORS.length];

  function refreshChips() {
    box.querySelectorAll('.ms-chip').forEach((chip) => {
      chip.textContent = nameOf(Number(chip.dataset.spk));
    });
  }

  function renderSpeakerPanel() {
    spkPanel.innerHTML = '';
    if (!seen.size) {
      spkPanel.textContent = '尚未偵測到講者';
      return;
    }
    [...seen].sort((a, b) => a - b).forEach((spk) => {
      const row = document.createElement('div');
      row.className = 'ms-spk-row';
      const label = document.createElement('span');
      label.className = 'ms-chip';
      label.dataset.spk = spk;
      label.style.background = colorOf(spk);
      label.textContent = nameOf(spk);
      const input = document.createElement('input');
      input.className = 'ms-spk-input';
      input.placeholder = `Speaker ${letter(spk)} 的名字`;
      input.value = names[spk] || '';
      input.addEventListener('input', () => {
        if (input.value.trim()) names[spk] = input.value.trim();
        else delete names[spk];
        refreshChips();
      });
      row.append(label, input);
      spkPanel.appendChild(row);
    });
  }

  box.querySelector('#ms-speakers-btn').addEventListener('click', () => {
    spkPanel.hidden = !spkPanel.hidden;
    if (!spkPanel.hidden) renderSpeakerPanel();
  });

  // ---- 字幕 ----
  const records = [];   // { time, speaker, src, zh, en }

  function timestamp(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  function nearBottom() {
    return historyEl.scrollHeight - historyEl.scrollTop - historyEl.clientHeight < 48;
  }

  function addEntry(speaker, src, zh, en) {
    if (speaker != null && !seen.has(speaker)) {
      seen.add(speaker);
      if (!spkPanel.hidden) renderSpeakerPanel();
    }
    records.push({ time: timestamp(new Date()), speaker, src, zh, en });
    const stick = nearBottom();

    const entry = document.createElement('div');
    entry.className = 'ms-entry';
    const head = document.createElement('div');
    head.className = 'ms-entry-head';
    const chip = document.createElement('span');
    chip.className = 'ms-chip';
    chip.dataset.spk = speaker;
    chip.style.background = colorOf(speaker);
    chip.textContent = nameOf(speaker);
    head.appendChild(chip);
    const srcDiv = document.createElement('div');
    srcDiv.className = 'ms-src';
    srcDiv.textContent = src;
    entry.append(head, srcDiv);
    // 譯文與原文相同時（純英文句的 EN、純中文句的 ZH）不重複顯示；匯出仍保留完整欄位
    if (zh && zh.trim() !== src.trim()) {
      const zhDiv = document.createElement('div');
      zhDiv.className = 'ms-zh';
      zhDiv.textContent = zh;
      entry.append(zhDiv);
    }
    if (en && en.trim() !== src.trim()) {
      const enDiv = document.createElement('div');
      enDiv.className = 'ms-en';
      enDiv.textContent = en;
      entry.append(enDiv);
    }
    historyEl.appendChild(entry);
    if (stick) historyEl.scrollTop = historyEl.scrollHeight;
  }

  // ---- 匯出 ----
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
  const line = (r, field) => `[${r.time}] ${nameOf(r.speaker)}: ${r[field]}`;

  box.querySelector('#ms-save-src').addEventListener('click', () => {
    download(`meeting-source-${fileStamp()}.txt`, records.map(r => line(r, 'src')).join('\n'));
  });
  box.querySelector('#ms-save-zh').addEventListener('click', () => {
    download(`meeting-zh-${fileStamp()}.txt`, records.map(r => line(r, 'zh')).join('\n'));
  });
  box.querySelector('#ms-save-en').addEventListener('click', () => {
    download(`meeting-en-${fileStamp()}.txt`, records.map(r => line(r, 'en')).join('\n'));
  });
  box.querySelector('#ms-save-md').addEventListener('click', () => {
    const d = new Date();
    const md = [
      `# 會議記錄 ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      '',
      ...records.map(r =>
        `**[${r.time}] ${nameOf(r.speaker)}**\n> ${r.src}\n> 中：${r.zh}\n> EN: ${r.en}\n`)
    ].join('\n');
    download(`meeting-notes-${fileStamp()}.md`, md);
  });

  // ---- 重置 ----
  function resetAll() {
    records.length = 0;
    historyEl.innerHTML = '';
    interimEl.textContent = '';
    names = {};
    seen.clear();
    if (!spkPanel.hidden) renderSpeakerPanel();
  }

  // ---- 重新開啟面板 / 同頁重啟詢問 ----
  function showResumeDialog(text) {
    if (box.querySelector('#ms-resume')) return;
    const dlg = document.createElement('div');
    dlg.id = 'ms-resume';
    const label = document.createElement('span');
    label.textContent = text || `已有 ${records.length} 句記錄，要接續嗎？`;
    const btnYes = document.createElement('button');
    btnYes.className = 'ms-btn';
    btnYes.textContent = '接續記錄';
    const btnClear = document.createElement('button');
    btnClear.className = 'ms-btn';
    btnClear.textContent = '重新開始';
    dlg.append(label, btnYes, btnClear);
    box.insertBefore(dlg, historyEl);
    btnYes.addEventListener('click', () => dlg.remove());
    btnClear.addEventListener('click', () => {
      resetAll();       // 記錄與講者名一起清除
      dlg.remove();
    });
  }

  // ---- 接收 ----
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'PING') {
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'SHOW_PANEL') {
      const wasHidden = box.style.display === 'none';
      box.style.display = '';
      if (wasHidden && records.length) showResumeDialog();
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'SESSION_START') {
      // 每次按「開始記錄」都會收到。講者名的生命週期以此為界：
      box.style.display = '';
      const href = location.href;
      if (sessionHref && sessionHref !== href) {
        resetAll();                     // 網址已改變 → 視為新會議，自動重置回 Speaker A/B/C
      } else if (records.length) {
        // 同一頁再次開始 → 可能是中場暫停也可能是新會議，讓用戶決定
        showResumeDialog(`已有 ${records.length} 句記錄與講者名，要接續嗎？`);
      }
      sessionHref = href;
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'CAPTION') {
      if (msg.isFinal) {
        interimEl.textContent = '';
        addEntry(msg.speaker, msg.transcript, msg.zh, msg.en);
      } else {
        const chipTxt = msg.speaker != null ? `${nameOf(msg.speaker)}｜` : '';
        interimEl.textContent = chipTxt + msg.transcript;
      }
    }
    if (msg.type === 'CAPTURE_ERROR') {
      interimEl.textContent = '⚠ ' + msg.error;
    }
    if (msg.type === 'CAPTION_END') {
      box.querySelector('#ms-title').textContent = '已停止（可匯出）';
    }
  });
})();
