// Content script: finds the readable text on the page, highlights what's being read,
// and shows the floating player. The UI lives in a shadow root so page styles can't break it.
(() => {
  if (window.__readoutLoaded) return;
  window.__readoutLoaded = true;

  const BLOCK_SEL = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, figcaption, dd, dt, td, th';
  const HOVER_SEL = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, dd, figcaption';
  const SKIP_SEL = 'nav, header, footer, aside, script, style, noscript, form, button, select, textarea, [role=navigation], [role=banner], [role=contentinfo], [aria-hidden=true]';

  let settings = { ...Readout.DEFAULTS };
  chrome.storage.local.get('settings').then(r => { Object.assign(settings, r.settings); refreshFab(); });
  chrome.storage.onChanged.addListener(ch => {
    if (ch.settings) { Object.assign(settings, ch.settings.newValue); refreshFab(); if (ui) ui.rate.value = String(settings.rate); }
  });

  const session = { id: null, chunkEls: [], hl: [] };
  let playerState = null;

  // ---------------------------------------------------------------- text extraction
  const clean = t => t.replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  function isVisible(el) {
    if (!el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
  }

  // The element holding the main article: the candidate with the most paragraph text.
  function pickRoot() {
    let best = document.body, bestScore = 0;
    for (const c of document.querySelectorAll('article, main, [role=main], [itemprop=articleBody]')) {
      let score = 0;
      for (const p of c.querySelectorAll('p')) score += p.textContent.length;
      if (score > bestScore * 1.2 || (score >= bestScore * 0.8 && best.contains(c))) { best = c; bestScore = score; }
    }
    return bestScore > 300 ? best : document.body;
  }

  function collectBlocks(root) {
    const out = [];
    for (const el of root.querySelectorAll(BLOCK_SEL)) {
      if (el.querySelector(BLOCK_SEL)) continue; // take the innermost block
      const skip = el.closest(SKIP_SEL);
      if (skip && skip !== root && root.contains(skip)) continue;
      if (!isVisible(el)) continue;
      const text = clean(el.innerText || '');
      if (text.length < 2) continue;
      out.push({ el, text });
    }
    return out;
  }

  // Keep a heading with the paragraph after it and group short list items; split very long blocks.
  function buildChunks(blocks) {
    const chunks = [];
    for (const b of blocks) {
      const pieces = Readout.splitLong(b.text, 900);
      const last = chunks[chunks.length - 1];
      const heading = /^H\d$/.test(b.el.tagName);
      const piece = pieces[0];
      const canMerge = pieces.length === 1 && last?.mergeable && !heading &&
        (last.heading || (last.text.length < 100 && piece.length < 100)) &&
        last.text.length + piece.length < 500;
      if (canMerge) {
        last.text += '\n\n' + piece;
        last.els.push(b.el);
        last.heading = false;
      } else {
        for (const p of pieces) chunks.push({ text: p, els: [b.el], mergeable: pieces.length === 1, heading });
      }
    }
    return chunks;
  }

  const matches = (block, el) => block.el === el || block.el.contains(el) || el.contains(block.el);

  function readPage(fromEl) {
    let blocks = collectBlocks(pickRoot());
    if (fromEl && !blocks.some(b => matches(b, fromEl))) blocks = collectBlocks(document.body);
    const total = blocks.reduce((n, b) => n + b.text.length, 0);
    if (total < 200) {
      // Pages built from plain divs: read the visible text without paragraph highlighting.
      const text = clean(document.body.innerText || '');
      if (text.length < 20) return captureForOcr(null); // canvas-based pages (Google Docs, Kindle…)
      return play(Readout.chunkText(text).map(t => ({ text: t, els: [] })), 0);
    }
    const chunks = buildChunks(blocks);
    let start = 0;
    if (fromEl) {
      const i = blocks.findIndex(b => matches(b, fromEl));
      if (i >= 0) start = Math.max(0, chunks.findIndex(c => c.els.includes(blocks[i].el)));
    }
    play(chunks, start);
  }

  function readSelection() {
    const text = clean(String(getSelection() || ''));
    if (!text) return false;
    play(Readout.chunkText(text).map(t => ({ text: t, els: [] })), 0, 'Selection: ' + document.title);
    return true;
  }

  function play(chunks, start, title = document.title || location.hostname) {
    session.id = Math.random().toString(36).slice(2);
    session.chunkEls = chunks.map(c => c.els.filter(Boolean));
    clearHighlight();
    showPlayer({ title, status: 'Loading…', playing: true, index: start, count: chunks.length });
    chrome.runtime.sendMessage({ type: 'play', sessionId: session.id, title, chunks: chunks.map(c => c.text), start });
  }

  // ---------------------------------------------------------------- highlighting
  function injectPageStyle() {
    if (document.getElementById('readout-style')) return;
    const s = document.createElement('style');
    s.id = 'readout-style';
    s.textContent = `.readout-hl{background-color:rgba(255,214,79,.38)!important;box-shadow:0 0 0 3px rgba(255,214,79,.38)!important;border-radius:3px!important;transition:background-color .2s!important}`;
    (document.head || document.documentElement).append(s);
  }

  function clearHighlight() {
    session.hl.forEach(el => el.classList.remove('readout-hl'));
    session.hl = [];
  }

  function highlight(i) {
    const els = session.chunkEls[i] || [];
    if (els.length && els === session.hl) return;
    clearHighlight();
    if (!els.length) return;
    injectPageStyle();
    els.forEach(el => el.classList.add('readout-hl'));
    session.hl = els;
    if (settings.autoScroll) {
      const r = els[0].getBoundingClientRect();
      if (r.top < 60 || r.bottom > innerHeight - 160) els[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  // ---------------------------------------------------------------- floating UI
  let host = null, ui = null;

  const TEMPLATE = `
  <style>
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    [hidden] { display: none !important; }
    .fab { position: fixed; right: 18px; bottom: 18px; width: 48px; height: 48px; border-radius: 24px; border: none;
      background: #7c9cff; color: #0d1020; font-size: 22px; cursor: pointer; box-shadow: 0 6px 20px rgba(0,0,0,.3);
      display: grid; place-items: center; opacity: .85; transition: transform .15s, opacity .15s; }
    .fab:hover { opacity: 1; transform: scale(1.07); }
    .player { position: fixed; right: 18px; bottom: 18px; width: 340px; max-width: calc(100vw - 36px);
      background: #1d2029; color: #e9ebf1; border-radius: 16px; padding: 12px 14px 10px; box-shadow: 0 10px 34px rgba(0,0,0,.4);
      font-size: 13px; line-height: 1.4; }
    .top { display: flex; align-items: center; gap: 8px; }
    .title { flex: 1; font-weight: 600; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .x { background: none; border: none; color: #9aa1b2; font-size: 18px; cursor: pointer; padding: 0 4px; }
    .x:hover { color: #fff; }
    .status { color: #9aa1b2; margin: 2px 0 6px; min-height: 18px; }
    .status.error { color: #ff8c8c; }
    .bar { height: 4px; background: #323746; border-radius: 2px; overflow: hidden; margin-bottom: 8px; }
    .bar i { display: block; height: 100%; width: 0; background: #7c9cff; transition: width .3s; }
    .ctl { display: flex; align-items: center; justify-content: space-between; gap: 4px; }
    .ctl button { background: none; border: none; color: #e9ebf1; font-size: 15px; cursor: pointer; min-width: 36px; height: 36px; border-radius: 18px; }
    .ctl button:hover { background: #2c3140; }
    .ctl .play { background: #7c9cff; color: #0d1020; width: 44px; height: 44px; border-radius: 22px; font-size: 18px; }
    .ctl .play:hover { background: #93adff; }
    select { background: #262a35; color: #e9ebf1; border: 1px solid #323746; border-radius: 8px; padding: 4px 6px; font-size: 13px; }
    .here { position: fixed; width: 26px; height: 26px; border-radius: 13px; border: none; background: #7c9cff; color: #0d1020;
      font-size: 11px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.3); opacity: .9; display: grid; place-items: center; padding: 0; }
    .here:hover { opacity: 1; transform: scale(1.1); }
    .area { position: fixed; inset: 0; cursor: crosshair; background: rgba(10,12,20,.28); }
    .area .hint { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); background: #1d2029; color: #e9ebf1;
      padding: 8px 14px; border-radius: 10px; font-size: 14px; box-shadow: 0 4px 16px rgba(0,0,0,.3); pointer-events: none; }
    .rect { position: fixed; border: 2px solid #7c9cff; background: rgba(124,156,255,.12); pointer-events: none; }
  </style>
  <button class="fab" title="Read this page aloud (Alt+Shift+R)" hidden>🎧</button>
  <div class="player" hidden>
    <div class="top"><div class="title"></div><button class="x" title="Stop and close">✕</button></div>
    <div class="status"></div>
    <div class="bar"><i></i></div>
    <div class="ctl">
      <button data-a="prev" title="Previous paragraph">⏮</button>
      <button data-a="back" title="Back 15 seconds">↺15</button>
      <button class="play" data-a="toggle" title="Play / pause (Alt+Shift+P)">▶</button>
      <button data-a="fwd" title="Forward 15 seconds">15↻</button>
      <button data-a="next" title="Next paragraph">⏭</button>
      <select class="rate" title="Speed"></select>
    </div>
  </div>
  <button class="here" title="Read from here" hidden>▶</button>
  <div class="area" hidden><div class="hint">Drag to select the area to read · Esc to cancel</div></div>
  <div class="rect" hidden></div>`;

  function ensureUI() {
    if (ui) return;
    host = document.createElement('readout-ui');
    host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = TEMPLATE;
    document.documentElement.append(host);
    const q = s => root.querySelector(s);
    ui = { root, fab: q('.fab'), player: q('.player'), title: q('.title'), status: q('.status'), bar: q('.bar i'),
      play: q('.play'), rate: q('.rate'), here: q('.here'), area: q('.area'), rect: q('.rect') };

    ui.rate.innerHTML = Readout.RATES.map(r => `<option value="${r}">${r}×</option>`).join('');
    if (!Readout.RATES.includes(settings.rate)) ui.rate.insertAdjacentHTML('beforeend', `<option value="${settings.rate}">${settings.rate}×</option>`);
    ui.rate.value = String(settings.rate);
    ui.rate.onchange = () => send('control', { action: 'rate', value: parseFloat(ui.rate.value) });
    root.querySelectorAll('[data-a]').forEach(b => { b.onclick = () => send('control', { action: b.dataset.a }); });
    q('.x').onclick = () => { send('control', { action: 'stop' }); endSession(); };
    ui.fab.onclick = () => { if (!readSelection()) readPage(); };
    ui.here.onclick = () => { if (hoverEl) readPage(hoverEl); ui.here.hidden = true; };
  }

  const send = (type, extra = {}) => chrome.runtime.sendMessage({ type, ...extra }).catch(() => {});

  function refreshFab() {
    if (!settings.floatingButton && !ui) return;
    ensureUI();
    ui.fab.hidden = !settings.floatingButton || !ui.player.hidden;
  }

  function fmt(s) { return !isFinite(s) ? '0:00' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`; }

  function showPlayer(st) {
    ensureUI();
    playerState = st;
    ui.player.hidden = false;
    ui.fab.hidden = true;
    ui.title.textContent = st.title || 'Readout';
    let status = st.status;
    if (!status) status = `Paragraph ${Math.min(st.index + 1, st.count)} of ${st.count}` + (st.duration ? ` · ${fmt(st.time)} / ${fmt(st.duration)}` : '');
    ui.status.textContent = status;
    ui.status.classList.toggle('error', !!st.error);
    const frac = st.count ? (Math.min(st.index, st.count) + (st.duration ? st.time / st.duration : 0)) / st.count : 0;
    ui.bar.style.width = (Math.min(1, frac) * 100).toFixed(1) + '%';
    ui.play.textContent = st.playing ? '⏸' : '▶';
    if (st.rate || settings.rate) ui.rate.value = String(settings.rate);
  }

  function endSession() {
    clearHighlight();
    session.id = null;
    session.chunkEls = [];
    playerState = null;
    if (ui) { ui.player.hidden = true; ui.fab.hidden = !settings.floatingButton; }
  }

  function onProgress(st) {
    if (!st) return endSession();
    showPlayer(st);
    if (st.sessionId && st.sessionId === session.id) {
      if (st.done) clearHighlight(); else highlight(st.index);
    }
  }

  // ---------------------------------------------------------------- "read from here" buttons
  let hoverEl = null;
  function placeHere() {
    if (!hoverEl || !ui) return;
    const r = hoverEl.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) { ui.here.hidden = true; return; }
    ui.here.style.top = Math.max(4, r.top + 2) + 'px';
    ui.here.style.left = Math.max(4, r.left - 32) + 'px';
    ui.here.hidden = false;
  }
  document.addEventListener('mouseover', e => {
    if (!settings.hoverButtons) return;
    const el = e.target.closest?.(HOVER_SEL);
    if (!el || el === hoverEl || el.isContentEditable || el.closest('[contenteditable=""], [contenteditable=true]')) return;
    const len = (el.innerText || '').trim().length;
    if (len < 40 && !/^H\d$/.test(el.tagName)) return;
    hoverEl = el;
    ensureUI();
    placeHere();
  }, { passive: true });
  addEventListener('scroll', () => { if (hoverEl && ui && !ui.here.hidden) placeHere(); }, { passive: true, capture: true });

  // ---------------------------------------------------------------- screen area → text
  function selectArea() {
    ensureUI();
    const { area, rect } = ui;
    area.hidden = false;
    let sx = 0, sy = 0, dragging = false, box = null;
    const setRect = (x, y, w, h) => { Object.assign(rect.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' }); rect.hidden = false; box = { x, y, w, h }; };
    const finish = () => { area.hidden = true; rect.hidden = true; area.onmousedown = area.onmousemove = area.onmouseup = null; removeEventListener('keydown', onKey, true); };
    const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); finish(); } };
    addEventListener('keydown', onKey, true);
    area.onmousedown = e => { dragging = true; sx = e.clientX; sy = e.clientY; setRect(sx, sy, 0, 0); e.preventDefault(); };
    area.onmousemove = e => { if (dragging) setRect(Math.min(sx, e.clientX), Math.min(sy, e.clientY), Math.abs(e.clientX - sx), Math.abs(e.clientY - sy)); };
    area.onmouseup = () => {
      dragging = false;
      finish();
      if (box && box.w > 8 && box.h > 8) captureForOcr(box);
    };
  }

  // Hide our UI, let the page repaint, then ask the background to screenshot the tab.
  async function captureForOcr(rect) {
    ensureUI();
    session.id = null;
    clearHighlight();
    host.style.visibility = 'hidden';
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise(r => setTimeout(r, 60));
    try {
      await chrome.runtime.sendMessage({ type: 'ocr', rect, vw: innerWidth, title: document.title || 'Screen text' });
    } finally {
      host.style.visibility = '';
    }
  }

  // ---------------------------------------------------------------- messages
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      case 'readPage': readPage(); break;
      case 'readSelectionOrPage': if (!readSelection()) readPage(); break;
      case 'selectArea': selectArea(); break;
      case 'progress': onProgress(msg.state); break;
      case 'sessionGone': endSession(); break;
      default: return;
    }
    sendResponse({ ok: true });
  });

  // If this tab is the one being read (e.g. after navigating), show the player again.
  send('getState').then(res => { if (res?.state) onProgress(res.state); });
})();
