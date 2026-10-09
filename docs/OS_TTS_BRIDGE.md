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
| Windows  | **Windows Natural Voices** via WinRT/OneCore (Aria, Jenny, Guy, all “Natural” neural voices, every language pack you added) **+ SAPI 5** via `System.Speech` (Microsoft David, Zira, legacy voices) |
| macOS    | **Apple Speech** — the `say` CLI (Samantha, Alex, premium voices…) |
| Linux    | **espeak-ng / espeak** (the standard Linux CLI speech engine) |
| Any      | **Piper** — established open-source *neural* TTS, for lifelike quality (optional) |

Why this matters: legacy SAPI 5 can only see the two classic desktop voices
(David, Zira). The **modern, far more natural** voices installed with Windows
live in the OneCore stack and are enumerated through the WinRT speech engine —
the bridge queries BOTH, so every voice installed on the machine is usable.

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
- **Only 2 voices listed (David, Zira)** — that is the legacy SAPI limit. The
  bridge (version 3+) also enumerates the modern OneCore/Natural voices
  (Aria, Jenny, Guy, …). To install MORE voices: Windows **Settings → Time &
  Language → Speech → Manage voices → Add voices**, restart the bridge.
- **`espeak-ng: false` on Windows though it is installed** — bridge version 3
  checks `C:\Program Files\eSpeak NG\espeak-ng.exe` even when it is not on
  PATH. Older bridges only looked on PATH (and Linux only).
- **Piper** — put `piper.exe` on PATH or in `C:\Program Files\piper\`, and
  its `*.onnx` models in a `voices` folder next to it (or set
  `PIPER_VOICES_DIR`). Models: https://github.com/rhasspy/piper.
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

## Bridge v4 — every "false" engine explains itself

Since bridge version 4, an engine that is not available is never a bare
`false` again:

- **Console**: under `Detected engines: {...}` the bridge prints one
  `id: false — <reason>` line per unavailable engine.
- **HTTP**: `/ping` and `/voices` include an `engineInfo` map with the same
  reasons; the app's bridge status box shows the first two reasons inline.
- **WinRT diagnosis**: the Windows enumeration now always emits a
  `WINRTINFO` line (projection state, PowerShell/.NET versions, voice count)
  or a `WINRTERROR` line (exception type, message and inner exception), plus
  a **registry cross-check** that counts the voice tokens under
  `Speech_OneCore` and `Speech`. Two distinct winrt-false cases result:
  1. *"0 OneCore voices are installed"* — the registry has no (or zero)
     modern-voice tokens. Typical of LTSC, Enterprise evaluation and
     de-bloated images. Fix: install voices via **Settings → Time &
     Language → Speech → Add voices**, or as admin:
     `Add-WindowsCapability -Online -Name Language.Speech~~~en-US~0.0.1.0`,
     then restart the bridge.
  2. *"WinRT projection failed: …"* — the speech API itself failed to load
     (security policy, broken runtime). The logged exception pinpoints it.
- **Transport hardening**: WinRT enumeration is sent to PowerShell via
  `-EncodedCommand` (UTF-16LE base64), immune to argument quoting issues,
  with a `-Command` retry fallback.

The static reasons for the remaining engines are intentional: `say` is
macOS-only, and `espeak-ng` / `espeak` / `piper` are optional installs —
their reasons include where to get them. Self-checks:
`node scripts/bridge-v4-checks.mjs` (static + live round-trip).
