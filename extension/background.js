// Background service worker: routes commands between the page, the popup, and the offscreen
// audio player. The service worker can be shut down at any time, so reading state lives in
// chrome.storage.session.
importScripts('shared.js');

let state = null;   // current reading session (without the chunk texts)
let chunks = [];    // chunk texts of the current session
let loaded = false;

async function loadState() {
  if (loaded) return state;
  const s = await chrome.storage.session.get(['state', 'chunks']);
  state = s.state || null;
  chunks = s.chunks || [];
  loaded = true;
  return state;
}
let lastGen = 0;
const nextGen = () => (lastGen = Math.max(Date.now(), lastGen + 1)); // unique id per session
const persist = () => chrome.storage.session.set({ state });

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...Readout.DEFAULTS, ...settings };
}

function publicState() {
  return state && { ...state, count: chunks.length };
}

function notify() {
  const st = publicState();
  if (state?.tabId != null) chrome.tabs.sendMessage(state.tabId, { type: 'progress', state: st }).catch(() => {});
  chrome.runtime.sendMessage({ target: 'popup', type: 'state', state: st }).catch(() => {});
}

function tellTabGone(tabId) {
  if (tabId != null) chrome.tabs.sendMessage(tabId, { type: 'sessionGone' }).catch(() => {});
}

// ---------------------------------------------------------------- offscreen audio document
let creating = null;
async function hasOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return ctx.length > 0;
}
// Returns true if the document had to be (re)created.
async function ensureOffscreen() {
  if (await hasOffscreen()) return false;
  creating ||= chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['AUDIO_PLAYBACK'],
    justification: 'Plays text-to-speech audio while you browse.',
  }).finally(() => { creating = null; });
  await creating;
  return true;
}
async function toOffscreen(msg) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
}

// ---------------------------------------------------------------- sessions
async function startReading({ texts, start = 0, title, tabId, sessionId = null }) {
  await loadState();
  if (!texts.length) return setBusy(tabId, title, 'No readable text found.', true);
  const prevTab = state?.tabId;
  state = { gen: nextGen(), tabId, title, sessionId, index: start, time: 0, duration: 0, playing: true, status: 'Loading…', error: false, done: false };
  chunks = texts;
  await chrome.storage.session.set({ state, chunks });
  if (prevTab !== tabId) tellTabGone(prevTab);
  notify();
  await toOffscreen({ type: 'load', gen: state.gen, chunks, index: start, time: 0, autoplay: true, title, settings: await getSettings() });
}

// Show a status message (e.g. "Reading text from image…") and pause whatever was playing.
async function setBusy(tabId, title, status, error = false) {
  await loadState();
  const prevTab = state?.tabId;
  state = { gen: nextGen(), tabId, title, sessionId: null, index: 0, time: 0, duration: 0, playing: false, status, error, done: false };
  chunks = [];
  await chrome.storage.session.set({ state, chunks });
  if (prevTab !== tabId) tellTabGone(prevTab);
  if (await hasOffscreen()) chrome.runtime.sendMessage({ target: 'offscreen', type: 'control', action: 'pause' }).catch(() => {});
  notify();
}

async function stop() {
  await loadState();
  tellTabGone(state?.tabId);
  state = null;
  chunks = [];
  await chrome.storage.session.remove(['state', 'chunks']);
  notify();
  if (await hasOffscreen()) await chrome.offscreen.closeDocument().catch(() => {});
}

async function control(action, value) {
  await loadState();
  const settings = await getSettings();
  if (action === 'rate') {
    settings.rate = value;
    const { settings: stored } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...stored, rate: value } });
  }
  if (action === 'stop') return stop();
  if (!state || !chunks.length) return;
  // Chrome closes the audio document ~30 s after audio stops. If that happened, rebuild it
  // and continue from the saved position.
  const recreated = await ensureOffscreen();
  if (recreated) {
    if (action === 'pause' || action === 'rate') return;
    let index = state.index, time = state.time;
    if (action === 'next') { index++; time = 0; }
    if (action === 'prev') { index--; time = 0; }
    if (action === 'jump') { index = value; time = 0; }
    if (action === 'back') time = Math.max(0, time - 15);
    if (action === 'fwd') time += 15;
    if (index >= chunks.length || state.done) { index = 0; time = 0; }
    return chrome.runtime.sendMessage({ target: 'offscreen', type: 'load', gen: state.gen, chunks, index: Math.max(0, index), time, autoplay: true, title: state.title, settings });
  }
  return chrome.runtime.sendMessage({ target: 'offscreen', type: 'control', action, value, settings });
}

async function onProgress(p) {
  await loadState();
  if (!state || p.gen !== state.gen) return;
  Object.assign(state, { index: p.index, time: p.time, duration: p.duration, playing: p.playing, status: p.status, error: p.error, done: p.done });
  persist();
  notify();
}

// ---------------------------------------------------------------- OCR (screenshots and images)
async function runOcr({ dataUrl, url, crop, tabId, title }) {
  await setBusy(tabId, title, 'Reading text from the image…');
  const gen = state.gen;
  const res = await toOffscreen({ type: 'ocr', dataUrl, url, crop, settings: await getSettings() }).catch(e => ({ error: e.message }));
  await loadState();
  if (state?.gen !== gen) return; // something else started meanwhile
  if (res?.error) return setBusy(tabId, title, res.error, true);
  const text = (res?.text || '').trim();
  if (!text) return setBusy(tabId, title, 'No readable text found in that area.', true);
  await startReading({ texts: Readout.chunkText(text), title, tabId });
}

async function ocrWholeTab(tab) {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    await runOcr({ dataUrl, tabId: tab.id, title: tab.title || 'Screen text' });
  } catch (e) {
    await setBusy(tab.id, 'Readout', "Can't capture this page: " + e.message, true);
  }
}

// ---------------------------------------------------------------- talking to pages
// Sends a command to the page's content script, injecting it first if the tab was opened
// before the extension was installed. Returns false if the page can't run scripts
// (Chrome's PDF viewer, chrome:// pages, the Web Store).
async function sendToTab(tabId, msg) {
  try {
    return !!(await chrome.tabs.sendMessage(tabId, msg));
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['shared.js', 'content.js'] });
      return !!(await chrome.tabs.sendMessage(tabId, msg));
    } catch {
      return false;
    }
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function readPage(tab) { if (!(await sendToTab(tab.id, { type: 'readPage' }))) await ocrWholeTab(tab); }
async function readSelectionOrPage(tab) { if (!(await sendToTab(tab.id, { type: 'readSelectionOrPage' }))) await ocrWholeTab(tab); }
async function readArea(tab) { if (!(await sendToTab(tab.id, { type: 'selectArea' }))) await ocrWholeTab(tab); }

// ---------------------------------------------------------------- events
chrome.runtime.onInstalled.addListener(details => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'read-selection', title: 'Read selection aloud', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'read-page', title: 'Read this page aloud', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'read-image', title: 'Read the text in this image', contexts: ['image'] });
    chrome.contextMenus.create({ id: 'read-area', title: 'Read an area of the screen…', contexts: ['page', 'image'] });
  });
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab) return;
  if (info.menuItemId === 'read-selection') {
    const ok = await sendToTab(tab.id, { type: 'readSelectionOrPage' });
    if (!ok) await startReading({ texts: Readout.chunkText(info.selectionText || ''), title: 'Selection', tabId: tab.id });
  } else if (info.menuItemId === 'read-page') await readPage(tab);
  else if (info.menuItemId === 'read-image') await runOcr({ url: info.srcUrl, tabId: tab.id, title: 'Image text' });
  else if (info.menuItemId === 'read-area') await readArea(tab);
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  tab ||= await activeTab();
  if (command === 'toggle-play') return control('toggle');
  if (!tab) return;
  if (command === 'read-page') await readSelectionOrPage(tab);
  if (command === 'read-area') await readArea(tab);
});

chrome.tabs.onRemoved.addListener(async tabId => {
  await loadState();
  if (state?.tabId === tabId) { state.tabId = null; persist(); }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === 'offscreen' || msg.target === 'popup') return;
  if (msg.target === 'bg' && msg.type === 'progress') { onProgress(msg); return; }
  handle(msg, sender).then(sendResponse, e => sendResponse({ error: e.message }));
  return true;
});

async function handle(msg, sender) {
  const tab = sender.tab;
  switch (msg.type) {
    case 'play':
      await startReading({ texts: msg.chunks, start: msg.start, title: msg.title, tabId: tab?.id ?? null, sessionId: msg.sessionId });
      return { ok: true };
    case 'control':
      await control(msg.action, msg.value);
      return { ok: true };
    case 'getState': {
      await loadState();
      // Extension pages (popup, options) see every session; web pages only their own.
      const fromWebPage = tab && !sender.url?.startsWith(chrome.runtime.getURL(''));
      const mine = !fromWebPage || state?.tabId === tab.id;
      return { state: mine ? publicState() : null };
    }
    case 'ocr': {
      // The page hides its own UI, then asks us to screenshot (optionally cropped).
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      runOcr({ dataUrl, crop: msg.rect ? { ...msg.rect, vw: msg.vw } : null, tabId: tab.id, title: msg.title || 'Screen text' });
      return { ok: true };
    }
    case 'popupAction': {
      if (msg.action === 'readText') {
        await startReading({ texts: Readout.chunkText(msg.text || ''), title: msg.title || 'Pasted text', tabId: null });
        return { ok: true };
      }
      const t = await activeTab();
      if (!t) return { ok: false };
      if (msg.action === 'readPage') await readPage(t);
      if (msg.action === 'readSelection') await readSelectionOrPage(t);
      if (msg.action === 'readArea') await readArea(t);
      return { ok: true };
    }
  }
  return { ok: false };
}
