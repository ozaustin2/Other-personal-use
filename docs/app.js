'use strict';
/* Readout: a personal Speechify-style reader that uses the OpenAI API.
 * Everything runs in the browser. The API key and library stay on this device. */

const $ = (sel, el = document) => el.querySelector(sel);
const API = 'https://api.openai.com/v1';
const PAUSE_RE = /^\[pause\s+(\d+(?:\.\d+)?)\s*s?\]$/i;

const VOICES = ['alloy', 'ash', 'ballad', 'cedar', 'coral', 'echo', 'fable', 'marin', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];
const TTS1_VOICES = ['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'];
const STYLE_PRESETS = {
  'Audiobook': 'Read clearly and naturally, like an engaging audiobook narrator. Keep a steady, moderate pace and pause briefly between paragraphs.',
  'Lecturer': 'Speak like a clear, warm university lecturer. Emphasize key terms and definitions, and pause slightly after important points.',
  'Workout coach': 'Speak with upbeat, energetic, motivating delivery, but keep every word crisp and easy to follow.',
  'Calm': 'Speak in a calm, relaxed, even tone at a gentle pace.',
};
const RATES = [0.75, 1, 1.1, 1.2, 1.25, 1.3, 1.4, 1.5, 1.75, 2, 2.25, 2.5, 3];

// ---------------------------------------------------------------- settings
const DEFAULTS = {
  apiKey: '',
  voice: 'nova',
  ttsModel: 'gpt-4o-mini-tts',
  instructions: STYLE_PRESETS.Audiobook,
  rate: 1,
  textModel: 'gpt-4.1-mini',
  describeVisuals: true,
};
let settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem('readout.settings') || '{}')); } catch {}
function saveSettings() {
  try { localStorage.setItem('readout.settings', JSON.stringify(settings)); } catch {}
}

// ---------------------------------------------------------------- storage (IndexedDB)
const db = (() => {
  let opening;
  const open = () => opening ||= new Promise((resolve, reject) => {
    const req = indexedDB.open('readout', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('docs', { keyPath: 'id' });
      req.result.createObjectStore('audio');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  async function run(store, mode, fn) {
    const d = await open();
    return new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => resolve(req && req.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }
  return {
    get: (store, key) => run(store, 'readonly', s => s.get(key)),
    put: (store, value, key) => run(store, 'readwrite', s => key === undefined ? s.put(value) : s.put(value, key)),
    del: (store, key) => run(store, 'readwrite', s => s.delete(key)),
    all: store => run(store, 'readonly', s => s.getAll()),
    count: store => run(store, 'readonly', s => s.count()),
    clear: store => run(store, 'readwrite', s => s.clear()),
  };
})();

// ---------------------------------------------------------------- small helpers
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmtTime = s => !isFinite(s) ? '0:00' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

async function sha(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
}

let toastTimer;
function toast(msg, isError = false, ms = 3500) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, isError ? Math.max(ms, 7000) : ms);
}

// Busy overlay with cancel support. Returns an AbortSignal.
const busy = {
  ctrl: null,
  start(msg) {
    this.ctrl = new AbortController();
    $('#busy-msg').textContent = msg;
    $('#busy').hidden = false;
    return this.ctrl.signal;
  },
  update(msg) { $('#busy-msg').textContent = msg; },
  end() { $('#busy').hidden = true; this.ctrl = null; },
};

function checkAborted(signal) {
  if (signal && signal.aborted) throw new DOMException('Cancelled', 'AbortError');
}

// ---------------------------------------------------------------- OpenAI API
async function api(path, body, signal) {
  if (!settings.apiKey) {
    location.hash = '#/settings';
    throw new Error('Add your OpenAI API key in Settings first.');
  }
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API + path, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + settings.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (res.ok) return res;
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await sleep(1500 * 2 ** attempt);
      continue;
    }
    let msg = `${res.status} ${res.statusText}`;
    try { const j = await res.json(); msg = j.error?.message || msg; } catch {}
    throw new Error('OpenAI: ' + msg);
  }
}

async function chat(messages, signal) {
  const res = await api('/chat/completions', { model: settings.textModel, messages }, signal);
  const j = await res.json();
  return (j.choices?.[0]?.message?.content || '').trim();
}

function ttsBody(text) {
  const body = { model: settings.ttsModel, voice: settings.voice, input: text, response_format: 'mp3' };
  if (settings.ttsModel.startsWith('gpt-') && settings.instructions.trim()) body.instructions = settings.instructions.trim();
  return body;
}

// Audio is cached by a hash of (model, voice, style, text), so replays are free and work offline.
const inflight = new Map();
async function getChunkAudio(text, signal) {
  const pause = text.match(PAUSE_RE);
  if (pause) return silenceWav(clamp(parseFloat(pause[1]), 0.5, 60));
  const body = ttsBody(text);
  const key = await sha(JSON.stringify([body.model, body.voice, body.instructions || '', text]));
  const cached = await db.get('audio', key);
  if (cached) return cached;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const res = await api('/audio/speech', body, signal);
    const blob = await res.blob();
    await db.put('audio', blob, key);
    return blob;
  })();
  inflight.set(key, p);
  try { return await p; } finally { inflight.delete(key); }
}

function silenceWav(seconds) {
  const rate = 8000, n = Math.round(rate * seconds);
  const buf = new ArrayBuffer(44 + n), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  w(36, 'data'); v.setUint32(40, n, true);
  new Uint8Array(buf, 44).fill(128);
  return new Blob([buf], { type: 'audio/wav' });
}

// ---------------------------------------------------------------- text processing
// Split text into sections for TTS. The first one is short so playback starts quickly.
function chunkText(text) {
  const normalized = text.replace(/\r/g, '')
    .replace(/(\w)-\n(\w)/g, '$1$2')
    .replace(/\s*(\[pause\s+\d+(?:\.\d+)?\s*s?\])\s*/gi, '\n\n$1\n\n');
  const paras = normalized.split(/\n\s*\n+/).map(p => p.replace(/[ \t]*\n[ \t]*/g, ' ').replace(/[ \t]+/g, ' ').trim()).filter(Boolean);
  const chunks = [];
  let cur = '';
  const limit = () => (chunks.length === 0 ? 350 : 1500);
  const flush = () => { if (cur.trim()) chunks.push(cur.trim()); cur = ''; };

  for (const para of paras) {
    if (PAUSE_RE.test(para)) { flush(); chunks.push(para); continue; }
    const pieces = [];
    for (let s of para.split(/(?<=[.!?…]["'”’)\]]*)\s+/)) {
      while (s.length > 1500) {
        let cut = s.lastIndexOf(' ', 1500);
        if (cut < 200) cut = 1500;
        pieces.push(s.slice(0, cut));
        s = s.slice(cut).trim();
      }
      if (s) pieces.push(s);
    }
    pieces.forEach((piece, idx) => {
      const sep = cur ? (idx === 0 ? '\n\n' : ' ') : '';
      if (cur && cur.length + sep.length + piece.length > limit()) flush();
      cur += (cur ? sep : '') + piece;
    });
    if (cur.length > limit() * 0.7) flush();
  }
  flush();
  return chunks;
}

// Model output is meant to be heard, so strip markdown that would be read aloud.
function forListening(text) {
  return text
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(^|\s)\*(\S.+?)\*/g, '$1$2')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/`/g, '')
    .trim();
}

function guessTitle(text) {
  const line = text.trim().split('\n').find(l => l.trim()) || 'Untitled';
  const t = line.trim().replace(/\s+/g, ' ');
  return t.length > 60 ? t.slice(0, 57) + '…' : t;
}

// ---------------------------------------------------------------- images → text (OCR via OpenAI vision)
async function imageToDataUrl(blob, maxSide = 2048) {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  return canvas.toDataURL('image/jpeg', 0.85);
}

async function ocrImage(blob, signal) {
  const url = await imageToDataUrl(blob);
  const prompt = [
    'Transcribe the readable text in this image (a book page, document, or screenshot) so it can be read aloud by text-to-speech.',
    'Rules: keep the original wording exactly; keep headings and paragraphs in reading order; join lines that belong to the same paragraph; fix words hyphenated across line breaks;',
    'skip page numbers, running headers/footers, app/browser interface elements, and ads.',
    settings.describeVisuals
      ? 'If there are equations, write them the way a person would say them aloud. If there is a figure, chart, or table, add a short spoken-style description in square brackets.'
      : 'Ignore figures and images.',
    'Output only the transcribed text, no commentary. If there is no readable text, output nothing.',
  ].join(' ');
  return chat([{ role: 'user', content: [
    { type: 'text', text: prompt },
    { type: 'image_url', image_url: { url, detail: 'high' } },
  ] }], signal);
}

async function imagesToText(files, signal) {
  const parts = [];
  for (let i = 0; i < files.length; i++) {
    checkAborted(signal);
    busy.update(`Reading image ${i + 1} of ${files.length}…`);
    parts.push(await ocrImage(files[i], signal));
  }
  return parts.filter(Boolean).join('\n\n');
}

// ---------------------------------------------------------------- PDFs
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('Could not load ' + src));
    document.head.append(s);
  });
}
async function pdfjs() {
  if (!window.pdfjsLib) {
    const base = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
    await loadScript(base + 'pdf.min.js');
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = base + 'pdf.worker.min.js';
  }
  return window.pdfjsLib;
}
function parseRange(str, max) {
  const pages = new Set();
  for (const part of (str || '').split(',')) {
    const m = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) continue;
    const a = clamp(+m[1], 1, max), b = clamp(+(m[2] || m[1]), 1, max);
    for (let p = Math.min(a, b); p <= Math.max(a, b); p++) pages.add(p);
  }
  return [...pages].sort((x, y) => x - y);
}
async function pdfToText(file, signal) {
  busy.update('Opening PDF…');
  const lib = await pdfjs();
  const pdf = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
  const n = pdf.numPages;
  let pages = [...Array(n)].map((_, i) => i + 1);
  if (n > 1) {
    const answer = prompt(`"${file.name}" has ${n} pages. Which pages do you want? (e.g. 12-30 or 1,3,5)`, `1-${n}`);
    if (answer === null) throw new DOMException('Cancelled', 'AbortError');
    pages = parseRange(answer, n);
  }
  const out = [];
  for (const [idx, p] of pages.entries()) {
    checkAborted(signal);
    busy.update(`Reading page ${p} (${idx + 1} of ${pages.length})…`);
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    let text = tc.items.map(it => it.str + (it.hasEOL ? '\n' : '')).join('');
    if (text.replace(/\s/g, '').length < 25) {
      // Scanned page with no text layer: render it and OCR it.
      const vp = page.getViewport({ scale: 2 });
      const canvas = document.createElement('canvas');
      canvas.width = vp.width; canvas.height = vp.height;
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
      text = await ocrImage(blob, signal);
    }
    out.push(text.trim());
  }
  return out.filter(Boolean).join('\n\n');
}

// ---------------------------------------------------------------- importing
const isImage = f => f.type.startsWith('image/');
const isPdf = f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

async function importFiles(files, extraText = '') {
  files = [...files];
  if (!files.length && !extraText.trim()) return;
  const signal = busy.start('Working…');
  try {
    const parts = [];
    if (extraText.trim()) parts.push(extraText.trim());
    const images = files.filter(isImage);
    if (images.length) parts.push(await imagesToText(images, signal));
    for (const f of files.filter(f => !isImage(f))) {
      checkAborted(signal);
      if (isPdf(f)) parts.push(await pdfToText(f, signal));
      else parts.push(await f.text());
    }
    const text = parts.filter(Boolean).join('\n\n');
    busy.end();
    if (!text.trim()) { toast('No readable text found.', true); return; }
    const nonImage = files.find(f => !isImage(f));
    openEditor(null, { text, title: nonImage ? nonImage.name.replace(/\.\w+$/, '') : guessTitle(text) });
  } catch (e) {
    busy.end();
    if (e.name !== 'AbortError') toast(e.message, true);
  }
}

async function pasteFromClipboard() {
  try {
    if (navigator.clipboard?.read) {
      const items = await navigator.clipboard.read();
      const images = [];
      let text = '';
      for (const item of items) {
        const imgType = item.types.find(t => t.startsWith('image/'));
        if (imgType) images.push(new File([await item.getType(imgType)], 'clipboard.png', { type: imgType }));
        else if (item.types.includes('text/plain')) text += await (await item.getType('text/plain')).text();
      }
      if (images.length) return importFiles(images);
      if (text.trim()) return openEditor(null, { text, title: guessTitle(text) });
    } else {
      const text = await navigator.clipboard.readText();
      if (text.trim()) return openEditor(null, { text, title: guessTitle(text) });
    }
    toast('Clipboard is empty.');
  } catch {
    // Permission denied or unsupported: fall back to an empty editor to paste into manually.
    openEditor(null, { text: '', title: '' });
    toast('Press and hold (or Ctrl+V) in the text box to paste.');
  }
}

// Files shared to the app through Android's share sheet are parked in a cache by sw.js.
async function checkShareInbox() {
  if (!('caches' in window)) return;
  const cache = await caches.open('share-inbox');
  const keys = await cache.keys();
  if (!keys.length) return;
  let text = '';
  const files = [];
  for (const req of keys) {
    const res = await cache.match(req);
    if (res.headers.get('x-kind') === 'text') text += (await res.text()) + '\n\n';
    else {
      const blob = await res.blob();
      files.push(new File([blob], decodeURIComponent(res.headers.get('x-name') || 'shared'), { type: blob.type }));
    }
    await cache.delete(req);
  }
  history.replaceState(null, '', location.pathname + '#/library');
  text = text.trim();
  if (files.length) await importFiles(files, text);
  else if (text.trim()) openEditor(null, { text, title: guessTitle(text) });
}

// ---------------------------------------------------------------- documents
function newDoc(title, text) {
  const now = Date.now();
  return { id: uid(), title: title || guessTitle(text), text, chunks: chunkText(text), pos: { i: 0, t: 0 }, createdAt: now, updatedAt: now };
}

async function saveDoc(doc) {
  doc.updatedAt = Date.now();
  await db.put('docs', doc);
}

// ---------------------------------------------------------------- views / routing
const views = ['library', 'editor', 'reader', 'settings'];
let editing = null; // { id|null, draft }
let viewingDoc = null;

function show(name) {
  for (const v of views) $('#view-' + v).hidden = v !== name;
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === name));
  window.scrollTo(0, 0);
}

async function route() {
  const [, view, id] = (location.hash || '#/library').split('/');
  if (view === 'doc' && id) {
    const doc = await db.get('docs', id);
    if (!doc) { location.hash = '#/library'; return; }
    viewingDoc = doc;
    renderReader(doc);
    show('reader');
    highlight(player.doc?.id === doc.id ? player.index : -1, player.index > 0);
  } else if (view === 'edit') {
    if (!editing) { location.hash = '#/library'; return; }
    show('editor');
  } else if (view === 'settings') {
    renderSettings();
    show('settings');
  } else {
    await renderLibrary();
    show('library');
  }
}

// ---- library
async function renderLibrary() {
  $('#no-key-banner').hidden = !!settings.apiKey;
  const docs = (await db.all('docs')).sort((a, b) => b.updatedAt - a.updatedAt);
  const list = $('#doc-list');
  list.innerHTML = '';
  $('#empty-lib').hidden = docs.length > 0;
  for (const doc of docs) {
    const pct = doc.chunks.length ? Math.min(100, Math.round((doc.pos.i / doc.chunks.length) * 100)) : 0;
    const li = document.createElement('li');
    li.className = 'doc-item';
    li.innerHTML = `
      <div class="doc-main">
        <div class="doc-title"></div>
        <div class="doc-sub">${doc.text.length.toLocaleString()} characters · ${pct}% listened</div>
        <div class="bar"><i style="width:${pct}%"></i></div>
      </div>
      <button class="icon-btn" data-act="play" title="Listen">▶</button>
      <button class="icon-btn" data-act="del" title="Delete">🗑</button>`;
    $('.doc-title', li).textContent = doc.title;
    $('.doc-main', li).onclick = () => { location.hash = '#/doc/' + doc.id; };
    $('[data-act=play]', li).onclick = () => { location.hash = '#/doc/' + doc.id; startDoc(doc); };
    $('[data-act=del]', li).onclick = async () => {
      if (!confirm(`Delete "${doc.title}"?`)) return;
      if (player.doc?.id === doc.id) closePlayer();
      await db.del('docs', doc.id);
      renderLibrary();
    };
    list.append(li);
  }
}

// ---- editor
function openEditor(doc, draft) {
  editing = { id: doc ? doc.id : null };
  $('#ed-title').value = doc ? doc.title : (draft?.title || '');
  $('#ed-text').value = doc ? doc.text : (draft?.text || '');
  updateCount();
  if (location.hash === '#/edit') route(); else location.hash = '#/edit';
}
function updateCount() {
  const n = $('#ed-text').value.length;
  $('#ed-count').textContent = `${n.toLocaleString()} characters`;
}
async function saveEditor() {
  const text = $('#ed-text').value;
  if (!text.trim()) { toast('There is no text to save.', true); return null; }
  const title = $('#ed-title').value.trim() || guessTitle(text);
  let doc = editing?.id ? await db.get('docs', editing.id) : null;
  if (doc) {
    if (doc.text !== text) {
      doc.text = text;
      doc.chunks = chunkText(text);
      doc.pos = { i: 0, t: 0 };
      if (player.doc?.id === doc.id) closePlayer();
    }
    doc.title = title;
  } else {
    doc = newDoc(title, text);
  }
  await saveDoc(doc);
  editing = null;
  return doc;
}

async function cleanupText() {
  const text = $('#ed-text').value;
  if (!text.trim()) return;
  const signal = busy.start('Cleaning up text…');
  try {
    const pieces = [];
    const paras = text.split(/\n\s*\n/);
    let cur = '';
    for (const p of paras) {
      if (cur && cur.length + p.length > 8000) { pieces.push(cur); cur = ''; }
      cur += (cur ? '\n\n' : '') + p;
    }
    if (cur) pieces.push(cur);
    const out = [];
    for (let i = 0; i < pieces.length; i++) {
      busy.update(`Cleaning up text (part ${i + 1} of ${pieces.length})…`);
      out.push(await chat([
        { role: 'system', content: 'You prepare text to be read aloud by text-to-speech. Fix OCR and extraction errors, rejoin words split by hyphens or line breaks, merge broken lines into paragraphs, and remove page numbers, running headers/footers, figure placeholders, and bracketed citation numbers. Do NOT summarize, shorten, or reword. Output only the cleaned text.' },
        { role: 'user', content: pieces[i] },
      ], signal));
    }
    $('#ed-text').value = out.join('\n\n');
    updateCount();
    toast('Text cleaned up. Review it, then save.');
  } catch (e) {
    if (e.name !== 'AbortError') toast(e.message, true);
  } finally { busy.end(); }
}

// ---- reader
function renderReader(doc) {
  $('#rd-title').textContent = doc.title;
  const mins = Math.round(doc.text.split(/\s+/).length / 155 / (settings.rate || 1));
  $('#rd-meta').textContent = `${doc.chunks.length} sections · about ${mins} min at ${settings.rate}× · tap any paragraph to start from there`;
  const box = $('#rd-text');
  box.innerHTML = '';
  doc.chunks.forEach((c, i) => {
    const el = document.createElement('div');
    const pause = c.match(PAUSE_RE);
    el.className = 'chunk' + (pause ? ' pause' : '');
    el.dataset.i = i;
    el.textContent = pause ? `(${pause[1]} second pause to think)` : c;
    box.append(el);
  });
}

function highlight(i, scroll = true) {
  const box = $('#rd-text');
  box.querySelectorAll('.chunk.current').forEach(el => el.classList.remove('current'));
  if (!viewingDoc || viewingDoc.id !== player.doc?.id || i < 0) return;
  const el = box.querySelector(`.chunk[data-i="${i}"]`);
  if (!el) return;
  el.classList.add('current');
  if (scroll && !$('#view-reader').hidden && document.visibilityState === 'visible') {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

// ---- study tools
const STUDY = {
  summary: {
    label: 'Summary',
    prompt: 'Write a study summary of the material below, designed to be LISTENED to (it will be read aloud by text-to-speech). Cover the main ideas, key definitions, and how the concepts connect, in the order they appear. Use short spoken-style paragraphs with clear verbal transitions ("First...", "The key idea here is..."). No markdown, bullet symbols, or tables. Finish with a short recap of the 3 to 5 most important takeaways.',
  },
  quiz: {
    label: 'Quiz',
    prompt: 'Create an AUDIO quiz from the material below for someone studying while working out. Write 10 to 15 questions that test understanding of the most important concepts (mix recall, "why", and application questions). Format each exactly like this, with blank lines between:\n\nQuestion 1. <question>\n\n[pause 6]\n\nAnswer: <a concise answer in one to three sentences>\n\nThe "[pause 6]" line must appear on its own line. No markdown. Start with one sentence saying what the quiz covers.',
  },
  explain: {
    label: 'Explained',
    prompt: 'Act as a friendly, expert tutor. Re-teach the material below as a spoken mini-lecture, meant to be listened to. Explain each concept in plain language, give a concrete example or analogy for the hard parts, and point out common misconceptions. Keep everything accurate to the source. No markdown, bullet symbols, or tables.',
  },
  terms: {
    label: 'Key terms',
    prompt: 'List the key terms, names, and concepts from the material below as spoken flashcards. For each one write: the term on its own paragraph, then a line with only "[pause 3]", then a paragraph with a clear one or two sentence definition and, if useful, a quick example. No markdown or numbering symbols.',
  },
};

async function runStudy(kind) {
  const doc = viewingDoc;
  if (!doc) return;
  const tool = STUDY[kind];
  let source = doc.text;
  if (source.length > 120000) {
    source = source.slice(0, 120000);
    toast('This document is very long, so only the first part was used.');
  }
  const signal = busy.start(`Creating ${tool.label.toLowerCase()}…`);
  try {
    const out = await chat([
      { role: 'system', content: 'You create study materials that will be converted to speech. Write plain text only.' },
      { role: 'user', content: `${tool.prompt}\n\n---\nTITLE: ${doc.title}\n\n${source}` },
    ], signal);
    const created = newDoc(`${tool.label}: ${doc.title}`, forListening(out));
    await saveDoc(created);
    busy.end();
    location.hash = '#/doc/' + created.id;
    toast(`${tool.label} created. Tap Listen to start.`);
  } catch (e) {
    busy.end();
    if (e.name !== 'AbortError') toast(e.message, true);
  }
}

async function prepareOffline(doc) {
  const signal = busy.start('Generating audio…');
  let done = 0;
  const total = doc.chunks.length;
  try {
    let next = 0;
    const worker = async () => {
      while (next < total) {
        checkAborted(signal);
        const i = next++;
        await getChunkAudio(doc.chunks[i], signal);
        busy.update(`Generating audio: ${++done} of ${total} sections…`);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    return true;
  } catch (e) {
    if (e.name !== 'AbortError') toast(e.message, true);
    return false;
  } finally { busy.end(); }
}

async function exportMp3(doc) {
  if (!(await prepareOffline(doc))) return;
  const blobs = [];
  for (const c of doc.chunks) if (!PAUSE_RE.test(c)) blobs.push(await getChunkAudio(c));
  const file = new Blob(blobs, { type: 'audio/mpeg' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = doc.title.replace(/[\\/:*?"<>|]+/g, '').slice(0, 80) + '.mp3';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}

// ---------------------------------------------------------------- player
const audio = $('#audio');
const player = { doc: null, index: 0, loaded: -1, resumeAt: 0, token: 0, url: null, lastSave: 0 };

function setDoc(doc) {
  if (player.doc?.id === doc.id) { player.doc = doc; return; }
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  player.doc = doc;
  const done = (doc.pos?.i || 0) >= doc.chunks.length;
  player.index = done ? 0 : Math.max(0, doc.pos?.i || 0);
  player.resumeAt = done ? 0 : doc.pos?.t || 0;
  player.loaded = -1;
  $('#player').hidden = false;
  $('#p-title').textContent = doc.title;
  $('#p-title').href = '#/doc/' + doc.id;
  updateBar();
  updateMetadata();
}

function startDoc(doc) {
  setDoc(doc);
  if (player.loaded === player.index) audio.play().catch(() => {});
  else togglePlay();
}

function closePlayer() {
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  player.doc = null;
  player.loaded = -1;
  $('#player').hidden = true;
  highlight(-1);
}

function setStatus(msg, isError = false) {
  const el = $('#p-status');
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

async function loadChunk(i, startAt = 0, autoplay = true) {
  const doc = player.doc;
  if (!doc) return;
  if (i >= doc.chunks.length) { finished(); return; }
  i = Math.max(0, i);
  const token = ++player.token;
  player.index = i;
  highlight(i);
  updateBar();
  setStatus('Loading…');
  let blob;
  try {
    blob = await getChunkAudio(doc.chunks[i]);
  } catch (e) {
    if (token === player.token) { setStatus(e.message, true); updatePlayButton(); }
    return;
  }
  if (token !== player.token) return;
  if (player.url) URL.revokeObjectURL(player.url);
  player.url = URL.createObjectURL(blob);
  audio.src = player.url;
  audio.defaultPlaybackRate = settings.rate;
  audio.playbackRate = settings.rate;
  if (startAt > 0) audio.currentTime = startAt;
  player.loaded = i;
  player.resumeAt = 0;
  updateMetadata();
  if (autoplay) {
    try { await audio.play(); } catch (e) { if (e.name !== 'AbortError') setStatus('Tap ▶ to play'); }
  }
  savePosition(true);
  // Fetch upcoming sections now so they're ready (important when the screen is off).
  for (const j of [i + 1, i + 2]) {
    if (j < doc.chunks.length) getChunkAudio(doc.chunks[j]).catch(() => {});
  }
}

function finished() {
  player.index = player.doc.chunks.length;
  player.loaded = -1;
  savePosition(true);
  setStatus('Finished');
  updatePlayButton();
  toast('Finished reading 🎉');
}

function togglePlay() {
  if (!player.doc) return;
  if (player.index >= player.doc.chunks.length) loadChunk(0);
  else if (player.loaded !== player.index) loadChunk(player.index, player.resumeAt);
  else if (audio.paused) audio.play().catch(e => setStatus(e.message, true));
  else audio.pause();
}

function skip(seconds) {
  if (!player.doc) return;
  if (player.loaded !== player.index) { togglePlay(); return; }
  const t = audio.currentTime + seconds;
  if (t < 0 && player.index > 0 && audio.currentTime < 2) loadChunk(player.index - 1);
  else if (isFinite(audio.duration) && t >= audio.duration) loadChunk(player.index + 1);
  else audio.currentTime = Math.max(0, t);
}

function setRate(r) {
  settings.rate = r;
  saveSettings();
  audio.defaultPlaybackRate = r;
  audio.playbackRate = r;
  $('#p-rate').value = String(r);
  $('#st-rate').value = r;
  $('#st-rate-val').textContent = r + '×';
}

async function savePosition(force = false) {
  const doc = player.doc;
  if (!doc || (!force && Date.now() - player.lastSave < 5000)) return;
  player.lastSave = Date.now();
  doc.pos = { i: player.index, t: player.loaded === player.index ? audio.currentTime : 0 };
  const stored = await db.get('docs', doc.id);
  if (stored) { stored.pos = doc.pos; stored.updatedAt = Date.now(); await db.put('docs', stored); }
}

function updatePlayButton() {
  const playing = !audio.paused && player.loaded === player.index;
  $('#p-toggle').textContent = playing ? '⏸' : '▶';
  $('#p-toggle').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  const rdPlay = $('#rd-play');
  const thisDocPlaying = playing && viewingDoc && player.doc?.id === viewingDoc.id;
  rdPlay.textContent = thisDocPlaying ? '⏸ Pause' : '▶ Listen';
}

function updateBar() {
  const doc = player.doc;
  if (!doc) return;
  const n = doc.chunks.length || 1;
  const frac = player.loaded === player.index && audio.duration ? audio.currentTime / audio.duration : 0;
  $('#p-progress').max = n;
  $('#p-progress').value = player.index + frac;
  if (!$('#p-status').classList.contains('error') || player.loaded === player.index) {
    const time = player.loaded === player.index ? ` · ${fmtTime(audio.currentTime)} / ${fmtTime(audio.duration)}` : '';
    setStatus(`Part ${Math.min(player.index + 1, n)} of ${n}${time}`);
  }
  updatePlayButton();
}

function updateMetadata() {
  if (!('mediaSession' in navigator) || !player.doc) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: player.doc.title,
    artist: `Part ${player.index + 1} of ${player.doc.chunks.length}`,
    album: 'Readout',
    artwork: [
      { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
  });
}

function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  const handlers = {
    play: () => togglePlay(),
    pause: () => audio.pause(),
    seekbackward: () => skip(-15),
    seekforward: () => skip(15),
    previoustrack: () => loadChunk(player.index - 1),
    nexttrack: () => loadChunk(player.index + 1),
    seekto: d => { if (player.loaded === player.index) audio.currentTime = d.seekTime; },
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try { ms.setActionHandler(action, fn); } catch {}
  }
}

audio.addEventListener('ended', () => loadChunk(player.index + 1));
audio.addEventListener('play', updatePlayButton);
audio.addEventListener('pause', () => { updatePlayButton(); savePosition(true); });
audio.addEventListener('timeupdate', () => {
  updateBar();
  savePosition();
  if ('mediaSession' in navigator && isFinite(audio.duration) && audio.duration > 0) {
    try {
      navigator.mediaSession.setPositionState({ duration: audio.duration, position: Math.min(audio.currentTime, audio.duration), playbackRate: audio.playbackRate });
    } catch {}
  }
});

// ---------------------------------------------------------------- settings view
function renderSettings() {
  $('#st-key').value = settings.apiKey;
  const voiceSel = $('#st-voice');
  const allowed = settings.ttsModel.startsWith('gpt-') ? VOICES : TTS1_VOICES;
  voiceSel.innerHTML = allowed.map(v => `<option value="${v}">${v[0].toUpperCase() + v.slice(1)}</option>`).join('');
  if (!allowed.includes(settings.voice)) { settings.voice = 'nova'; saveSettings(); }
  voiceSel.value = settings.voice;
  $('#st-tts-model').value = settings.ttsModel;
  $('#st-instructions').value = settings.instructions;
  $('#st-instructions').disabled = !settings.ttsModel.startsWith('gpt-');
  $('#st-rate').value = settings.rate;
  $('#st-rate-val').textContent = settings.rate + '×';
  $('#st-text-model').value = settings.textModel;
  $('#st-visuals').checked = settings.describeVisuals;
  renderStorage();
}

async function renderStorage() {
  const n = await db.count('audio');
  let usage = '';
  if (navigator.storage?.estimate) {
    const est = await navigator.storage.estimate();
    usage = ` · ${(est.usage / 1048576).toFixed(1)} MB used on this device`;
  }
  $('#st-storage').textContent = `${n} saved audio sections${usage}. Saved audio replays for free and works offline.`;
}

function bindSettings() {
  $('#st-key').addEventListener('change', e => { settings.apiKey = e.target.value.trim(); saveSettings(); });
  $('#st-key-show').onclick = () => {
    const el = $('#st-key');
    el.type = el.type === 'password' ? 'text' : 'password';
    $('#st-key-show').textContent = el.type === 'password' ? 'Show' : 'Hide';
  };
  $('#st-key-test').onclick = async () => {
    settings.apiKey = $('#st-key').value.trim();
    saveSettings();
    try {
      const res = await fetch(API + '/models', { headers: { Authorization: 'Bearer ' + settings.apiKey } });
      toast(res.ok ? '✅ Key works!' : `❌ Key rejected (${res.status})`, !res.ok);
    } catch (e) { toast('Could not reach OpenAI: ' + e.message, true); }
  };
  $('#st-voice').onchange = e => { settings.voice = e.target.value; saveSettings(); };
  $('#st-tts-model').onchange = e => { settings.ttsModel = e.target.value; saveSettings(); renderSettings(); };
  $('#st-instructions').onchange = e => { settings.instructions = e.target.value; saveSettings(); };
  $('#st-rate').oninput = e => setRate(parseFloat(e.target.value));
  $('#st-text-model').onchange = e => { settings.textModel = e.target.value.trim() || DEFAULTS.textModel; saveSettings(); };
  $('#st-visuals').onchange = e => { settings.describeVisuals = e.target.checked; saveSettings(); };
  const presets = $('#st-style-presets');
  for (const [name, text] of Object.entries(STYLE_PRESETS)) {
    const b = document.createElement('button');
    b.className = 'btn'; b.textContent = name; b.type = 'button';
    b.onclick = e => { e.preventDefault(); settings.instructions = text; saveSettings(); $('#st-instructions').value = text; };
    presets.append(b);
  }
  $('#st-preview').onclick = async e => {
    e.preventDefault();
    const btn = $('#st-preview');
    btn.disabled = true;
    try {
      const blob = await getChunkAudio(`Hi! I'm ${settings.voice}. This is how your study material will sound while you work out.`);
      const a = new Audio(URL.createObjectURL(blob));
      a.playbackRate = settings.rate;
      await a.play();
    } catch (err) { toast(err.message, true); }
    btn.disabled = false;
  };
  $('#st-clear-audio').onclick = async () => {
    if (!confirm('Delete all saved audio? Your documents are kept, but audio will be regenerated (and billed) next time you listen.')) return;
    await db.clear('audio');
    renderStorage();
    toast('Saved audio cleared.');
  };
}

// ---------------------------------------------------------------- wiring
function bindUI() {
  // Library: add buttons
  $('#btn-paste').onclick = pasteFromClipboard;
  $('#btn-camera').onclick = () => $('#in-camera').click();
  $('#btn-images').onclick = () => $('#in-images').click();
  $('#btn-file').onclick = () => $('#in-file').click();
  $('#btn-type').onclick = () => openEditor(null, { text: '', title: '' });
  for (const id of ['#in-camera', '#in-images', '#in-file']) {
    $(id).onchange = e => { const files = [...e.target.files]; e.target.value = ''; importFiles(files); };
  }

  // Editor
  $('#ed-text').addEventListener('input', updateCount);
  $('#ed-cancel').onclick = () => { editing = null; location.hash = '#/library'; };
  $('#ed-save').onclick = async () => { const doc = await saveEditor(); if (doc) location.hash = '#/doc/' + doc.id; };
  $('#ed-listen').onclick = async () => { const doc = await saveEditor(); if (doc) { location.hash = '#/doc/' + doc.id; startDoc(doc); } };
  $('#ed-cleanup').onclick = cleanupText;
  const edImages = document.createElement('input');
  edImages.type = 'file'; edImages.accept = 'image/*'; edImages.multiple = true;
  edImages.onchange = async () => {
    const files = [...edImages.files];
    edImages.value = '';
    if (!files.length) return;
    const signal = busy.start('Reading images…');
    try {
      const text = await imagesToText(files, signal);
      const ta = $('#ed-text');
      ta.value = (ta.value.trim() ? ta.value.trimEnd() + '\n\n' : '') + text;
      updateCount();
    } catch (e) { if (e.name !== 'AbortError') toast(e.message, true); }
    busy.end();
  };
  $('#ed-add-images').onclick = () => edImages.click();

  // Reader
  $('#rd-play').onclick = () => {
    if (!viewingDoc) return;
    if (player.doc?.id === viewingDoc.id) togglePlay();
    else startDoc(viewingDoc);
  };
  $('#rd-edit').onclick = () => openEditor(viewingDoc);
  $('#rd-text').onclick = e => {
    const el = e.target.closest('.chunk');
    if (!el || !viewingDoc) return;
    setDoc(viewingDoc);
    loadChunk(+el.dataset.i);
  };
  document.querySelectorAll('[data-study]').forEach(b => {
    b.onclick = () => { b.closest('details').open = false; runStudy(b.dataset.study); };
  });
  $('#rd-prepare').onclick = async e => {
    e.target.closest('details').open = false;
    if (viewingDoc && await prepareOffline(viewingDoc)) toast('All audio saved. This document now plays offline.');
  };
  $('#rd-export').onclick = e => { e.target.closest('details').open = false; if (viewingDoc) exportMp3(viewingDoc); };
  document.addEventListener('click', e => {
    document.querySelectorAll('details.menu[open]').forEach(d => { if (!d.contains(e.target)) d.open = false; });
  });

  // Player
  $('#p-toggle').onclick = togglePlay;
  $('#p-back').onclick = () => skip(-15);
  $('#p-fwd').onclick = () => skip(15);
  $('#p-prev').onclick = () => loadChunk(player.index - 1);
  $('#p-next').onclick = () => loadChunk(player.index + 1);
  $('#p-rate').innerHTML = RATES.map(r => `<option value="${r}">${r}×</option>`).join('');
  if (!RATES.includes(settings.rate)) $('#p-rate').insertAdjacentHTML('beforeend', `<option value="${settings.rate}">${settings.rate}×</option>`);
  $('#p-rate').value = String(settings.rate);
  $('#p-rate').onchange = e => setRate(parseFloat(e.target.value));
  $('#p-progress').onchange = e => {
    if (!player.doc) return;
    const v = parseFloat(e.target.value);
    const i = Math.min(Math.floor(v), player.doc.chunks.length - 1);
    if (i === player.loaded && isFinite(audio.duration)) audio.currentTime = (v - i) * audio.duration;
    else loadChunk(i);
  };

  $('#busy-cancel').onclick = () => { busy.ctrl?.abort(); busy.end(); };

  // Keyboard shortcuts (desktop)
  document.addEventListener('keydown', e => {
    if (e.target.matches('input, textarea, select') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === 'Space' && player.doc) { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowLeft' && player.doc) e.shiftKey ? loadChunk(player.index - 1) : skip(-15);
    else if (e.key === 'ArrowRight' && player.doc) e.shiftKey ? loadChunk(player.index + 1) : skip(15);
  });

  // Paste anywhere on the library screen: screenshots or text
  document.addEventListener('paste', e => {
    if (e.target.matches('input, textarea') || $('#view-library').hidden) return;
    const files = [...e.clipboardData.files].filter(isImage);
    const text = e.clipboardData.getData('text/plain');
    if (files.length) { e.preventDefault(); importFiles(files); }
    else if (text.trim()) { e.preventDefault(); openEditor(null, { text, title: guessTitle(text) }); }
  });

  // Drag & drop files onto the window
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => {
    e.preventDefault();
    if (e.dataTransfer.files.length) importFiles(e.dataTransfer.files);
  });

  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') savePosition(true); });
}

async function init() {
  bindUI();
  bindSettings();
  setupMediaSession();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.storage?.persist?.().catch(() => {});
  await route();
  if (new URLSearchParams(location.search).has('shared')) {
    history.replaceState(null, '', location.pathname + location.hash);
    await checkShareInbox();
  }
}

init();
