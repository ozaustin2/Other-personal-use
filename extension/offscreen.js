// Offscreen document: plays audio (so it keeps going when you switch tabs) and makes the
// OpenAI calls. It only has chrome.runtime, so settings arrive with each message.
const API = 'https://api.openai.com/v1';

let settings = {};
let chunks = [];
let index = 0;
let gen = 0;
let token = 0;
let loaded = -1;
let url = null;
let lastReport = 0;
let title = '';
const audio = new Audio();

// ---------------------------------------------------------------- audio cache (IndexedDB)
const db = (() => {
  let opening;
  const open = () => opening ||= new Promise((resolve, reject) => {
    const req = indexedDB.open('readout-ext', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('audio');
    req.onsuccess = () => {
      req.result.onversionchange = () => { req.result.close(); opening = null; };
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
  const run = async (mode, fn) => {
    const d = await open();
    return new Promise((resolve, reject) => {
      const t = d.transaction('audio', mode);
      const req = fn(t.objectStore('audio'));
      t.oncomplete = () => resolve(req.result);
      t.onerror = () => reject(t.error);
    });
  };
  return {
    get: key => run('readonly', s => s.get(key)),
    put: (key, value) => run('readwrite', s => s.put(value, key)),
  };
})();

async function sha(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- OpenAI
async function api(path, body) {
  if (!settings.apiKey) throw new Error('Add your OpenAI API key in Readout settings (right-click the Readout icon → Options).');
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API + path, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + settings.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) return res;
    if ((res.status === 429 || res.status >= 500) && attempt < 3) { await sleep(1500 * 2 ** attempt); continue; }
    let msg = `${res.status} ${res.statusText}`;
    try { const j = await res.json(); msg = j.error?.message || msg; } catch {}
    throw new Error('OpenAI: ' + msg);
  }
}

async function chat(messages) {
  const res = await api('/chat/completions', { model: settings.textModel, messages });
  const j = await res.json();
  return (j.choices?.[0]?.message?.content || '').trim();
}

const inflight = new Map();
async function getChunkAudio(text) {
  const body = { model: settings.ttsModel, voice: settings.voice, input: text, response_format: 'mp3' };
  if (settings.ttsModel.startsWith('gpt-') && settings.instructions?.trim()) body.instructions = settings.instructions.trim();
  const key = await sha(JSON.stringify([body.model, body.voice, body.instructions || '', text]));
  const cached = await db.get(key).catch(() => null);
  if (cached) return cached;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const blob = await (await api('/audio/speech', body)).blob();
    await db.put(key, blob).catch(() => {});
    return blob;
  })();
  inflight.set(key, p);
  try { return await p; } finally { inflight.delete(key); }
}

// ---------------------------------------------------------------- OCR
async function toJpegDataUrl(source, maxSide = 2048) {
  const bmp = source instanceof ImageBitmap ? source : await createImageBitmap(source);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.88);
}

async function ocr({ dataUrl, url: imageUrl, crop }) {
  let blob;
  if (imageUrl) {
    const res = await fetch(imageUrl).catch(() => null);
    if (!res || !res.ok) throw new Error("Couldn't download that image. Try \"Read an area of the screen\" instead.");
    blob = await res.blob();
  } else {
    blob = await (await fetch(dataUrl)).blob();
  }
  let bmp = await createImageBitmap(blob);
  if (crop) {
    // crop is in CSS pixels of a viewport `vw` wide; the screenshot may be at a higher DPI.
    const s = bmp.width / crop.vw;
    bmp = await createImageBitmap(bmp, Math.round(crop.x * s), Math.round(crop.y * s), Math.max(1, Math.round(crop.w * s)), Math.max(1, Math.round(crop.h * s)));
  }
  const image = await toJpegDataUrl(bmp);
  const prompt = [
    'Transcribe the readable text in this image (a web page, document, book page, or screenshot) so it can be read aloud by text-to-speech.',
    'Rules: keep the original wording exactly; keep headings and paragraphs in reading order; join lines that belong to the same paragraph; fix words hyphenated across line breaks;',
    'skip page numbers, running headers/footers, app/browser interface elements, menus, and ads.',
    settings.describeVisuals
      ? 'If there are equations, write them the way a person would say them aloud. If there is a figure, chart, or table, add a short spoken-style description in square brackets.'
      : 'Ignore figures and images.',
    'Output only the transcribed text, no commentary. If there is no readable text, output nothing.',
  ].join(' ');
  return chat([{ role: 'user', content: [
    { type: 'text', text: prompt },
    { type: 'image_url', image_url: { url: image, detail: 'high' } },
  ] }]);
}

// ---------------------------------------------------------------- playback
function report(extra = {}) {
  lastReport = Date.now();
  chrome.runtime.sendMessage({
    target: 'bg', type: 'progress', gen, index,
    time: audio.currentTime || 0,
    duration: isFinite(audio.duration) ? audio.duration : 0,
    playing: !audio.paused && loaded === index,
    status: '', error: false, done: false,
    ...extra,
  }).catch(() => {});
}

async function loadChunk(i, startAt = 0, autoplay = true) {
  if (i >= chunks.length) {
    audio.pause();
    loaded = -1;
    index = chunks.length;
    report({ playing: false, done: true, status: 'Finished' });
    return;
  }
  index = Math.max(0, i);
  const t = ++token;
  report({ playing: true, status: 'Loading…' });
  let blob;
  try {
    blob = await getChunkAudio(chunks[index]);
  } catch (e) {
    if (t === token) report({ playing: false, status: e.message, error: true });
    return;
  }
  if (t !== token) return;
  if (url) URL.revokeObjectURL(url);
  url = URL.createObjectURL(blob);
  audio.src = url;
  audio.defaultPlaybackRate = audio.playbackRate = settings.rate || 1;
  if (startAt > 0) audio.currentTime = startAt;
  loaded = index;
  updateMediaSession();
  if (autoplay) {
    try { await audio.play(); } catch (e) { report({ playing: false, status: e.message, error: true }); return; }
  }
  report();
  // Fetch the next sections ahead of time so there are no gaps.
  for (const j of [index + 1, index + 2]) if (j < chunks.length) getChunkAudio(chunks[j]).catch(() => {});
}

function toggle() {
  if (index >= chunks.length) loadChunk(0);
  else if (loaded !== index) loadChunk(index);
  else if (audio.paused) audio.play();
  else audio.pause();
}

function skip(sec) {
  if (loaded !== index) return toggle();
  const t = audio.currentTime + sec;
  if (t < 0 && index > 0 && audio.currentTime < 2) loadChunk(index - 1);
  else if (isFinite(audio.duration) && t >= audio.duration) loadChunk(index + 1);
  else audio.currentTime = Math.max(0, t);
}

function control(action, value) {
  switch (action) {
    case 'toggle': return toggle();
    case 'play': return audio.paused ? toggle() : undefined;
    case 'pause': return audio.pause();
    case 'back': return skip(-15);
    case 'fwd': return skip(15);
    case 'prev': return loadChunk(index - 1);
    case 'next': return loadChunk(index + 1);
    case 'jump': return loadChunk(value);
    case 'rate': audio.defaultPlaybackRate = audio.playbackRate = value; return report();
  }
}

function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({ title, artist: `Readout · part ${index + 1} of ${chunks.length}` });
}
if ('mediaSession' in navigator) {
  const h = { play: () => control('play'), pause: () => control('pause'), previoustrack: () => control('prev'), nexttrack: () => control('next'), seekbackward: () => control('back'), seekforward: () => control('fwd') };
  for (const [k, fn] of Object.entries(h)) { try { navigator.mediaSession.setActionHandler(k, fn); } catch {} }
}

audio.addEventListener('ended', () => loadChunk(index + 1));
audio.addEventListener('play', () => report());
audio.addEventListener('pause', () => { if (!audio.ended) report(); });
audio.addEventListener('timeupdate', () => { if (Date.now() - lastReport > 900) report(); });

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;
  if (msg.settings) settings = msg.settings;
  switch (msg.type) {
    case 'load':
      gen = msg.gen;
      chunks = msg.chunks;
      title = msg.title || '';
      loadChunk(msg.index || 0, msg.time || 0, msg.autoplay !== false);
      break;
    case 'control':
      control(msg.action, msg.value);
      break;
    case 'ocr':
      ocr(msg).then(text => sendResponse({ text }), e => sendResponse({ error: e.message }));
      return true;
  }
  sendResponse({ ok: true });
});
