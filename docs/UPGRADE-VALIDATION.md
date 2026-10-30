# 0.4 upgrade validation

Base repository: https://github.com/img2vid/audiobookcreator
Base commit: `e7dffd47a7341e4869ff00ca5df3d77627ae5b9f` (main).
Validation date: 30 October 2026.

## Delivered changes

- A default Book Conversion Desk for sequential CPU-only narration with
  600-character chunks, chapter editing, pronunciation rules and actual engine
  selection. It stores PCM chunks transactionally and reuses matching results.
- Project JSON backup/restore, cross-tab render leases, storage/quota feedback,
  pause/stop, per-part rendering/playback/WAV/caption downloads, book ZIPs,
  transcripts, playlists and metadata. ZIP streaming has a guarded Blob fallback.
- An optional FFmpeg exporter for combined M4B/MP3/FLAC/WAV. Actual sample counts
  determine chapter durations. No GPU or whole-book in-memory audio buffer is used.
- EPUB reading-order repair with full spine processing; PDF.js text extraction;
  true Tesseract LSTM image/video OCR and bounded scanned-PDF rendering; robust
  ZIP DEFLATE, bounds, CRC, expansion and encryption checks.
- Studios are code-split and mounted on first visit. Conservative hardware defaults,
  optional model downloads disabled, and CUDA binary download disabled for install.
- Queue cancellation/status and closure-lifetime fixes, reliable test loader paths
  on Windows, a one-command two-service launcher, loopback static serving with
  range/HEAD support, bridge validation/admission control/process cleanup, and CI.

## Executed checks

Environment: Linux x64, Node 24.22.1, npm 11.9.0, Next.js 16.3.8 from the lockfile.

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed |
| `npm test` | 16 reliability/service tests and 44 existing engine checks passed |
| `npm run build` | Production static export passed |
| Chromium 153.0.8010.0, headless, `--disable-gpu` | Five end-to-end tests passed |
| Real FFmpeg M4B export + independent FFprobe | Two 1-second chapters, correct boundaries, title and author confirmed |
| ONNX native dependency postinstall with new `.npmrc` | Passed without CUDA download |
| Clean patch application and reconstructed-tree comparison | Verified on a clean base checkout; resulting Git tree matches the upgraded source |

The browser tests executed real bundled-formant audio synthesis (not a fake
AudioContext), decoded/played the resulting WAV, validated downloaded WAV/ZIP
bytes, reloaded and reused cached audio, read 65 reversed EPUB spine sections,
paused/cancelled, extracted PDF text in operator order, and recognized generated
image text through locally served Tesseract assets. The synthesis and OCR tests
blocked external requests. The tests also ship Firefox/WebKit projects, which
were not executed in this environment.

Bridge HTTP/process tests use an explicitly named fixture executable to exercise
serialization, validation, client-abort termination and request cleanup. They do
not validate SAPI, Apple `say`, eSpeak intelligibility, Piper models or voice quality.
The real M4B exporter test used FFmpeg/FFprobe with two generated PCM fixtures,
including filenames containing spaces and apostrophes.

## Practical limits and unverified combinations

This is a substantial working upgrade, not a claim that every existing studio,
format, operating system, browser version or hardware combination is fully fixed.
Windows and macOS native speech engines, Safari/Firefox, mobile browsers, actual
2–4 GB devices and multi-hour stress runs were not available for execution here.
The included CI matrix targets Windows/macOS/Linux with Node 22/24 and the three
browser engines; those remote jobs have not been run by this delivery.

The built-in synthesizer is robotic English speech. Installed OS/Piper voices
are the natural/multilingual path. File export cannot capture arbitrary Web Speech
voices. Missing speech engines, unsupported browser media codecs, DRM/encrypted
books and arbitrary binary file formats remain outside a universal guarantee.

Basic narration does not require models, network access or a GPU after installation.
Build/install needs network access; optional AI models, extra OCR languages and
OS voice packs need separate installation. A ready-to-run static build is supplied
separately to avoid compiling the GUI on the target low-end machine.

Book Desk bounds audio processing by a chunk and default parts by 6,000 characters.
Browser/disk quotas still apply. Non-streaming ZIP downloads stop at 128 MB, ZIP32
at 4 GB; individual parts are the fallback. Import/expansion limits are documented
in README. Captions align to chunks rather than words. Browser sleep/throttling
may delay rendering. An unclean tab shutdown may leave a lease for two minutes.

## Apply the patch

Start with a clean checkout of the base commit above, or check applicability
against your own checkout before applying. Preserve any work you already have.

```sh
git apply --check /path/to/audiobookcreator-cpu-upgrade.patch
git apply /path/to/audiobookcreator-cpu-upgrade.patch
npm ci
npm run build
npm run local
```

Open http://127.0.0.1:3000/. The patch includes the new source, launchers, tests,
lockfile, workflow and documentation; it does not include node_modules, compiled
out files, optional model weights or test-runtime browser binaries.
