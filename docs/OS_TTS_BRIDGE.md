# OS Speech Bridge — render with the real OS voices

The browser gives JavaScript two limitations that no code inside the page can
overcome:

1. The Web Speech API (`speechSynthesis`) can *speak* with the OS voices, but
   its audio can never be captured into a file — there is no MediaStream.
2. Which voices the browser exposes, and how they sound, is decided entirely
   by the OS/browser; the page cannot pick a different speech *engine*.

The OS Speech Bridge removes both limits. It is a **zero-dependency Node
server** (`scripts/os-tts-server.mjs`) that routes synthesis to the
**established speech engine installed with your operating system** and returns
real WAV files:

| Platform | Established engine used |
|----------|------------------------|
| Windows  | **SAPI 5** via `System.Speech` (Microsoft David, Zira, Natural voices…) |
| macOS    | **Apple Speech** — the `say` CLI (Samantha, Alex, premium voices…) |
| Linux    | **espeak-ng / espeak** (the standard Linux CLI speech engine) |
| Any      | **Piper** — established open-source *neural* TTS, for lifelike quality (optional) |

## Start the bridge

```bash
npm run os-tts
# OS Speech Bridge listening on http://127.0.0.1:8477
```

Keep it running next to the app (dev server or `npm run preview` / a static
host). TTS Studio shows the bridge status in the **Engine & Voice** panel and
picks it up automatically — press **Retry** if you started it afterwards.

Notes:

- The first voice scan (Windows: PowerShell enumerating SAPI voices) can take
  a few seconds. `/ping` answers **instantly** while the scan warms up in the
  background; the voice list arrives on the next probe. Repeated probes share
  a single scan.
- In the bridge URL field you can type the bare host — `127.0.0.1` or
  `localhost` — and the app completes it to `http://127.0.0.1:8477`.
- Pages served over HTTPS (e.g. GitHub Pages) or from another machine on the
  LAN can reach this loopback bridge because the server answers Chrome's
  *Private Network Access* preflight (`Access-Control-Allow-Private-Network`).

Environment options:

```bash
PORT=8477 npm run os-tts                 # custom port
PIPER_VOICES_DIR=~/piper npm run os-tts  # expose Piper *.onnx models as voices
```

## How engine selection works now

- **OS Speech Engine (native)** (`os-bridge` model) — the default. Previews
  *and* file renders go through the real OS engine via the bridge.
- **Piper Neural (OS Bridge)** — same path, prefers Piper voices when
  installed (best realism).
- **OS Neural Voices / OS Classic Voices** — live previews speak through the
  browser's Web Speech API with the requested **voice class** (neural vs
  classic — the class is now actually honored); file renders go through the
  bridge when it is running, otherwise they fall back to the built-in engine
  with an explicit reason in the render log.
- **AuraVoice Formant \*** — the bundled formant engine, unchanged, always
  available offline.

Every render logs the engine that ACTUALLY produced the audio
(`Engine actually used: …`), so the selection can be verified at a glance.

## Voice mapping for multi-voice books

When AutoBook narrates a cast of characters through OS voices, each formant
voice profile is mapped deterministically to an OS voice (gender match when
the OS reports it, stable cycling otherwise), so different characters keep
different voices and the same character always sounds the same.

## Security notes

- The server binds to `127.0.0.1` only and never executes input as a shell
  command (engine CLIs receive argument arrays; text goes via stdin/file).
- Renders happen in the OS temp dir; files are deleted after streaming.
- Text is capped at 25,000 characters per request (the app chunks longer
  texts with sentence-aligned breathing pauses, same as the neural path).

## Troubleshooting

- **"Bridge not reachable"** — start it with `npm run os-tts`; if you host the
  app on HTTPS (GitHub Pages), some browsers block requests to
  `http://127.0.0.1`. Run the app locally (`npm run dev`) or set a custom
  bridge URL in the Engine & Voice panel.
- **No voices listed** — install an engine: Windows ships SAPI by default;
  `sudo apt install espeak-ng` on Debian/Ubuntu; Piper binaries and models
  from https://github.com/rhasspy/piper.
- **macOS pitch control** — `say` has no pitch parameter; pitch is ignored on
  that engine (rate and volume still apply; volume is applied in the app).

## Retired built-in voice packs

Earlier releases listed extra catalog entries — **AuraVoice Formant Core /
Studio**, **VoxMecha Lite**, **Storybook Voice Pack**, **WhisperKit Profiles**,
**Polyglot Latin Pack**, **Clarity Broadcast**, **DeepContext Pro** and
**EmotiveX Emotion Engine**. These were not real speech engines:

- All except Polyglot and Clarity were parameter presets of the built-in
  AuraVoice *formant* synthesizer (a parametric model that generates audio
  from math, not speech data), so they could never sound natural.
- "DeepContext Pro" and "EmotiveX" were explicitly *simulated* packs — no
  engine existed behind them.
- "Polyglot Latin Pack" and "Clarity Broadcast" were selectors over the same
  system neural voices as "OS Neural Voices (Auto-detect)".

They have been removed from the catalog. Every selectable engine now renders
through an established OS-level speech stack (SAPI 5 / Apple Speech /
espeak-ng / Piper). The formant synthesizer remains in the codebase only as:

1. the emergency fallback when the OS bridge is unreachable (the render log
   and a toast always disclose this), and
2. the persona format for character casts, whose profiles map onto real OS
   voices.

**Nothing needs to be installed or uploaded** to use the remaining engines —
Windows SAPI, macOS `say` and Linux espeak-ng ship with (or are one package
install away on) your OS. Piper is the only optional add-on, and it is purely
a local install (see Troubleshooting), never a GitHub upload.
