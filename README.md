# Openmukti Audiobook Creator 0.4

Local document-to-audiobook software with a browser GUI and a local speech
companion. Balabolka CMD (Windows) renders non-Piper speech; Piper can be
selected explicitly. Neither engine requires a GPU.

## Run locally

Install Node.js **22.18+** (22/24 LTS supported). In the project folder:

```sh
npm ci
npm run build
npm run local
```

Open **http://127.0.0.1:3000/**. `npm run local` starts the static GUI and speech
bridge together. Stop them with Ctrl+C. After building, `start-local.bat` (Windows)
or `sh start-local.sh` (macOS/Linux) starts the same services. Install/build needs
an internet connection for npm packages; the built app operates offline. Keep
the `out` directory and scripts together. This is a source distribution, not an
installer or a prebuilt native executable.

For development: `npm run local:dev`. To run only the GUI: `npm start`. To run only
the bridge: `npm run os-tts`.

The `.npmrc` skips ONNX Runtime's unnecessary native CUDA download. If a newer
npm stops accepting that configuration, set `ONNXRUNTIME_NODE_INSTALL_CUDA=skip`
in your environment before `npm ci`.

## Convert a book

1. Open **Book Conversion Desk**, the default view. Import one or more documents,
   or expand **Import or paste a new book** to paste text. Review extracted text.
2. Enable local English OCR for image scans/scanned PDFs when needed. OCR uses
   Tesseract LSTM, bundled worker/WASM/language files, and one CPU worker.
3. Choose **Create book**. Headings become chapters; long chapters become parts
   of up to 6,000 characters. A preface and all text are retained.
4. Choose an installed Balabolka CMD voice or a Piper voice. Set rate,
   pitch and volume; add literal pronunciation substitutions if needed.
5. **Render / resume book** processes short chunks sequentially. Pause takes
   effect between chunks; Stop cancels bridge requests and discards any unfinished
   chunk. Finished chunks commit to IndexedDB before progress advances.
6. Preview a finished part, download its WAV/captions, or export the book ZIP.

Saved books and audio survive reloads in the same browser profile/origin.
Choose a saved book after reopening; rendering reuses valid completed chunks.
A different browser, a different origin/port, private mode, clearing browser data,
or browser storage eviction can make that storage unavailable. Use **Check local
storage**, save a project JSON backup, and download finished audio regularly.
After an unclean tab crash, a render lock can take up to two minutes to expire.

Changes to narration settings or text invalidate affected chunks. Changes to a
book/part title do not regenerate speech. Save edits before leaving. A project
JSON backup includes source text/settings/dictionary, **not** audio. Restoring
one creates a separate project. A complete book ZIP preserves the finished WAVs.

## Balabolka CMD (default) and Piper (optional)

All non-Piper speech generation uses **Balabolka's separate command-line
utility** (`balcon.exe`): book rendering, TTS Studio, dialogue and character
voice previews. Piper is used only when its model or voice is selected.
There is **no silent fallback to the old robotic formant renderer**.

**Windows setup:** get the command-line utility from
https://www.cross-plus-a.com/bconsole.htm and extract `balcon.exe` into a
folder of your choice. It is a **separate tool**, not the `balabolka.exe`
desktop app. Put `balcon.exe` on PATH, or set its path in PowerShell before
launching the app:

```powershell
$env:BALABOLKA_CMD = 'C:\Tools\Balabolka\balcon.exe'
npm run local
```

The bridge also searches common Balabolka install locations. To inspect
installed Windows SAPI voices, run `& $env:BALABOLKA_CMD -l` and choose an
available voice in the app. Balabolka does not create new neural voices:
audio quality is determined by the SAPI/Microsoft Speech Platform voices
already installed on the machine.

**macOS/Linux:** Balabolka CMD is Windows-only. Select Piper and install its
binary and `.onnx` voice models. Optionally configure `PIPER_VOICES_DIR`.
The app reports a clear error when the selected engine is unavailable.

**Verification:** start the app with `npm run local`, or run
`npm run os-tts` alongside the GUI. Check
http://127.0.0.1:8477/ping for `"balabolka":true` or `"piper":true`
and http://127.0.0.1:8477/voices for available voices.
Both engines run on CPU offline after installation; a hosted website cannot
execute a local program without the running bridge.

Balabolka CMD is distributed separately under the publisher's own license;
check the license before commercial use or redistribution. The project does
not bundle it. Previously cached robotic book chunks are invalidated on the
next render instead of silently being reused.

Conservative defaults target modest computers: no GPU, one queued heavy task,
one OCR worker, 22,050 Hz mono output, 600-character render chunks, and optional
large language-model downloads disabled. This bounds *render* memory by a short
chunk rather than the full book. It does not guarantee a particular speed or RAM
minimum; image decoding, OCR, browser overhead and old media studios still need
memory. Close studios/tabs you no longer need. Studios load only when first visited
and stay mounted afterward to preserve in-progress work.

## Files and exports

Primary document imports: TXT/Markdown, HTML, DOCX, ODT, EPUB, RTF, PDF text layers,
SRT/VTT, plus structured data. Image/scanned-PDF OCR is opt-in. EPUB follows the
package spine, supports relative/percent-encoded chapter paths, and reads beyond
40 sections. PDF.js resolves PDF font mappings and page order. Review complex
PDF columns, tables, OCR and RTF before rendering. OCR accuracy is not guaranteed.

File Studio still offers metadata/string inspection for many other extensions.
Recognizing an extension is **not** a full parser for that format. Legacy DOC,
DRM-protected ebooks, arbitrary binaries and unsupported media codecs are not
promised as readable books. Book Desk refuses binary string dumps/metadata as a
substitute for document text. Password-protected PDFs must be exported as an
unlocked copy first. Mixed scanned/text PDFs can be fully OCRed when OCR is selected.

Limits are explicit: 64 MB per imported file, 20 files per batch, 20 million book
characters, 12,000 characters per edited part, 10,000 ZIP entries, 32 MB expanded
per ZIP entry, 256 MB expanded per archive. Corrupt/encrypted/multi-volume/ZIP64
archives are rejected. Limits protect low-memory devices and prevent silent text
truncation. Split unusually large books into volumes.

WAV is the universal download path; the desk writes 16-bit mono 22,050 Hz PCM.
The book ZIP contains numbered WAVs, original part transcripts, chunk-aligned
WebVTT captions, an M3U8 playlist, `chapters.json` metadata and `project.json`.
Caption boundaries use rendered chunk durations, not word-level forced alignment.
ZIP output streams to disk when `showSaveFilePicker` is available. Else it uses
a Blob with a 128 MB safety cap; download parts individually for bigger books.
ZIP32 also caps the entire archive below 4 GB. Full-book PCM audio is never
concatenated into an AudioBuffer by Book Desk.

## Single M4B, MP3, FLAC or WAV

Install **FFmpeg** on PATH, download and extract the book ZIP, then:

```sh
node scripts/export-audiobook.mjs "path/to/extracted-book" "My Book.m4b"
# Or choose an output ending in .mp3, .flac or .wav
```

The CPU-only exporter streams chapter files through FFmpeg, reads actual PCM
sample durations, sets book/author/language tags and passes chapter metadata.
M4B stores AAC at 64 kb/s mono with chapters. MP3/FLAC/WAV chapter support varies
by player/container. Existing output files are never overwritten. Set
`FFMPEG_PATH` if FFmpeg isn't on PATH. The script consumes a folder produced by
Book Desk, not an arbitrary input document or a ZIP file directly.

## Browser/OS compatibility

Use a current Chrome, Edge, Firefox or Safari over local HTTP. The baseline uses
Web Audio, IndexedDB, Blob downloads, Web Workers and WASM; WebGPU, SharedArrayBuffer
and File System Access are optional. OS voice availability and recording codecs
vary. Existing video/transcription features retain their browser API requirements;
for example, speech recognition and every MediaRecorder codec are not available
in every browser. The app cannot make missing OS voices or unsupported codecs
available. `file://`, Internet Explorer and obsolete browsers are not supported.

Implemented for Windows/macOS/Linux. The accompanying validation report distinguishes
executed tests from the CI matrix; no universal hardware/browser guarantee is made.

The servers bind to 127.0.0.1. Local speech accepts loopback browser origins only,
with a Host check and one active synthesis process. To intentionally connect a
trusted hosted UI, set `BRIDGE_ALLOWED_ORIGINS` to its exact origin(s), comma
separated, when starting the bridge. This is unnecessary for the local app.

## Verify

```sh
npm run typecheck
npm run lint
npm test
npm run build
npx playwright install chromium firefox webkit
npm run test:e2e
```

The browser suite covers actual CPU synthesis, playback/downloads, reload/cache
reuse, EPUB spine ordering, pause/cancel, PDF operator ordering and local OCR.
CI defines core checks on Windows/macOS/Linux with Node 22/24, plus a Linux
Chromium/Firefox/WebKit browser job. Defining CI is not evidence those remote jobs
have run. See `docs/UPGRADE-VALIDATION.md` for executed results and remaining limits.
