// Text helpers shared by the background worker and the content script.
var Readout = self.Readout || (() => {
  const SENTENCE_RE = /(?<=[.!?…]["'”’)\]]*)\s+/;

  // Split one paragraph into pieces no longer than `max`, breaking at sentence ends.
  function splitLong(text, max = 1200) {
    if (text.length <= max) return [text];
    const out = [];
    let cur = '';
    for (let s of text.split(SENTENCE_RE)) {
      while (s.length > max) {
        let cut = s.lastIndexOf(' ', max);
        if (cut < max / 4) cut = max;
        if (cur) { out.push(cur); cur = ''; }
        out.push(s.slice(0, cut));
        s = s.slice(cut).trim();
      }
      if (cur && cur.length + s.length + 1 > max) { out.push(cur); cur = ''; }
      cur += (cur ? ' ' : '') + s;
    }
    if (cur) out.push(cur);
    return out.filter(Boolean);
  }

  // Split free text into TTS-sized chunks. The first chunk is short so playback starts fast.
  function chunkText(text) {
    const paras = text.replace(/\r/g, '')
      .replace(/(\w)-\n(\w)/g, '$1$2')
      .split(/\n\s*\n+/)
      .map(p => p.replace(/\s*\n\s*/g, ' ').replace(/[ \t]+/g, ' ').trim())
      .filter(Boolean);
    const chunks = [];
    let cur = '';
    const limit = () => (chunks.length === 0 ? 300 : 1400);
    for (const para of paras) {
      splitLong(para, 1400).forEach((piece, i) => {
        const sep = cur ? (i === 0 ? '\n\n' : ' ') : '';
        if (cur && cur.length + sep.length + piece.length > limit()) { chunks.push(cur); cur = ''; }
        cur += (cur ? sep : '') + piece;
      });
      if (cur.length > limit() * 0.7) { chunks.push(cur); cur = ''; }
    }
    if (cur) chunks.push(cur);
    return chunks;
  }

  const DEFAULTS = {
    apiKey: '',
    voice: 'nova',
    ttsModel: 'gpt-4o-mini-tts',
    instructions: 'Read clearly and naturally, like an engaging audiobook narrator. Keep a steady, moderate pace and pause briefly between paragraphs.',
    rate: 1,
    textModel: 'gpt-4.1-mini',
    describeVisuals: true,
    floatingButton: true,
    hoverButtons: true,
    autoScroll: true,
  };

  const RATES = [0.75, 1, 1.1, 1.2, 1.25, 1.3, 1.4, 1.5, 1.75, 2, 2.25, 2.5, 3];

  return { splitLong, chunkText, DEFAULTS, RATES };
})();
self.Readout = Readout;
