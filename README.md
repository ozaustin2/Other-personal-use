# Readout: a personal study listener

A Speechify-style app that turns book photos, screenshots, PDFs and pasted text into speech using **your OpenAI account's voices**. It plays in the background with lock-screen and headphone controls, so you can study while you work out.

It's an installable web app (PWA). The same code installs like a normal app on your **Google Pixel** and your **Windows PC**, and it's hosted free on GitHub Pages. There's no server: your API key and library stay on each device.

## Setup (one time, about 5 minutes)

### 1. Turn on GitHub Pages
1. Go to **github.com/ozaustin2/Other-personal-use → Settings → Pages**.
2. Under **Build and deployment → Source**, choose **Deploy from a branch**.
3. Pick the branch that holds this code (e.g. `main`) and the **`/docs`** folder, then click **Save**.
4. After about a minute, the app is live at **https://ozaustin2.github.io/Other-personal-use/**

### 2. Create an OpenAI API key just for this app
1. Go to https://platform.openai.com/api-keys → **Create new secret key** (name it "Readout").
2. Optional but recommended: set a monthly budget under **Settings → Limits**.

### 3. Install on your Pixel
1. Open the link above in **Chrome**.
2. Tap **⋮ → Add to Home screen → Install**.
3. Open Readout → **Settings** → paste your key → **Test**.
4. Once installed, **Readout appears in Android's Share menu.** You can share screenshots, photos or selected text straight into it.

### 4. Install on Windows
1. Open the link in **Edge** or **Chrome**.
2. Click the **install icon** in the address bar (or ⋮ → Apps → Install).
3. Paste your key in **Settings** (each device keeps its own copy).

## How to use it

| To read… | Do this |
|---|---|
| A physical book | **Photo**: snap the page. For several pages, use **Images** or **+ Add pages** in the editor. |
| Something on your phone screen | Take a screenshot → **Share → Readout** (or select text → Share → Readout). |
| Something on your PC screen | **Win + Shift + S** to snip → **Ctrl + V** in Readout. |
| Copied text | **Paste**, or Ctrl+V on the library screen. |
| A PDF or textbook chapter | **File**: choose which pages to read. Scanned pages get OCR'd automatically. |

You can review and edit the text first. **✨ Clean up text** fixes OCR mistakes and removes page numbers, headers and citation clutter. Then tap **Save & Listen**.

**While listening:** tap any paragraph to jump there. Use ⏮/⏭ for the previous/next section and ↺15/15↻ to skip back/forward 15 seconds. The speed goes from 0.75× to 3×. Your place is saved automatically. Headphone buttons and lock-screen controls work too. On desktop: Space = play/pause, ←/→ = 15 s, Shift+←/→ = section.

### Study tools (Reader → Study tools)
- **Spoken summary**: a condensed version written for listening.
- **Audio quiz**: questions, then a 6-second pause for you to answer out loud, then the answer. Good for active recall on the treadmill.
- **Explain it like a tutor**: re-teaches the material with examples and analogies.
- **Key terms**: spoken flashcards (term → pause → definition).

Each one creates a new item in your library.

### For the gym (no signal / screen off)
- **Offline → Pre-generate all audio** before you leave. Everything gets saved on the device and plays with no internet.
- **Offline → Export as one MP3**: a single file you can play in any music app.
- Audio is cached, so replaying something never costs credits twice.

## Settings
- **Voice**: 13 OpenAI voices (Nova, Onyx, Coral, Sage, Marin, Cedar…). Use **Preview** to try them.
- **Voice model**: `gpt-4o-mini-tts` (most natural, and follows a speaking style such as "Lecturer" or "Workout coach"), `tts-1` (cheap and fast), or `tts-1-hd`.
- **AI model for images/study tools**: defaults to `gpt-4.1-mini`. If OpenAI retires it, pick another from the list.
- **Describe equations/charts**: when reading images, say math the way you'd speak it and describe figures briefly.

## Costs (billed to your OpenAI account)
You pay OpenAI directly at their API prices. A typical textbook chapter costs cents, not dollars. Check current prices at https://openai.com/api/pricing. Saved audio replays for free.

## Chrome extension (Windows desktop)

The `extension/` folder is a Speechify-style Chrome extension that reads any web page aloud with the same OpenAI voices.

### Install it (one time)
1. On GitHub, open this repo → green **Code** button → **Download ZIP**. Unzip it somewhere permanent, e.g. `Documents\Readout`. Don't delete the folder later; Chrome loads the extension from it.
2. In Chrome, go to **chrome://extensions** and turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select the **`extension`** folder inside what you unzipped.
4. The settings page opens automatically. Paste your OpenAI key → **Test**.
5. Click the puzzle-piece icon in Chrome's toolbar → **pin** Readout.

To update later: download and unzip again over the same folder, then click the ↻ reload icon on Readout's card in chrome://extensions.

### What it does
| Feature | How |
|---|---|
| Read the whole article | Click the 🎧 button in the bottom-right corner of any page, press **Alt+Shift+R**, or right-click → *Read this page aloud*. Menus, sidebars and footers are skipped. |
| Read from a specific paragraph | Hover a paragraph and click the small ▶ that appears beside it. |
| Read selected text | Select text → **Alt+Shift+R**, or right-click → *Read selection aloud*. |
| Read anything on screen | **Alt+Shift+S**, then drag a box around it. Works on PDFs, Google Docs, Kindle Cloud Reader, images and videos. |
| Read text in an image | Right-click the image → *Read the text in this image*. |
| Read pasted text | Click the Readout toolbar icon → paste → **Read**. |
| Follow along | The paragraph being read is highlighted, and the page scrolls with it. |
| Controls | The floating player has play/pause, ±15 s, previous/next paragraph, speed and stop. **Alt+Shift+P** plays/pauses. |

Audio keeps playing when you switch tabs. Already-heard audio is cached, so replays are free.
Change shortcuts at **chrome://extensions/shortcuts**. You can set play/pause to *Global* so it works even when Chrome isn't focused.

Pages that Chrome doesn't let extensions touch (the Chrome Web Store, `chrome://` pages, and Chrome's built-in PDF viewer) fall back to reading a screenshot of the visible area. Selecting text in a PDF and right-clicking → *Read selection aloud* also works.

## Files
The phone/desktop app is in `docs/` (plain HTML/CSS/JS, no build step):
`index.html`, `styles.css`, `app.js` (the app), `sw.js` (offline + share-sheet support), `manifest.webmanifest` (install info), `icons/`.

To run it locally: `cd docs && python -m http.server 8000`, then open http://localhost:8000.

The Chrome extension is in `extension/`: `background.js` (commands, context menus, routing), `offscreen.js` (audio playback and OpenAI calls), `content.js` (page text extraction, highlighting, floating player, screen-area selection), `popup.*`, `options.*`, and `shared.js`.
