const $ = s => document.querySelector(s);
const VOICES = ['alloy', 'ash', 'ballad', 'cedar', 'coral', 'echo', 'fable', 'marin', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];
const TTS1_VOICES = ['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'];
const PRESETS = {
  'Audiobook': Readout.DEFAULTS.instructions,
  'Lecturer': 'Speak like a clear, warm university lecturer. Emphasize key terms and definitions, and pause slightly after important points.',
  'Energetic': 'Speak with upbeat, energetic delivery, but keep every word crisp and easy to follow.',
  'Calm': 'Speak in a calm, relaxed, even tone at a gentle pace.',
};

let settings;
let toastTimer;
function toast(msg, error = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (error ? ' error' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

async function save(patch) {
  Object.assign(settings, patch);
  await chrome.storage.local.set({ settings });
}

function render() {
  $('#key').value = settings.apiKey;
  const gpt = settings.ttsModel.startsWith('gpt-');
  const voices = gpt ? VOICES : TTS1_VOICES;
  $('#voice').innerHTML = voices.map(v => `<option value="${v}">${v[0].toUpperCase() + v.slice(1)}</option>`).join('');
  if (!voices.includes(settings.voice)) save({ voice: 'nova' });
  $('#voice').value = settings.voice;
  $('#tts-model').value = settings.ttsModel;
  $('#instructions').value = settings.instructions;
  $('#instructions').disabled = !gpt;
  $('#rate').value = settings.rate;
  $('#rate-val').textContent = settings.rate + '×';
  $('#text-model').value = settings.textModel;
  $('#floating').checked = settings.floatingButton;
  $('#hover').checked = settings.hoverButtons;
  $('#autoscroll').checked = settings.autoScroll;
  $('#visuals').checked = settings.describeVisuals;
}

async function init() {
  const { settings: stored } = await chrome.storage.local.get('settings');
  settings = { ...Readout.DEFAULTS, ...stored };
  render();

  $('#key').onchange = e => save({ apiKey: e.target.value.trim() });
  $('#key-show').onclick = () => {
    const k = $('#key');
    k.type = k.type === 'password' ? 'text' : 'password';
    $('#key-show').textContent = k.type === 'password' ? 'Show' : 'Hide';
  };
  $('#key-test').onclick = async () => {
    await save({ apiKey: $('#key').value.trim() });
    try {
      const res = await fetch('https://api.openai.com/v1/models', { headers: { Authorization: 'Bearer ' + settings.apiKey } });
      toast(res.ok ? '✅ Key works!' : `❌ Key rejected (${res.status})`, !res.ok);
    } catch (e) { toast('Could not reach OpenAI: ' + e.message, true); }
  };
  $('#voice').onchange = e => save({ voice: e.target.value });
  $('#tts-model').onchange = async e => { await save({ ttsModel: e.target.value }); render(); };
  $('#instructions').onchange = e => save({ instructions: e.target.value });
  $('#rate').oninput = e => { $('#rate-val').textContent = e.target.value + '×'; save({ rate: parseFloat(e.target.value) }); };
  $('#text-model').onchange = e => save({ textModel: e.target.value.trim() || Readout.DEFAULTS.textModel });
  $('#floating').onchange = e => save({ floatingButton: e.target.checked });
  $('#hover').onchange = e => save({ hoverButtons: e.target.checked });
  $('#autoscroll').onchange = e => save({ autoScroll: e.target.checked });
  $('#visuals').onchange = e => save({ describeVisuals: e.target.checked });

  for (const [name, text] of Object.entries(PRESETS)) {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = name;
    b.onclick = e => { e.preventDefault(); $('#instructions').value = text; save({ instructions: text }); };
    $('#presets').append(b);
  }

  $('#preview').onclick = e => {
    e.preventDefault();
    const name = settings.voice[0].toUpperCase() + settings.voice.slice(1);
    chrome.runtime.sendMessage({ type: 'popupAction', action: 'readText', title: 'Voice preview', text: `Hi, I'm ${name}. This is how your reading will sound.` });
  };

  $('#clear').onclick = () => {
    if (!confirm('Delete all saved audio?')) return;
    chrome.runtime.sendMessage({ type: 'control', action: 'stop' }).catch(() => {});
    const req = indexedDB.deleteDatabase('readout-ext');
    req.onsuccess = () => toast('Saved audio cleared.');
    req.onerror = () => toast('Could not clear audio.', true);
  };
}

init();
