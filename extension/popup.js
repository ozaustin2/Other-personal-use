const $ = s => document.querySelector(s);
const send = msg => chrome.runtime.sendMessage(msg).catch(() => null);
const fmt = s => !isFinite(s) ? '0:00' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

async function init() {
  const { settings: stored } = await chrome.storage.local.get('settings');
  const settings = { ...Readout.DEFAULTS, ...stored };
  $('#no-key').hidden = !!settings.apiKey;

  const rate = $('#rate');
  rate.innerHTML = Readout.RATES.map(r => `<option value="${r}">${r}×</option>`).join('');
  if (!Readout.RATES.includes(settings.rate)) rate.insertAdjacentHTML('beforeend', `<option value="${settings.rate}">${settings.rate}×</option>`);
  rate.value = String(settings.rate);
  rate.onchange = () => send({ type: 'control', action: 'rate', value: parseFloat(rate.value) });

  document.querySelectorAll('[data-action]').forEach(b => {
    b.onclick = async () => {
      await send({ type: 'popupAction', action: b.dataset.action });
      window.close();
    };
  });
  document.querySelectorAll('[data-c]').forEach(b => {
    b.onclick = () => send({ type: 'control', action: b.dataset.c });
  });
  $('#read-text').onclick = async () => {
    const text = $('#text').value.trim();
    if (!text) return;
    const title = text.split('\n')[0].slice(0, 60);
    await send({ type: 'popupAction', action: 'readText', text, title });
  };
  for (const id of ['#open-options', '#open-options-2']) {
    $(id).onclick = e => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
  }

  const res = await send({ type: 'getState' });
  render(res?.state);
}

function render(st) {
  $('#now').hidden = !st;
  if (!st) return;
  $('#now-title').textContent = st.title || 'Readout';
  const status = st.status || `Part ${Math.min(st.index + 1, st.count)} of ${st.count}` + (st.duration ? ` · ${fmt(st.time)} / ${fmt(st.duration)}` : '');
  $('#now-status').textContent = status;
  $('#now-status').classList.toggle('error', !!st.error);
  const frac = st.count ? (Math.min(st.index, st.count) + (st.duration ? st.time / st.duration : 0)) / st.count : 0;
  $('#now-bar').style.width = (Math.min(1, frac) * 100).toFixed(1) + '%';
  $('#now-play').textContent = st.playing ? '⏸' : '▶';
}

chrome.runtime.onMessage.addListener(msg => {
  if (msg.target === 'popup' && msg.type === 'state') render(msg.state);
});

init();
