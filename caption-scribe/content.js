// content.js — Caption Scribe（DOM 版）v1.1
// 來源：頁面即時字幕（Teams / Webex / Google Meet 自動偵測，或手動框選區域；框選優先）
// 流程：DOM 擷取 → 逐字修正就地更新 → 閒置定稿 → 送翻譯（可關閉）→ 譯文補入同一條目
// 面板 UI / 匯出 / 錄音下載移植自 meeting-scribe
(() => {
  if (window.__csInjected && !window.__csForceReinject) return;
  // 如果正在初始化中，等待完成後再執行
  if (window.__csInitializing) return;
  window.__csInitializing = true;

  // 清理舊的 DOM 元素（防止多個面板）
  const oldBox = document.getElementById('cs-box');
  const oldIcon = document.getElementById('cs-floating-icon');
  if (oldBox) oldBox.remove();
  if (oldIcon) oldIcon.remove();

  // 清理舊的全局狀態
  if (window.__csInjected) {
    if (window.__csObserver) window.__csObserver.disconnect();
    if (window.__csScanTimer) clearInterval(window.__csScanTimer);
    if (window.__csFinalTimer) clearInterval(window.__csFinalTimer);
    if (window.__csStoreTimer) clearInterval(window.__csStoreTimer);
  }
  window.__csForceReinject = false;
  window.__csInjected = true;

  const HOST = location.hostname;
  const SEL_KEY = 'cs_sel_' + HOST;
  // 版本號顯示在面板標題，方便確認載入的是新版
  let VER = '';
  try { VER = 'v' + chrome.runtime.getManifest().version; } catch {}
  const TITLE = 'Caption Scribe ' + VER;
  const FINAL_IDLE_MS = 1800;  // 字幕條目多久沒變視為定稿 → 送翻譯
  const CHECK_MS = 500;

  const norm = (t) => (t || '').replace(/\s+/g, ' ').trim();
  // innerText 在部分環境（測試/舊引擎）不存在 → 退回 textContent
  const textOf = (el) => {
    if (!el) return '';
    const t = el.innerText;
    return norm(t !== undefined && t !== null ? t : el.textContent);
  };

  // ================= 面板 =================
  const box = document.createElement('div');
  box.id = 'cs-box';
  box.innerHTML = `
    <div id="cs-header">
      <span id="cs-title"></span>
      <span id="cs-buttons">
        <span id="cs-rec-indicator" class="cs-rec-dot" hidden></span>
        <button class="cs-btn" id="cs-flag-filter" title="只顯示標記「待修正」的句子（再按一次顯示全部）" hidden>⚑ 0</button>
        <button class="cs-btn" id="cs-save-src" title="下載原文逐字稿">原文</button>
        <button class="cs-btn" id="cs-save-zh" title="下載中文">中文</button>
        <button class="cs-btn" id="cs-save-md" title="下載 Markdown 會議記錄">MD</button>
        <button class="cs-btn cs-btn-dim" id="cs-save-audio" title="尚無錄音（在 popup 勾選「錄音」即可開始）">音檔</button>
        <button class="cs-btn" id="cs-clear" title="清除記錄">清除</button>
        <button class="cs-btn" id="cs-minimize" title="最小化">−</button>
        <button class="cs-btn" id="cs-close" title="關閉面板（記錄照常進行）">✕</button>
      </span>
    </div>
    <div id="cs-history"></div>
    <div id="cs-interim"></div>
    <div id="cs-status"></div>
  `;
  document.documentElement.appendChild(box);

  // 浮動最小化 icon（機器人頭 - 記錄君）
  const floatingIcon = document.createElement('div');
  floatingIcon.id = 'cs-floating-icon';
  floatingIcon.title = '按我回到完整面板';
  floatingIcon.innerHTML = `
    <!-- 記錄中狀態 (eyes open, working) -->
    <svg class="cs-icon-state cs-icon-recording" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
      <!-- 圓形頭 -->
      <circle cx="20" cy="20" r="16" fill="#5eb3f6" stroke="#2563eb" stroke-width="1.5"/>
      <!-- 左眼白 -->
      <circle cx="13" cy="16" r="4.5" fill="#fff"/>
      <!-- 左眼瞳孔 -->
      <circle cx="13" cy="16" r="2.5" fill="#1e40af" class="cs-eye-pupil-recording"/>
      <!-- 左眼反光 (sparkle) -->
      <circle cx="14" cy="14" r="1" fill="#fff" class="cs-eye-shine"/>
      <!-- 右眼白 -->
      <circle cx="27" cy="16" r="4.5" fill="#fff"/>
      <!-- 右眼瞳孔 -->
      <circle cx="27" cy="16" r="2.5" fill="#1e40af" class="cs-eye-pupil-recording"/>
      <!-- 右眼反光 (sparkle) -->
      <circle cx="28" cy="14" r="1" fill="#fff" class="cs-eye-shine"/>
      <!-- 左腮紅 -->
      <circle cx="5" cy="22" r="3" fill="#f87171" opacity="0.6"/>
      <!-- 右腮紅 -->
      <circle cx="35" cy="22" r="3" fill="#f87171" opacity="0.6"/>
      <!-- 開心的嘴 (大笑弧) -->
      <path d="M 14 26 Q 20 30 26 26" stroke="#1e40af" stroke-width="2" fill="none" stroke-linecap="round"/>
      <!-- 短天線（左） -->
      <rect x="10" y="3" width="1.5" height="4" fill="#f97066" rx="0.75"/>
      <circle cx="10.75" cy="2.5" r="1.2" fill="#f97066"/>
      <!-- 短天線（右） -->
      <rect x="28.5" y="3" width="1.5" height="4" fill="#f97066" rx="0.75"/>
      <circle cx="29.25" cy="2.5" r="1.2" fill="#f97066"/>
    </svg>

    <!-- 睡眠中狀態 (eyes closed, sleeping) -->
    <svg class="cs-icon-state cs-icon-sleeping" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
      <!-- 圓形頭 -->
      <circle cx="20" cy="20" r="16" fill="#4f9cf9" stroke="#2563eb" stroke-width="1.5"/>
      <!-- 左眼閉合（~~） -->
      <path d="M 9 16 Q 13 18 17 16" stroke="#2563eb" stroke-width="2" fill="none" stroke-linecap="round"/>
      <!-- 右眼閉合（~~） -->
      <path d="M 23 16 Q 27 18 31 16" stroke="#2563eb" stroke-width="2" fill="none" stroke-linecap="round"/>
      <!-- 左腮紅 -->
      <circle cx="5" cy="22" r="2.5" fill="#f87171" opacity="0.5"/>
      <!-- 右腮紅 -->
      <circle cx="35" cy="22" r="2.5" fill="#f87171" opacity="0.5"/>
      <!-- 平靜的嘴 (小弧或一字) -->
      <path d="M 15 27 Q 20 28 25 27" stroke="#2563eb" stroke-width="1.5" fill="none" stroke-linecap="round"/>
      <!-- 短天線（左） -->
      <rect x="10" y="3" width="1.5" height="4" fill="#f97066" rx="0.75"/>
      <circle cx="10.75" cy="2.5" r="1.2" fill="#f97066"/>
      <!-- 短天線（右） -->
      <rect x="28.5" y="3" width="1.5" height="4" fill="#f97066" rx="0.75"/>
      <circle cx="29.25" cy="2.5" r="1.2" fill="#f97066"/>
      <!-- 睡眠Z（上） -->
      <text x="34" y="8" font-size="8" fill="#4f9cf9" opacity="0.5" class="cs-sleep-z">Z</text>
      <!-- 睡眠Z（下） -->
      <text x="36" y="14" font-size="6" fill="#4f9cf9" opacity="0.4" class="cs-sleep-z">z</text>
    </svg>

    <!-- 隱密模式：貼邊小標籤上的狀態點（擷取中淡紅、未擷取灰色） -->
    <span class="cs-stealth-dot"></span>
  `;
  floatingIcon.style.display = 'none';
  document.documentElement.appendChild(floatingIcon);

  // 最小化 icon 外觀：'stealth'（預設，貼邊小標籤）或 'robot'（機器人頭）
  function applyIconStyle(style) {
    floatingIcon.classList.toggle('cs-stealth', style !== 'robot');
  }
  applyIconStyle('stealth');

  const historyEl = box.querySelector('#cs-history');
  const interimEl = box.querySelector('#cs-interim');
  const statusEl = box.querySelector('#cs-status');
  const titleEl = box.querySelector('#cs-title');
  titleEl.textContent = TITLE + '（未擷取）';
  const audioBtn = box.querySelector('#cs-save-audio');
  const recIndicator = box.querySelector('#cs-rec-indicator');

  let isMinimized = false;
  let hasContent = false;
  const contentEl = [historyEl, interimEl, statusEl];

  // 更新浮動 icon 的動態狀態
  function updateFloatingIcon() {
    hasContent = entries.length > 0;
    floatingIcon.classList.toggle('cs-icon-active', hasContent);
    // 根據錄製狀態切換 icon 外觀（記錄中 vs 睡眠中）
    updateIconState();
  }

  // 根據 capturing 狀態更新 icon 外觀
  function updateIconState() {
    if (capturing) {
      floatingIcon.classList.add('cs-recording-active');
      floatingIcon.classList.remove('cs-sleeping');
    } else {
      floatingIcon.classList.remove('cs-recording-active');
      floatingIcon.classList.add('cs-sleeping');
    }
  }

  // 最小化/最大化按鈕 —— 改為隱藏整個面板，顯示浮動 icon
  const minimizeBtn = box.querySelector('#cs-minimize');
  minimizeBtn.addEventListener('click', () => {
    isMinimized = !isMinimized;
    if (isMinimized) {
      box.style.display = 'none';
      floatingIcon.style.display = '';
      updateFloatingIcon();
    } else {
      box.style.display = '';
      floatingIcon.style.display = 'none';
    }
  });

  // 浮動 icon 點擊 —— 展開面板
  floatingIcon.addEventListener('click', () => {
    isMinimized = false;
    box.style.display = '';
    floatingIcon.style.display = 'none';
  });

  box.querySelector('#cs-close').addEventListener('click', () => { box.style.display = 'none'; });

  // ---- 拖曳（移植自參考版）----
  const headerEl = box.querySelector('#cs-header');
  let dragging = false, offX = 0, offY = 0;
  headerEl.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.cs-btn')) return;
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

  const SPK_COLORS = ['#4f9cf9', '#f97066', '#4fd1a5', '#e3b341', '#b98af9', '#f472b6', '#67d4e4', '#a3b18a'];
  function colorOf(name) {
    if (!name) return '#999';
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return SPK_COLORS[h % SPK_COLORS.length];
  }
  function timestamp(t) {
    const d = new Date(t);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  function nearBottom() {
    return historyEl.scrollHeight - historyEl.scrollTop - historyEl.clientHeight < 48;
  }
  function setStatus(msg) { statusEl.textContent = msg || ''; }

  // ================= 記錄 =================
  // entry: { id, t, s(peaker), x(原文), zh, en, state: 'live'|'sent'|'done', lastChange, sentText, el }
  let entries = [];
  let nextId = 1;
  let nodeMap = new WeakMap();
  let capturing = false;
  let pickedSelector = null;
  let translateOn = true;
  let dirtyStore = false;

  function entryById(id) { return entries.find((e) => e.id === id); }

  // ================= 使用者修改（v1.9.0） =================
  // 修改另外存在「修改表」（依條目 id），不直接改寫擷取到的原始字幕 e.x：
  //   edits[id] = {
  //     x?:       修改後的原文
  //     zh?:      手動修改的譯文（優先於自動譯文）
  //     tzh?:     依修改後原文自動重翻的譯文
  //     locked?:  已鎖定 → 不再套用平台對這句的更新
  //     pending?: 鎖定後平台又送來的新版本（可一鍵採用）
  //     flag?:    標記「待修正」
  //     s?:       單句講者名（用於平台沒給名字的句子）
  //   }
  // spkMap[原始講者名] = 改後名稱（同一位講者的所有句子一起改）
  // 原始字幕永遠保留在 entries，可隨時還原；顯示與匯出時才合併。
  let edits = {};
  let spkMap = {};
  let editingId = null;      // 正在編輯的條目 id
  let spkEditing = null;     // 正在改名的講者 { finish }
  let flagFilter = false;    // 只顯示待修正
  let mdShowOrig = false;    // MD 匯出時標出修改前的原文
  let hoverHistory = false;  // 滑鼠在歷史區上 → 暫停自動捲動，避免按鈕跑掉

  const edOf = (e) => edits[e.id];
  function dispX(e) {
    const ed = edOf(e);
    return ed && ed.x !== undefined ? ed.x : e.x;
  }
  function dispZh(e) {
    const ed = edOf(e);
    if (!ed) return e.zh;
    if (ed.zh !== undefined) return ed.zh;
    if (ed.x !== undefined) return ed.tzh !== undefined ? ed.tzh : (ed.tzhPending ? e.zh : '');
    return e.zh;
  }
  function spk(e) {
    const ed = edOf(e);
    return (ed && ed.s) || spkMap[e.s] || e.s || '';
  }
  const isEdited = (e) => { const ed = edOf(e); return !!ed && (ed.x !== undefined || ed.zh !== undefined); };
  // 修改表裡沒有任何有效欄位時移除，保持精簡
  function pruneEdit(id) {
    const ed = edits[id];
    if (!ed) return;
    for (const k of Object.keys(ed)) if (ed[k] === undefined || ed[k] === false) delete ed[k];
    if (!Object.keys(ed).length) delete edits[id];
  }

  // 譯文與原文相同時不重複顯示（匯出仍保留完整欄位）——移植自參考版
  function setTransLine(el, cls, text, src) {
    let div = el.querySelector('.' + cls);
    if (!text || text.trim() === src.trim()) { if (div) div.remove(); return; }
    if (!div) {
      div = document.createElement('div');
      div.className = cls;
      el.append(div);
    }
    div.textContent = text;
  }

  function actBtn(act, label, title) {
    const b = document.createElement('button');
    b.className = 'cs-act cs-act-' + act;
    b.dataset.act = act;
    b.textContent = label;
    b.title = title;
    return b;
  }

  function renderEntry(e) {
    // 編輯中或滑鼠停在歷史區時不自動捲動
    const stick = nearBottom() && editingId === null && !hoverHistory;
    // 進行中的條目放在底部固定的「即時區」，定稿後才移入歷史區——
    // 這樣逐字修正只在保留空間內變動，歷史列表不會跳動
    const parent = e.inHistory ? historyEl : interimEl;
    if (!e.el) {
      const el = document.createElement('div');
      el.className = 'cs-entry';
      el.dataset.id = e.id;
      const head = document.createElement('div');
      head.className = 'cs-entry-head';
      const chip = document.createElement('span');
      chip.className = 'cs-chip';
      chip.dataset.act = 'spk';
      chip.title = '點一下修改講者名稱';
      const time = document.createElement('span');
      time.className = 'cs-time';
      time.textContent = timestamp(e.t);
      const badges = document.createElement('span');
      badges.className = 'cs-badges';
      const actions = document.createElement('span');
      actions.className = 'cs-actions';
      actions.append(
        actBtn('edit', '✎', '修改這句（Enter 儲存、Esc 取消）'),
        actBtn('flag', '⚑', '標記／取消「待修正」'),
        actBtn('revert', '↺', '還原成平台原始字幕')
      );
      head.append(chip, time, badges, actions);
      const src = document.createElement('div');
      src.className = 'cs-src';
      el.append(head, src);
      parent.appendChild(el);
      e.el = el;
    } else if (e.el.parentElement !== parent) {
      parent.appendChild(e.el);   // 定稿 → 從即時區搬進歷史區
    }
    const ed = edOf(e);
    e.el.classList.toggle('cs-flagged', !!(ed && ed.flag));
    e.el.classList.toggle('cs-locked', !!(ed && ed.locked));

    // 講者 chip（改名輸入框開著時不動它）
    const chipEl = e.el.querySelector('.cs-chip');
    if (!chipEl.querySelector('input')) {
      const name = spk(e) || '字幕';
      if (chipEl.textContent !== name) chipEl.textContent = name;
      chipEl.style.background = colorOf(e.s || spk(e));   // 顏色跟著原始講者走，改名不變色
    }

    // 狀態標記：已修改 / 待修正 / 平台有新版本
    const badges = e.el.querySelector('.cs-badges');
    badges.textContent = '';
    if (isEdited(e)) {
      const b = document.createElement('span');
      b.className = 'cs-badge';
      b.textContent = '已修改';
      badges.append(b);
    }
    if (ed && ed.flag) {
      const b = document.createElement('span');
      b.className = 'cs-badge cs-badge-flag';
      b.textContent = '⚑ 待修正';
      badges.append(b);
    }
    if (ed && ed.pending) {
      const b = document.createElement('button');
      b.className = 'cs-badge-pending';
      b.dataset.act = 'adopt';
      b.textContent = '平台有新版本';
      b.title = '平台更新為：「' + ed.pending + '」\n點一下改用平台版本（會捨棄你的修改）';
      badges.append(b);
    }

    if (e.id === editingId) {   // 編輯中：不覆寫編輯框
      return;
    }
    const x = dispX(e);
    const srcEl = e.el.querySelector('.cs-src');
    if (srcEl.textContent !== x) srcEl.textContent = x;
    srcEl.classList.toggle('cs-live', translateOn && e.state !== 'done');
    setTransLine(e.el, 'cs-zh', dispZh(e), x);
    const zhDiv = e.el.querySelector('.cs-zh');
    // 暫定譯文半透明（含修改後重翻中）
    if (zhDiv) zhDiv.classList.toggle('cs-tentative', e.state !== 'done' || !!(ed && ed.tzhPending));
    if (stick) historyEl.scrollTop = historyEl.scrollHeight;
  }

  // ================= 講者解析輔助 =================
  // 出現過的講者名（跨掃描累積；也從歷史記錄還原）——用來辨認「名字塊」
  const knownSpeakers = new Set();

  // 名字的長相：短、不含任何句中/句末標點
  function looksLikeName(t) {
    return !!t && t.length <= 40 && !/[。．.！!？?，,、；;：:…]/.test(t);
  }

  // 「Name: 內容」前綴 → 拆出講者（名字不含標點、不超過 30 字）
  function splitSpeakerPrefix(text) {
    const m = text.match(/^([^:：]{1,30})[:：]\s*(.+)$/s);
    if (m && looksLikeName(norm(m[1]))) return { speaker: norm(m[1]), text: norm(m[2]) };
    return { speaker: '', text };
  }

  // 結構式解析：區塊內第一個「有文字的」子元素是名字、其餘是內容。
  // 頭像常是 img 或無文字的 div → 過濾掉；只剩一個有字的子元素（包裝層）就遞迴下探。
  function splitByStructure(el, depth = 0) {
    if (!el || !el.children) return null;
    const kids = [...el.children].filter((c) => c.tagName !== 'IMG' && textOf(c));
    if (kids.length >= 2) {
      const name = textOf(kids[0]);
      const rest = kids.slice(1).map(textOf).filter(Boolean).join(' ');
      if (rest && looksLikeName(name)) return { speaker: name, text: norm(rest) };
      return null;
    }
    if (kids.length === 1 && depth < 3) return splitByStructure(kids[0], depth + 1);
    return null;
  }

  // 「單一字幕項」vs「整個清單」的分辨：
  // 能結構式解析、且直接子區塊中「名字長相」的不超過一個，才視為單項。
  // （名字/內容成對排列的清單會有多個名字塊 → 應該繼續下探逐項處理）
  function isCaptionItem(el) {
    if (!splitByStructure(el)) return false;
    const kids = [...el.children].filter((c) => c.tagName !== 'IMG' && textOf(c));
    const nameish = kids.filter((c) => looksLikeName(textOf(c))).length;
    return nameish <= 1;
  }

  // 通用擷取：下探到「一句一項」層級後，逐項解析。
  // 支援三種型態：
  //   A. 單項內含名字+文字（結構式，含巢狀包裝層）
  //   B. 名字塊與內容塊是「兄弟區塊成對出現」（Teams 常見）——
  //      名字塊短且無標點，且（已知講者 / 在後面重複出現 / 下一塊像句子）
  //   C. 純文字「Name: 內容」前綴
  function extractItems(rootEl) {
    const blocks = findItemBlocks(rootEl);
    const out = [];
    for (let i = 0; i < blocks.length; i++) {
      const el = blocks[i];
      const st = isCaptionItem(el) ? splitByStructure(el) : null;
      if (st) {
        knownSpeakers.add(st.speaker);
        out.push({ node: el, speaker: st.speaker, text: st.text });
        continue;
      }
      const t = textOf(el);
      if (!t) continue;
      // 型態 B：名字塊 + 內容塊 成對
      if (looksLikeName(t) && i + 1 < blocks.length) {
        const nxt = blocks[i + 1];
        const st2 = splitByStructure(nxt);
        const ntext = st2 ? st2.text : textOf(nxt);
        const nameEvidence =
          knownSpeakers.has(t) ||
          (ntext && !looksLikeName(ntext)) ||
          blocks.slice(i + 1).some((b) => textOf(b) === t);
        if (ntext && nameEvidence) {
          knownSpeakers.add(t);
          out.push({ node: nxt, speaker: (st2 && st2.speaker) || t, text: ntext });
          i++;
          continue;
        }
      }
      // 型態 C
      const sp = splitSpeakerPrefix(t);
      if (sp.speaker) knownSpeakers.add(sp.speaker);
      out.push({ node: el, speaker: sp.speaker, text: sp.text });
    }
    return out;
  }

  // ================= 各平台字幕擷取 =================
  function teamsItems() {
    const out = [];
    // 新版 Teams（實測 2026-07 DOM）：沒有 closed-captions-renderer 外層 data-tid。
    // 每句是一個 .fui-ChatMessageCompact__body，名字(author)與文字(closed-caption-text)
    // 在不同的兄弟分支 → 從字幕文字「往上走」找到同時包含 author 的訊息容器。
    for (const el of document.querySelectorAll('[data-tid="closed-caption-text"]')) {
      const text = textOf(el);
      if (!text) continue;
      let item = el.parentElement || el;   // 找不到 author 時的近端容器
      let author = null;
      let cur = el.parentElement;
      for (let i = 0; i < 6 && cur; i++, cur = cur.parentElement) {
        const a = cur.querySelector('[data-tid="author"]');
        if (a) {
          // 若這一層已含多句字幕，代表走過頭（到清單層了）→ 放棄，避免抓錯人
          if (cur.querySelectorAll('[data-tid="closed-caption-text"]').length > 1) break;
          item = cur; author = a; break;
        }
      }
      out.push({ node: item, speaker: author ? textOf(author) : '', text });
    }
    if (out.length) return out;
    const renderer = document.querySelector('[data-tid="closed-captions-renderer"]');
    if (renderer) {
      let items = renderer.querySelectorAll('.fui-ChatMessageCompact');
      if (!items.length) items = renderer.querySelectorAll('li');
      for (const el of items) {
        const author = el.querySelector('[data-tid="author"], .ui-chat__message__author, [class*="author"]');
        const txtEl = el.querySelector('[data-tid="closed-caption-text"]');
        let speaker = author ? textOf(author) : '';
        let text = txtEl ? textOf(txtEl) : textOf(el);
        if (!speaker) {
          const st = splitByStructure(el) || splitSpeakerPrefix(text);
          if (st && st.speaker) { speaker = st.speaker; if (!txtEl) text = st.text; }
        }
        if (text) out.push({ node: el, speaker, text });
      }
      // data-tid 抓得到字幕但全部沒講者名 → 改用通用擷取（結構/成對/前綴）再試一次
      if (out.length && out.every((i) => !i.speaker)) {
        const generic = extractItems(renderer);
        if (generic.length && generic.some((i) => i.speaker)) return generic;
      }
      if (out.length) return out;
      // renderer 存在但 data-tid 全失效 → 直接通用擷取
      const generic = extractItems(renderer);
      if (generic.length) return generic;
    }
    for (const el of document.querySelectorAll('[data-tid="closed-caption-text"]')) {
      const item = el.closest('li,div') || el;
      const author = item.querySelector ? item.querySelector('[data-tid="author"], [class*="author"]') : null;
      const text = textOf(el);
      if (text) out.push({ node: item, speaker: author ? textOf(author) : '', text });
    }
    return out;
  }

  const WEBEX_SELS = [
    '[class*="closed-caption"] li',
    '[class*="closedCaption"] li',
    '[class*="caption-row"]',
    '[class*="captionRow"]',
    '[class*="caption-item"]',
    '[class*="captionItem"]',
    '[class*="transcript-item"]'
  ];
  function webexItems() {
    for (const sel of WEBEX_SELS) {
      let els;
      try { els = document.querySelectorAll(sel); } catch { continue; }
      if (!els.length) continue;
      const out = [];
      for (const el of els) {
        const sp = el.querySelector('[class*="name"], [class*="speaker"], [class*="author"]');
        let speaker = sp ? textOf(sp) : '';
        let text = textOf(el);
        if (speaker && text.startsWith(speaker)) {
          text = norm(text.slice(speaker.length).replace(/^[:：]\s*/, ''));
        }
        if (!speaker) {
          const st = splitByStructure(el) || splitSpeakerPrefix(text);
          if (st && st.speaker) { speaker = st.speaker; text = st.text; }
        }
        if (text) out.push({ node: el, speaker, text });
      }
      if (out.length) return out;
    }
    return [];
  }

  // Google Meet：字幕在 aria-label 為 Captions/字幕 的 region 中，
  // 每項為「頭像 + 名字區塊 + 文字區塊」
  function meetItems() {
    let region = null;
    for (const r of document.querySelectorAll('div[role="region"][aria-label], div[aria-label][jsname]')) {
      const label = r.getAttribute('aria-label') || '';
      if (/caption|字幕|字元|субтит|subt[ií]t|untertitel|자막|字幕表示/i.test(label)) { region = r; break; }
    }
    if (!region) region = document.querySelector('.a4cQT');  // 舊版 class fallback
    if (!region) return [];
    // 逐層下探包裝層——但若唯一子元素本身就是「名字+文字」的字幕項就停住
    let root = region;
    for (let i = 0; i < 3 && root.children.length === 1 && !splitByStructure(root.children[0]); i++) {
      root = root.children[0];
    }
    const out = [];
    for (const b of root.children) {
      const st = splitByStructure(b);
      if (st) { out.push({ node: b, speaker: st.speaker, text: st.text }); continue; }
      const t = textOf(b);
      if (!t) continue;
      const sp = splitSpeakerPrefix(t);
      out.push({ node: b, speaker: sp.speaker, text: sp.text });
    }
    return out;
  }

  // 從使用者框選的元素往下探，找出「一句一項」的字幕項層級。
  // 使用者常會框到整個字幕外框（下面還有捲動容器、清單等包裝層）：
  // 只要這一層只有一個「有文字的」子元素、而且它還不是字幕項本身，就繼續往下走。
  function findItemBlocks(rootEl) {
    let root = rootEl;
    for (let i = 0; i < 6; i++) {
      const kids = [...root.children].filter((c) => textOf(c));
      if (kids.length === 1 && !isCaptionItem(kids[0])) { root = kids[0]; continue; }
      break;
    }
    const kids = [...root.children].filter((c) => textOf(c));
    return kids.length ? kids : [root];
  }

  function pickedItems() {
    if (!pickedSelector) return [];
    let rootEl = null;
    try { rootEl = document.querySelector(pickedSelector); } catch { return []; }
    if (!rootEl) return [];
    return extractItems(rootEl);
  }

  let lastSource = '';   // 診斷顯示：目前生效的解析來源

  function platformLabel() {
    if (HOST.includes('teams')) return 'Teams 內建';
    if (HOST.includes('webex')) return 'Webex 內建';
    if (HOST.includes('meet.google')) return 'Meet 內建';
    return '通用';
  }

  function platformItems() {
    if (HOST.includes('teams')) return teamsItems();
    if (HOST.includes('webex')) return webexItems();
    if (HOST.includes('meet.google')) return meetItems();
    return [];
  }

  function collectItems() {
    // 手動框選優先；但若框選解析不到任何講者、平台內建偵測解析得到 → 自動改用內建結果
    const picked = pickedItems();
    if (picked.length) {
      if (picked.every((i) => !i.speaker)) {
        const platform = platformItems();
        if (platform.length && platform.some((i) => i.speaker)) {
          lastSource = platformLabel() + '（自動接手）';
          return platform;
        }
      }
      lastSource = '手動框選';
      return picked;
    }
    const p = platformItems();
    if (p.length) lastSource = platformLabel();
    return p;
  }

  // ================= 去重、聚合與定稿 =================
  function touch(e, text, speaker) {
    let changed = false;
    const ed = edOf(e);
    const locked = !!(ed && ed.locked);
    if (e.x !== text) {
      if (locked) {
        // 使用者改過的句子不再被平台覆蓋；平台的新版本只記下來，讓使用者決定要不要採用
        const pending = text === dispX(e) ? undefined : text;
        if (ed.pending !== pending) {
          ed.pending = pending;
          pruneEdit(e.id);
          dirtyStore = true;
          renderEntry(e);
        }
      } else {
        e.x = text;
        changed = true;
      }
    }
    if (speaker && e.s !== speaker) { e.s = speaker; changed = true; }
    if (changed) {
      e.lastChange = Date.now();
      // 定稿甚至翻譯後原文又長出來（長停頓後續講）→ 回到 live，之後重新定稿重翻
      // （已鎖定的句子不重翻原始字幕）
      if (e.state !== 'live' && !locked) e.state = 'live';
      dirtyStore = true;
      renderEntry(e);
    }
  }

  // 前綴＋後綴重合率（0~1）：快速估兩段文字的相似度
  function textSimilarity(a, b) {
    if (a === b) return 1;
    const la = a.length, lb = b.length;
    const minL = Math.min(la, lb);
    let p = 0;
    while (p < minL && a[p] === b[p]) p++;
    let s = 0;
    while (s < minL - p && a[la - 1 - s] === b[lb - 1 - s]) s++;
    return (p + s) / Math.max(la, lb);
  }

  // 未知節點 → 在最近 12 條記錄中找歸屬：
  //   完全相同（且長度 ≥6，或就是最後一條）→ 同一句
  //   相似度 ≥0.85 且雙方長度 ≥10 → 同一句的修正版
  // 短句（「好。」「Mm-hmm.」）不跨條合併——重複說的話應保留為獨立條目
  function findRecentMatch(it) {
    const from = Math.max(0, entries.length - 12);
    for (let i = entries.length - 1; i >= from; i--) {
      const e = entries[i];
      if (it.speaker && e.s && it.speaker !== e.s) continue;
      const isLast = i === entries.length - 1;
      if (e.x === it.text && (isLast || it.text.length >= 6)) return e;
      if (it.text.length >= 10 && e.x.length >= 10 && textSimilarity(e.x, it.text) >= 0.85) return e;
    }
    return null;
  }

  function scan() {
    let items;
    try { items = collectItems(); } catch { return; }
    // 即時診斷：來源解析器 / 講者是否解析成功 / 累計句數
    if (capturing && items.length) {
      const spkOk = items.some((i) => i.speaker) || entries.some((e) => e.s);
      setStatus(`來源：${lastSource}｜講者：${spkOk ? '✔ 有解析到' : '— 未解析到'}｜已擷取 ${entries.length} 句`);
    }
    const now = Date.now();
    for (const it of items) {
      const knownId = nodeMap.get(it.node);
      if (knownId !== undefined) {
        const e = entryById(knownId);
        if (e) touch(e, it.text, it.speaker);
        continue;
      }
      // Teams 有時會重建整段字幕清單的 DOM（節點全換新、舊句文字可能微調）——
      // 往回搜尋最近的記錄：完全相同的直接歸戶、高相似度的視為同句修正就地更新
      const cand = findRecentMatch(it);
      if (cand) {
        nodeMap.set(it.node, cand.id);
        if (it.text !== cand.x && it.text.length >= cand.x.length) {
          touch(cand, it.text, it.speaker);      // 修正版較長或等長 → 更新（會重新翻譯）
        }
        continue;
      }
      const last = entries.length ? entries[entries.length - 1] : null;
      const sameSpeaker = last && (!it.speaker || !last.s || it.speaker === last.s);
      if (last && sameSpeaker && last.x === it.text) {
        nodeMap.set(it.node, last.id);           // 節點被回收但內容相同
      } else if (
        last && sameSpeaker && it.text !== last.x &&
        (it.text.startsWith(last.x) || last.x.startsWith(it.text))
      ) {
        nodeMap.set(it.node, last.id);           // 漸進式修正 → 合併
        if (it.text.length >= last.x.length) touch(last, it.text, it.speaker);
      } else {
        promoteLiveEntries();   // 新的一句開始 → 前面的句子視為講完，移入歷史區
        const e = {
          id: nextId++, t: now, s: it.speaker || '', x: it.text,
          zh: '', en: '', state: 'live', lastChange: now, sentText: '', el: null,
          inHistory: false
        };
        entries.push(e);
        nodeMap.set(it.node, e.id);
        dirtyStore = true;
        renderEntry(e);
        updateFloatingIcon();  // 有新內容時更新浮動 icon
      }
    }
  }

  // ================= 預先翻譯 + 定稿 =================
  // 不等斷句：字幕還在變動時就先翻（每個條目最快 PRETRANS_MS 送一次），
  // 畫面先顯示「暫定譯文」（半透明）；文字停止變動 FINAL_IDLE_MS 後，
  // 若最後一次譯文已對應最終文字就直接轉正（不再重翻一次，省 API 額度），
  // 否則補送最後一次翻譯。
  const PRETRANS_MS = 1000;

  // 把尚在即時區的條目移入歷史區（新句開始或閒置定稿時呼叫）
  function promoteLiveEntries() {
    for (const e of entries) {
      if (!e.inHistory) { e.inHistory = true; renderEntry(e); }
    }
  }

  function requestTranslate(e) {
    if (e.inflight) return;
    e.inflight = true;
    const snapshot = e.x;
    e.sentText = snapshot;
    e.lastReq = Date.now();
    chrome.runtime.sendMessage({ type: 'TRANSLATE', text: snapshot })
      .then((r) => {
        const cur = entryById(e.id);
        if (cur) {
          cur.inflight = false;
          cur.zh = r?.zh || '';
          cur.zhFor = snapshot;   // 這份譯文對應的原文快照
          // 原文已停止變動（或已停止擷取）且譯文對應最終文字 → 定稿
          if (cur.zhFor === cur.x && (!capturing || Date.now() - cur.lastChange >= FINAL_IDLE_MS)) {
            cur.state = 'done';
            cur.inHistory = true;
          }
          dirtyStore = true;
          renderEntry(cur);
        }
        e.inflight = false;
      })
      .catch(() => { e.inflight = false; });
  }

  function finalizeCheck() {
    const now = Date.now();
    for (const e of entries) {
      if (e.state === 'done') continue;
      const idle = now - e.lastChange;
      // 文字已停止變動 → 先移入歷史區（譯文可稍後補入，不影響版面穩定）
      if (idle >= FINAL_IDLE_MS && !e.inHistory) { e.inHistory = true; renderEntry(e); }
      if (!translateOn) {
        if (idle >= FINAL_IDLE_MS) { e.state = 'done'; dirtyStore = true; renderEntry(e); }
        continue;
      }
      // 預先翻譯：文字有變、且距上次送出 ≥ PRETRANS_MS（首次立即送）
      if (e.x !== e.sentText && !e.inflight && now - (e.lastReq || 0) >= PRETRANS_MS) {
        requestTranslate(e);
        continue;
      }
      // 定稿判斷
      if (idle >= FINAL_IDLE_MS) {
        if (e.zhFor === e.x) {
          e.state = 'done';
          dirtyStore = true;
          renderEntry(e);
        } else if (!e.inflight && now - (e.lastReq || 0) >= PRETRANS_MS) {
          // 上次請求失敗或落後 → 補送（同樣受節流限制，避免失敗時連環重送）
          e.sentText = null;
          requestTranslate(e);
        }
      }
    }
  }

  // ================= 持久化（面板重建 / 匯出保險） =================
  function storeSnapshot() {
    if (!dirtyStore) return;
    dirtyStore = false;
    const slim = entries.map(({ id, t, s, x, zh, en, state }) => ({ id, t, s, x, zh, en, state }));
    // 修改表不存「重翻中」這種暫時狀態
    const slimEdits = {};
    for (const [id, ed] of Object.entries(edits)) {
      const { tzhPending, ...rest } = ed;
      slimEdits[id] = rest;
    }
    try { chrome.storage.local.set({ cs_entries: slim, cs_edits: slimEdits, cs_spkMap: spkMap }); } catch {}
  }

  // ================= 擷取控制 =================
  let observer = null;
  let scanTimer = null;
  let finalTimer = null;
  let storeTimer = null;
  let scanQueued = false;

  function queueScan() {
    if (scanQueued || !capturing) return;
    scanQueued = true;
    setTimeout(() => { scanQueued = false; if (capturing) scan(); }, 800);
  }

  function startCapture() {
    if (capturing) return;
    capturing = true;
    box.style.display = '';
    // 開始擷取會叫出面板 → 同步收起最小化 icon，避免面板與 icon 同時出現、最小化按鈕狀態錯亂
    isMinimized = false;
    floatingIcon.style.display = 'none';
    recIndicator.hidden = false;
    titleEl.textContent = TITLE + (translateOn ? ' 記錄中…' : ' 記錄中（翻譯關閉）');
    observer = new MutationObserver(queueScan);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    scanTimer = setInterval(() => { if (capturing) scan(); }, 1500);
    finalTimer = setInterval(finalizeCheck, 1200);
    storeTimer = setInterval(storeSnapshot, 2000);
    updateIconState();
    scan();
    setStatus(pickedSelector ? '使用手動框選的字幕區域' : '');
  }

  function stopCapture() {
    if (!capturing) return;
    capturing = false;
    recIndicator.hidden = true;
    if (observer) { observer.disconnect(); observer = null; }
    clearInterval(scanTimer);
    clearInterval(finalTimer);
    clearInterval(storeTimer);
    updateIconState();
    // 停止時把尚未定稿的條目全部立即定稿（補送翻譯或直接完成）
    for (const e of entries) {
      if (e.state !== 'done') { e.lastChange = 0; e.lastReq = 0; }
    }
    promoteLiveEntries();
    finalizeCheck();
    dirtyStore = true;
    storeSnapshot();
    titleEl.textContent = TITLE + ' 已停止（可匯出）';
  }

  function resetAll() {
    if (spkEditing) spkEditing.finish(false);
    editingId = null;
    edits = {};
    spkMap = {};
    flagFilter = false;
    entries = [];
    nextId = 1;
    nodeMap = new WeakMap();
    historyEl.innerHTML = '';
    interimEl.innerHTML = '';
    dirtyStore = true;
    storeSnapshot();
    chrome.runtime.sendMessage({ type: 'AUDIO_RESET' }).catch(() => {});
    setStatus('');
    updateFlagUI();
    updateFloatingIcon();  // 清除時更新浮動 icon
  }

  // ================= 匯出（移植自參考版） =================
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
  // 匯出一律使用修改後的文字與講者名
  const line = (e, text) => `[${timestamp(e.t)}]${spk(e) ? ' ' + spk(e) + ':' : ''} ${text || ''}`;

  box.querySelector('#cs-save-src').addEventListener('click', () => {
    download(`caption-source-${fileStamp()}.txt`, entries.map((e) => line(e, dispX(e))).join('\n'));
  });
  box.querySelector('#cs-save-zh').addEventListener('click', () => {
    download(`caption-zh-${fileStamp()}.txt`, entries.map((e) => line(e, dispZh(e))).join('\n'));
  });
  box.querySelector('#cs-save-md').addEventListener('click', () => {
    const d = new Date();
    const md = [
      `# 會議記錄 ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      '',
      ...entries.map((e) => {
        // 譯文直接列出（不加「中：」前綴）；譯文為空或與原文相同時省略，避免重複
        const x = dispX(e);
        const zhText = dispZh(e);
        const zh = zhText && zhText.trim() !== x.trim() ? `\n> ${zhText}` : '';
        const ed = edOf(e);
        // 選用：以刪除線標出修改前的平台原文
        const orig = mdShowOrig && ed && ed.x !== undefined && ed.x !== e.x ? `\n> ~~${e.x}~~` : '';
        const flag = ed && ed.flag ? ' ⚑' : '';
        return `**[${timestamp(e.t)}] ${spk(e) || '字幕'}**${flag}${orig}\n> ${x}${zh}\n`;
      })
    ].join('\n');
    download(`caption-notes-${fileStamp()}.md`, md);
  });
  box.querySelector('#cs-clear').addEventListener('click', () => {
    if (!confirm('確定要清除目前的記錄（含錄音）嗎？')) return;
    resetAll();
  });

  // 音檔（MP3）：向 background 要（background 轉問 offscreen → chrome.downloads）
  // 按鈕一律顯示，隨時可存檔；沒有錄音資料時變淡並提示怎麼開始錄音
  audioBtn.addEventListener('click', async () => {
    if (!recHasData) {
      setStatus('尚無錄音資料：點外掛圖示，勾選「錄音」即可開始錄音（擷取中勾選會立即開始）');
      return;
    }
    try {
      const r = await chrome.runtime.sendMessage({ type: 'SAVE_AUDIO' });
      if (!r?.ok) setStatus('⚠ ' + (r?.error || '無法儲存錄音'));
      else setStatus(recRecording ? '已下載目前為止的錄音，錄音繼續中' : '已下載錄音');
    } catch {
      setStatus('⚠ 無法儲存錄音');
    }
  });

  // ================= 即時修改字幕（v1.9.0） =================
  function showPanel() {
    box.style.display = '';
    floatingIcon.style.display = 'none';
    isMinimized = false;
  }

  // 可編輯的條目：已移入歷史區（停止變動）的句子；篩選待修正時只在待修正之間移動
  function editableEntries() {
    return entries.filter((e) => e.inHistory && (!flagFilter || (edOf(e) && edOf(e).flag)));
  }

  function autosize(ta) {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }

  function openEditor(e) {
    if (!e || !e.el) return;
    if (!e.inHistory) { setStatus('這句還在變動中，定稿（移入上方）後才能修改'); return; }
    if (editingId === e.id) return;
    if (editingId !== null) closeEditor(true);
    if (spkEditing) spkEditing.finish(true);
    editingId = e.id;
    const ed = document.createElement('div');
    ed.className = 'cs-editor';
    const taX = document.createElement('textarea');
    taX.className = 'cs-edit-src';
    taX.rows = 1;
    taX.value = dispX(e);
    const taZh = document.createElement('textarea');
    taZh.className = 'cs-edit-zh';
    taZh.rows = 1;
    taZh.value = dispZh(e) || '';
    taZh.placeholder = '譯文（不改＝依修改後的原文自動重翻）';
    ed.dataset.origZh = taZh.value;
    const hint = document.createElement('div');
    hint.className = 'cs-edit-hint';
    hint.textContent = 'Enter 儲存｜Esc 取消｜Tab 切換原文／譯文｜Alt+↑↓ 上一句／下一句';
    ed.append(taX, taZh, hint);
    e.el.classList.add('cs-editing');
    e.el.append(ed);
    for (const ta of [taX, taZh]) {
      ta.addEventListener('input', () => autosize(ta));
      autosize(ta);
    }
    e.el.scrollIntoView({ block: 'nearest' });
    taX.focus();
    taX.setSelectionRange(taX.value.length, taX.value.length);
  }

  function closeEditor(save) {
    if (editingId === null) return;
    const e = entryById(editingId);
    editingId = null;
    if (!e || !e.el) return;
    const ed = e.el.querySelector('.cs-editor');
    if (ed && save) {
      applyEdit(e, ed.querySelector('.cs-edit-src').value, ed.querySelector('.cs-edit-zh').value, ed.dataset.origZh || '');
    }
    if (ed) ed.remove();
    e.el.classList.remove('cs-editing');
    renderEntry(e);
  }

  function applyEdit(e, rawX, rawZh, origZh) {
    const x = norm(rawX);
    const zh = norm(rawZh);
    const srcChanged = !!x && x !== dispX(e);   // 原文清空視為沒改
    const zhChanged = zh !== norm(origZh);
    if (!srcChanged && !zhChanged) return;
    const ed = edits[e.id] || (edits[e.id] = {});
    ed.locked = true;          // 改過就鎖定，平台之後的更新只會變成「平台有新版本」
    e.state = 'done';
    e.inHistory = true;
    if (srcChanged) {
      ed.x = x === e.x ? undefined : x;   // 改回跟平台一樣 → 不必另存
      ed.tzh = undefined;
      if (ed.pending === x) ed.pending = undefined;
    }
    if (zhChanged) {
      ed.zh = zh || undefined;            // 譯文清空 → 回到自動譯文
    } else if (srcChanged) {
      ed.zh = undefined;                  // 原文改了、譯文沒動 → 舊的手動譯文作廢，改為自動重翻
    }
    if (srcChanged && ed.x !== undefined && ed.zh === undefined) {
      if (translateOn) translateEdited(e);
      else ed.tzh = '';                   // 翻譯關閉：不顯示對不上的舊譯文
    }
    pruneEdit(e.id);
    dirtyStore = true;
  }

  function translateEdited(e) {
    const ed = edOf(e);
    if (!ed || ed.x === undefined) return;
    const text = ed.x;
    ed.tzhPending = true;
    chrome.runtime.sendMessage({ type: 'TRANSLATE', text })
      .then((r) => {
        const cur = edOf(e);
        if (cur && cur.x === text) cur.tzh = (r && r.zh) || '';
      })
      .catch(() => {})
      .finally(() => {
        const cur = edOf(e);
        if (cur) { delete cur.tzhPending; pruneEdit(e.id); }
        dirtyStore = true;
        renderEntry(e);
      });
  }

  // 還原成平台字幕（若平台有新版本，直接採用新版本並重新翻譯）
  function revertEntry(e) {
    const ed = edOf(e);
    if (!ed) return;
    if (editingId === e.id) closeEditor(false);
    const pending = ed.pending;
    edits[e.id] = { flag: ed.flag, s: ed.s };
    pruneEdit(e.id);
    if (pending) e.x = pending;
    if (translateOn && e.zhFor !== e.x) {
      // 譯文對不上平台原文 → 重新排入翻譯
      e.state = 'live';
      e.sentText = '';
      e.lastReq = 0;
      e.lastChange = Date.now() - FINAL_IDLE_MS;
      if (!capturing) requestTranslate(e);
    }
    dirtyStore = true;
    renderEntry(e);
  }

  function toggleFlag(e) {
    if (!e) return;
    const ed = edits[e.id] || (edits[e.id] = {});
    ed.flag = !ed.flag;
    pruneEdit(e.id);
    dirtyStore = true;
    updateFlagUI();
    renderEntry(e);
  }

  const flagBtn = box.querySelector('#cs-flag-filter');
  function updateFlagUI() {
    const n = entries.filter((e) => edOf(e) && edOf(e).flag).length;
    if (!n) flagFilter = false;
    flagBtn.hidden = !n;
    flagBtn.textContent = '⚑ ' + n;
    flagBtn.classList.toggle('cs-on', flagFilter);
    historyEl.classList.toggle('cs-only-flagged', flagFilter);
  }
  flagBtn.addEventListener('click', () => {
    flagFilter = !flagFilter;
    updateFlagUI();
    if (!flagFilter) historyEl.scrollTop = historyEl.scrollHeight;
  });

  // 講者改名：有名字的講者 → 同名的所有句子一起改；沒名字（「字幕」）的句子 → 只改這一句
  function renameSpeaker(e) {
    if (!e || !e.el) return;
    const chip = e.el.querySelector('.cs-chip');
    if (chip.querySelector('input')) return;
    if (spkEditing) spkEditing.finish(true);
    const input = document.createElement('input');
    input.className = 'cs-spk-input';
    input.value = spk(e);
    input.placeholder = '講者名稱';
    input.size = Math.max(6, input.value.length + 2);
    chip.textContent = '';
    chip.append(input);
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      spkEditing = null;
      const v = norm(input.value);
      input.remove();
      if (save) {
        if (e.s) {
          if (!v || v === e.s) delete spkMap[e.s];
          else spkMap[e.s] = v;
        } else {
          const ed = edits[e.id] || (edits[e.id] = {});
          ed.s = v || undefined;
          pruneEdit(e.id);
        }
        dirtyStore = true;
        for (const x of entries) renderEntry(x);
      } else {
        renderEntry(e);
      }
    };
    spkEditing = { finish, input };
    input.addEventListener('blur', () => finish(true));
    input.focus();
    input.select();
  }

  function moveEditor(dir) {
    const list = editableEntries();
    const i = list.findIndex((x) => x.id === editingId);
    const target = list[i + dir];
    if (!target) return;
    closeEditor(true);
    openEditor(target);
  }

  function editLatest() {
    showPanel();
    const list = editableEntries();
    if (!list.length) { setStatus('還沒有定稿的句子可以修改'); return; }
    openEditor(list[list.length - 1]);
  }

  function flagLatest() {
    const e = entries[entries.length - 1];
    if (!e) { setStatus('還沒有句子可以標記'); return; }
    toggleFlag(e);
    const on = !!(edOf(e) && edOf(e).flag);
    setStatus((on ? '已標記待修正：' : '已取消標記：') + dispX(e).slice(0, 30));
  }

  // 條目上的按鈕（事件委派）
  box.addEventListener('click', (ev) => {
    const actEl = ev.target.closest('[data-act]');
    const entryEl = ev.target.closest('.cs-entry');
    if (!actEl || !entryEl || !box.contains(entryEl)) return;
    const e = entryById(Number(entryEl.dataset.id));
    if (!e) return;
    switch (actEl.dataset.act) {
      case 'edit': openEditor(e); break;
      case 'flag': toggleFlag(e); break;
      case 'revert':
      case 'adopt': revertEntry(e); break;
      case 'spk': renameSpeaker(e); break;
    }
  });
  // 在條目文字上按兩下也能修改
  historyEl.addEventListener('dblclick', (ev) => {
    if (ev.target.closest('.cs-editor, .cs-entry-head')) return;
    const entryEl = ev.target.closest('.cs-entry');
    if (entryEl) openEditor(entryById(Number(entryEl.dataset.id)));
  });

  // 滑鼠停在歷史區時暫停自動捲動；離開時若原本在底部就跟回最新
  let wasAtBottom = true;
  historyEl.addEventListener('mouseenter', () => { hoverHistory = true; wasAtBottom = nearBottom(); });
  historyEl.addEventListener('mouseleave', () => {
    hoverHistory = false;
    if (wasAtBottom && editingId === null) historyEl.scrollTop = historyEl.scrollHeight;
  });

  // 鍵盤：在面板的輸入框打字時，攔下鍵盤事件不讓頁面收到，
  // 避免觸發 Teams 等平台的快捷鍵（例如靜音、舉手）。
  // 在 window 的 capture 階段處理：最早收到，Enter / Esc 等也在這裡直接處理。
  function onKeyCapture(ev) {
    const t = ev.target;
    if (!(t instanceof Element) || !box.contains(t) || !t.matches('textarea, input')) return;
    ev.stopPropagation();
    if (ev.type !== 'keydown') return;
    if (ev.isComposing || ev.keyCode === 229) return;   // 中文輸入法選字中：Enter 是確認選字，不是儲存
    if (t.classList.contains('cs-spk-input')) {
      if (ev.key === 'Enter') { ev.preventDefault(); spkEditing && spkEditing.finish(true); }
      else if (ev.key === 'Escape') { ev.preventDefault(); spkEditing && spkEditing.finish(false); }
      return;
    }
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); closeEditor(true); }
    else if (ev.key === 'Escape') { ev.preventDefault(); closeEditor(false); }
    else if (ev.altKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) {
      ev.preventDefault();
      moveEditor(ev.key === 'ArrowUp' ? -1 : 1);
    }
  }
  for (const type of ['keydown', 'keypress', 'keyup']) window.addEventListener(type, onKeyCapture, true);

  // ================= 手動框選字幕區域 =================
  let picking = false;

  function cssPath(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let cur = el;
    while (cur && cur !== document.documentElement && parts.length < 8) {
      let part = cur.tagName.toLowerCase();
      const cls = [...cur.classList].slice(0, 2).map((c) => '.' + CSS.escape(c)).join('');
      if (cls) part += cls;
      const parent = cur.parentElement;
      if (parent) {
        const idx = [...parent.children].indexOf(cur) + 1;
        part += ':nth-child(' + idx + ')';
      }
      parts.unshift(part);
      if (cur.id) { parts[0] = '#' + CSS.escape(cur.id); break; }
      cur = parent;
      if (cur === document.body) { parts.unshift('body'); break; }
    }
    return parts.join(' > ');
  }

  function startPick() {
    if (picking) return;
    picking = true;
    const hi = document.createElement('div');
    hi.style.cssText =
      'position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #e0245e;' +
      'background:rgba(224,36,94,.10);border-radius:4px;transition:all .05s;';
    const tip = document.createElement('div');
    tip.textContent = '移動滑鼠並點選「字幕所在的區塊」（按 Esc 取消）';
    tip.style.cssText =
      'position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
      'background:#222;color:#fff;padding:8px 16px;border-radius:8px;' +
      'font:14px/1.4 system-ui,sans-serif;box-shadow:0 2px 10px rgba(0,0,0,.3);';
    document.documentElement.appendChild(hi);
    document.documentElement.appendChild(tip);

    const move = (e) => {
      const el = e.target;
      if (!el || el === hi || el === tip || box.contains(el)) return;
      const r = el.getBoundingClientRect();
      hi.style.left = r.left + 'px';
      hi.style.top = r.top + 'px';
      hi.style.width = r.width + 'px';
      hi.style.height = r.height + 'px';
    };
    const click = (e) => {
      if (box.contains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      finish(e.target);
    };
    const key = (e) => { if (e.key === 'Escape') finish(null); };

    function finish(el) {
      picking = false;
      document.removeEventListener('mousemove', move, true);
      document.removeEventListener('click', click, true);
      document.removeEventListener('keydown', key, true);
      hi.remove();
      tip.remove();
      if (el) {
        pickedSelector = cssPath(el);
        chrome.storage.local.set({ [SEL_KEY]: pickedSelector });
        setStatus('已選取字幕區域 ✔ 之後這個網站都會優先用這個區域');
      }
    }

    document.addEventListener('mousemove', move, true);
    document.addEventListener('click', click, true);
    document.addEventListener('keydown', key, true);
  }

  // ================= 初始化與訊息 =================
  let recHasData = false;
  let recRecording = false;
  function applyRecState() {
    audioBtn.classList.toggle('cs-btn-dim', !recHasData);
    audioBtn.classList.toggle('cs-btn-rec', recRecording);
    audioBtn.title = recRecording
      ? '錄音中：下載目前為止的錄音 (MP3)，錄音會繼續'
      : recHasData ? '下載錄音 (MP3)' : '尚無錄音（在 popup 勾選「錄音」即可開始）';
  }

  chrome.storage.local.get(['cs_entries', 'cs_capturing', 'cs_translate', 'cs_recActive', 'cs_recording', 'cs_iconStyle', 'cs_edits', 'cs_spkMap', 'cs_mdShowOrig', SEL_KEY], (res) => {
    pickedSelector = res[SEL_KEY] || null;
    applyIconStyle(res.cs_iconStyle);
    mdShowOrig = !!res.cs_mdShowOrig;
    edits = res.cs_edits && typeof res.cs_edits === 'object' ? res.cs_edits : {};
    spkMap = res.cs_spkMap && typeof res.cs_spkMap === 'object' ? res.cs_spkMap : {};
    translateOn = res.cs_translate !== false;   // 預設開
    recHasData = !!res.cs_recActive;
    recRecording = !!res.cs_recording;
    applyRecState();
    const saved = Array.isArray(res.cs_entries) ? res.cs_entries : [];
    for (const s of saved) {
      const e = { ...s, sentText: '', el: null, inHistory: true };
      if (e.state === 'sent') e.state = 'live'; // 重載時把送出中的重新排隊
      if (e.state === 'done') e.zhFor = e.x;    // 已定稿的譯文對應最終原文，避免重翻
      if (e.s) knownSpeakers.add(e.s);          // 歷史講者名 → 名字塊辨識依據
      entries.push(e);
      renderEntry(e);
    }
    nextId = entries.reduce((m, e) => Math.max(m, e.id || 0), 0) + 1;
    // 丟掉對不到任何條目的修改（例如舊資料）
    for (const id of Object.keys(edits)) if (!entryById(Number(id))) delete edits[id];
    updateFlagUI();
    // 预设为关闭：用户需要手动点击开始按钮才启动
    // if (res.cs_capturing) startCapture();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.cs_translate) {
      translateOn = changes.cs_translate.newValue !== false;
      if (capturing) titleEl.textContent = TITLE + (translateOn ? ' 記錄中…' : ' 記錄中（翻譯關閉）');
    }
    if (changes.cs_recActive) recHasData = !!changes.cs_recActive.newValue;
    if (changes.cs_recording) recRecording = !!changes.cs_recording.newValue;
    if (changes.cs_recActive || changes.cs_recording) applyRecState();
    if (changes.cs_iconStyle) applyIconStyle(changes.cs_iconStyle.newValue);
    if (changes.cs_mdShowOrig) mdShowOrig = !!changes.cs_mdShowOrig.newValue;
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'REC_ERROR') {
      setStatus('⚠ ' + msg.error);
      sendResponse({ ok: true });
      return true;
    }
    switch (msg && msg.cmd) {
      case 'ping':
        sendResponse({ ok: true, capturing, host: HOST, picked: !!pickedSelector, count: entries.length });
        break;
      case 'start':
        chrome.storage.local.set({ cs_capturing: true });
        startCapture();
        sendResponse({ ok: true, capturing: true });
        break;
      case 'stop':
        chrome.storage.local.set({ cs_capturing: false });
        stopCapture();
        sendResponse({ ok: true, capturing: false });
        break;
      case 'showPanel':
        // 顯示面板、重置位置、隱藏浮動 icon、取消最小化
        box.style.display = '';
        box.style.left = '50%';
        box.style.top = 'initial';
        box.style.bottom = '40px';
        box.style.transform = 'translateX(-50%)';
        floatingIcon.style.display = 'none';
        isMinimized = false;
        sendResponse({ ok: true });
        break;
      case 'editLatest':   // 快捷鍵：修改最新一句
        editLatest();
        sendResponse({ ok: true });
        break;
      case 'flagLatest':   // 快捷鍵：標記最新一句待修正
        flagLatest();
        sendResponse({ ok: true });
        break;
      case 'pick':
        startPick();
        sendResponse({ ok: true });
        break;
      case 'clearPick':
        pickedSelector = null;
        chrome.storage.local.remove(SEL_KEY);
        setStatus('已清除框選，改用預設字幕位置');
        sendResponse({ ok: true });
        break;
      case 'clear':
        resetAll();
        sendResponse({ ok: true });
        break;
      case 'dumpDom': {
        // 除錯用：把可能的字幕容器結構匯出成 HTML 檔（給開發者調解析規則）
        const parts = [];
        const add = (label, el) => {
          if (!el) return;
          let html = el.outerHTML || '';
          if (html.length > 400000) html = html.slice(0, 400000) + '\n<!-- ...截斷... -->';
          parts.push(`\n\n<!-- ========== ${label} ========== -->\n` + html);
        };
        try {
          if (pickedSelector) add('手動框選 ' + pickedSelector, document.querySelector(pickedSelector));
          add('Teams closed-captions-renderer', document.querySelector('[data-tid="closed-captions-renderer"]'));
          const ccText = document.querySelector('[data-tid="closed-caption-text"]');
          if (ccText) add('Teams closed-caption-text 往上三層', ccText.parentElement?.parentElement?.parentElement || ccText);
          for (const sel of WEBEX_SELS) {
            const el = document.querySelector(sel);
            if (el) { add('Webex ' + sel + ' 往上兩層', el.parentElement?.parentElement || el); break; }
          }
          for (const r of document.querySelectorAll('div[role="region"][aria-label]')) {
            const label = r.getAttribute('aria-label') || '';
            if (/caption|字幕/i.test(label)) { add('Meet region: ' + label, r); break; }
          }
        } catch (err) {
          parts.push('<!-- dump error: ' + err.message + ' -->');
        }
        if (!parts.length) parts.push('<!-- 找不到任何已知的字幕容器；請先手動框選字幕區域再匯出一次 -->');
        const head = `<!-- Caption Scribe ${VER} DOM dump | ${location.hostname} | ${new Date().toISOString()} -->`;
        download(`caption-dom-dump-${fileStamp()}.html`, head + parts.join(''));
        sendResponse({ ok: true, found: parts.length });
        break;
      }
      default:
        sendResponse({ ok: false });
    }
    return true;
  });


  // 初始化完成，標記為已完成
  window.__csInitializing = false;
})();
