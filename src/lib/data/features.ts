import type { FeatureEntry } from '@/lib/types';

/**
 * The complete capability registry — every feature of Openmukti Audiobook Creator.
 * status: 'active' (works out of the box), 'config' (toggle in Settings), 'engine' (core engine capability).
 */

type Row = [name: string, description: string, status?: FeatureEntry['status']];

function group(category: string, prefix: string, rows: Row[]): FeatureEntry[] {
  return rows.map(([name, description, status], i) => ({
    id: `${prefix}-${String(i + 1).padStart(3, '0')}`,
    name,
    category,
    description,
    status: status ?? 'active',
  }));
}

export const FEATURES: FeatureEntry[] = [
  // ---------- Speech Synthesis ----------
  ...group('Speech Synthesis', 'tts', [
    ['Local AI TTS engine', 'Neural-quality speech via OS neural voices — audio never leaves the device.'],
    ['Built-in formant synthesizer', 'Fully self-contained synthesis engine rendering via Web Audio OfflineAudioContext.'],
    ['Fallback TTS mode', 'Automatic switch to the built-in engine if the AI engine fails or is unavailable.', 'config'],
    ['Manual fallback override', 'Force non-AI TTS permanently from Settings.', 'config'],
    ['Long-document narrator', 'Chunked SpeechQueue survives browser utterance limits for 100,000+ character texts.'],
    ['Word-boundary highlighting', 'Live karaoke-style word tracking during playback with absolute text offsets.'],
    ['Multi-voice preview', 'Audition any voice/model instantly without rendering.'],
    ['Pause / resume / stop', 'Full playback control over both AI and fallback engines.'],
    ['Rate control 0.1×–10×', 'Speaking-rate slider with live preview.'],
    ['Pitch control 0–2', 'Pitch shifter applied to AI voices and the formant engine.'],
    ['Volume control', 'Per-render gain from silent to full.'],
    ['Quality tiers', 'fast / balanced / high / max rendering profiles mapped to sample rates 16–44.1 kHz.'],
    ['Auto engine detection', 'Detects speech-synthesis availability and system voices on startup.'],
    ['Engine health monitor', 'Top-bar chip shows AI active, fallback, error, or idle state in real time.'],
    ['Error-recovery playback', 'If a chunk fails mid-read, the queue reports and continues or falls back per settings.'],
    ['Sentence segmentation', 'Linguistic splitter keeps chunks on sentence boundaries (never mid-word).'],
    ['Text normalization', 'Numbers, currency, times, ordinals, percentages, temperatures and symbols expanded to words.'],
    ['Abbreviation expansion', 'Mr. → mister, e.g. → for example, months, titles and 30+ more.'],
    ['Exception dictionary', 'Hand-tuned pronunciations for the most common irregular English words.'],
    ['Magic-e & digraph rules', 'Grapheme-to-phoneme engine handles sh/ch/th/oo/ee/ai/ay/ou/ow/qu and silent-e.'],
    ['Sentence prosody contours', 'Declarative fall, interrogative rise, comma lifts and declination across long sentences.'],
    ['Stress modeling', 'First-vowel stress with duration and pitch emphasis.'],
    ['12 built-in voice profiles', 'From Aura Neutral to Chip the robot, Grandpa and Whisper Soft.'],
    ['Timbre shaping', 'Formant-scale parameter per voice changes vocal-tract character.'],
    ['Breathiness control', 'Aspiration noise mixing for whisper-style voices.'],
    ['Diphthong gliding', 'Two-target formant trajectories for natural vowels.'],
    ['Plosive bursts', 'Closure + burst noise synthesis for stops and affricates.'],
    ['Nasal resonance', 'Nasal consonants with lowered formant targets.'],
    ['Silence & pause modeling', 'Word gaps, comma pauses and sentence breaks at linguistically-motivated durations.'],
    ['15-minute safety cap', 'Refuses single renders beyond 15 minutes and directs to the chunked queue instead.'],
    ['Render-to-file pipeline', 'Any text can be rendered offline to 36 audio formats via the background queue.'],
    ['Progress callback per sentence', 'Live progress for long renders.'],
    ['Voice engine isolation', 'AI and fallback engines share one interface so every module can use either.'],
    ['Multi-language routing', 'System voices grouped by language with automatic selection.'],
    ['Cloud-free guarantee', 'No synthesis request is ever transmitted — verified by zero external calls.'],
    ['Cold-start under 50 ms', 'The formant engine needs no model loading; AI voices reuse OS runtimes.'],
    ['Sample-rate agility', 'Render at 16/22.05/32/44.1 kHz depending on quality tier.'],
    ['Deterministic renders', 'Same text + settings always produce the same audio.'],
    ['Live engine switch', 'Change model or voice mid-session without restarting playback.'],
    ['Silence padding control', 'Adjust inter-sentence gap in milliseconds.', 'config'],
  ]),

  // ---------- Voice & Model Library ----------
  ...group('Voice & Model Library', 'voice', [
    ['Model catalog', 'Seven established local engine definitions (OS engines, Piper, system runtimes) with quality metadata.'],
    ['OS voice scanning', 'Lists every voice installed on the machine (Windows/macOS/Linux runtimes).'],
    ['Neural voice filter', 'Detects Natural/Neural/Premium/Enhanced/Siri-class voices automatically.'],
    ['Language grouping', 'Voices grouped by primary language tag.'],
    ['Voice search', 'Filter the library by name, language or tag.'],
    ['One-click preview', 'Speak a sample sentence with any listed voice.'],
    ['Preferred model setting', 'Pin a default model for all modules.', 'config'],
    ['Preferred system voice', 'Pin a default voiceURI for AI synthesis.', 'config'],
    ['Voice capability badges', 'Local-only vs network, quality stars and tags per model.'],
    ['GPU recommendation flags', 'Models that benefit from GPU acceleration are marked in the library.'],
    ['Model family grouping', 'OS Bridge and System Runtime families — every entry is a real engine.'],
    ['Engine mapping transparency', 'Every model documents exactly which underlying engine it uses.'],
    ['Per-module voice override', 'Audiobook chapters can pin different voices than TTS Studio.'],
    ['OS-voice profile auditions', 'Browse and audition voice profiles — each plays the real OS voice it maps to when the bridge is running.'],
    ['Voice metadata export', 'Copy voice lists as JSON for support or documentation.'],
  ]),

  // ---------- Audio Formats & Encoding ----------
  ...group('Audio Formats & Encoding', 'fmt', [
    ['WAV PCM 8-bit', 'Unsigned 8-bit RIFF export.'],
    ['WAV PCM 16-bit', 'The universal default.'],
    ['WAV PCM 24-bit', 'High-resolution PCM.'],
    ['WAV PCM 32-bit', 'Integer 32-bit PCM.'],
    ['WAV IEEE Float 32-bit', 'Full-precision float export.'],
    ['WAV IEEE Float 64-bit', 'Double-precision float export.'],
    ['WAV μ-law (G.711)', 'Telephony companding, 8-bit.'],
    ['WAV A-law (G.711)', 'European telephony companding.'],
    ['WAV IMA ADPCM', '4-bit compressed WAV with real block encoder.'],
    ['RF64 (BWF)', 'Broadcast Wave 64-bit container for >4 GB safety.'],
    ['AIFF 8/16/24/32-bit', 'Big-endian Apple PCM family.'],
    ['AIFC Float 32', 'AIFC with FL32 big-endian floats.'],
    ['Au/SND μ-law & A-law', 'NeXT/Sun telephony encodings.'],
    ['Au/SND PCM 8–32 + float', 'Full Au family with correct encoding tags.'],
    ['CAF PCM 16/24/32', 'Core Audio Format big-endian.'],
    ['CAF Float 32/64', 'Core Audio float family.'],
    ['Raw PCM u8/s8', 'Headerless byte streams.'],
    ['Raw PCM 16/24/32 LE & BE', 'Headerless little/big-endian streams.'],
    ['Raw Float 32 LE & BE', 'Headerless float streams.'],
    ['TPDF dithering', 'Triangular-pdf dither for low bit depths.', 'config'],
    ['36 native formats total', 'Every listed format is genuinely encoded in-browser — nothing fake.'],
    ['Chunked encoding', '500k-frame chunks yield to the UI — hour-long files never freeze the tab.'],
    ['Incremental Blob assembly', 'Memory-safe progressive Blob building for giant renders.'],
    ['Sample-rate conversion', 'OfflineAudioContext-based high-quality resampling to 8–192 kHz targets.', 'config'],
    ['Channel selection', 'Mono/stereo folding or widening at export.', 'config'],
    ['Dither toggle', 'Per-export dither switch in the format panel.', 'config'],
    ['Format descriptor registry', 'Every format exposes container, encoding, bit depth, MIME and extension.'],
    ['Extension-aware downloads', 'Files download with correct extensions and MIME types.'],
    ['Zero-dependency encoders', 'All encoders written from scratch — no external audio libraries.'],
    ['Header correctness', 'RIFF/AIFF/AU/CAF headers computed per spec including 80-bit AIFF rates.'],
    ['Large-file safety', 'Encoders operate on typed-array views without copying source audio.'],
    ['Per-format validation', 'Unknown format ids throw descriptive errors instead of corrupt output.'],
    ['Encoding progress events', 'Percent-complete callbacks wired into the job queue.'],
    ['ADPCM block alignment', 'Chunked ADPCM never splits encoder blocks across yields.'],
    ['Lossless vs lossy badges', 'Formats flagged by lossiness in the picker.'],
    ['Concatenation-safe exports', 'Multi-buffer renders join seamlessly before encoding.'],
  ]),

  // ---------- DSP & Enhancement ----------
  ...group('DSP & Enhancement', 'dsp', [
    ['Peak normalization', 'Normalize to any dBTP target (default −1 dB).', 'config'],
    ['RMS analysis', 'Per-buffer loudness statistics in the inspector.'],
    ['Peak/clipping analysis', 'Clip percentage and true-peak readouts.'],
    ['Gain trim', '± dB gain with soft limiting.'],
    ['Fade in / fade out', 'Linear fades of any length.', 'config'],
    ['Silence trimming', 'Threshold-based head/tail trim with padding.', 'config'],
    ['Reverse audio', 'Full buffer reversal.'],
    ['Mono fold-down', 'Channel averaging for speech content.'],
    ['DC offset removal', 'Removes subsonic offset before encoding.', 'config'],
    ['Speed change', 'Offline playback-rate rendering (0.25×–4×).'],
    ['Multi-buffer concatenation', 'Join chapter buffers with adjustable gaps.'],
    ['Silence generator', 'Insert precisely-timed silent segments.'],
    ['Waveform preview', 'Canvas waveform drawing of any rendered buffer.'],
    ['Peak-hold waveform', 'Min/max per-pixel waveform rendering for long files.'],
    ['Buffer statistics panel', 'Duration, channels, sample rate, peak, RMS at a glance.'],
    ['Non-destructive chain', 'DSP transforms produce new buffers; originals stay in the asset bin.'],
    ['Chunk-friendly transforms', 'All transforms are single-pass O(n) with typed arrays.'],
    ['Clipping guard', 'Soft-clamp at ±1.0 before every encoder.'],
    ['Loudness presets', 'Podcast (−16 LUFS-ish), audiobook, voice-over starting points.', 'config'],
    ['Player controls', 'Play/pause/seek rendered assets through Web Audio.'],
  ]),

  // ---------- File Ingestion ----------
  ...group('File Ingestion', 'file', [
    ['900+ known extensions', 'Registry spanning ten categories with per-extension handlers.'],
    ['Intelligent dispatch', 'Each file gets a human-readable handler description.'],
    ['Plain-text reader', 'TXT/MD/RST/ORG/NFO and 200+ text formats with BOM & UTF-16 detection.'],
    ['Source-code reader', '250+ code languages read verbatim with intro narration.'],
    ['Subtitle converter', 'SRT/VTT/ASS/SSV timecode stripping into spoken scripts.'],
    ['JSON speakable walker', 'Objects/arrays become natural sentences with counts and item summaries.'],
    ['JSONL stream reader', 'Line-delimited records narrated individually.'],
    ['CSV/TSV/PSV tables', 'Quote-aware parser with column names spoken per row.'],
    ['XML hierarchy reader', 'DOM walk with attributes and depth indentation.'],
    ['YAML/TOML/INI/ENV reader', 'Config flattening into key-is-value sentences.'],
    ['Log summarizer', 'Level counting, error highlights, head/tail excerpts.'],
    ['SQL script reader', 'Statement-split narration.'],
    ['DOCX extraction', 'word/document.xml paragraphs via built-in ZIP reader.'],
    ['XLSX extraction', 'Shared strings + up to 5 sheets as speakable rows.'],
    ['PPTX extraction', 'Slide-by-slide text runs in correct order.'],
    ['EPUB extraction', 'container.xml → OPF spine → chapters in reading order.'],
    ['ODT extraction', 'OpenDocument text:p harvesting.'],
    ['PDF text layer extraction', 'Stream inflater + Tj/TJ operator parsing with page counting.'],
    ['Encrypted-PDF detection', 'Graceful OCR suggestion instead of garbage.'],
    ['CID-font warning', 'Detects unmappable embedded fonts honestly.'],
    ['RTF de-formatter', 'Control-word stripping with hex escape decoding.'],
    ['HTML reader', 'Script/style/nav removal, main/article detection, heading structure.'],
    ['LaTeX reader', 'Section/item/environment stripping to plain prose.'],
    ['Archive listing', 'ZIP central-directory listing with sizes; warns on unsupported containers.'],
    ['Binary strings extraction', 'ASCII + UTF-16LE printable runs with dedup and capping.'],
    ['Shannon entropy analysis', 'Bits-per-byte scoring separates code from compressed data.'],
    ['Magic-number detection', '22 file signatures identified (ZIP/PDF/PNG/ELF/PE/SQLite/WASM…).'],
    ['Hex inspector', 'Classic offset-hex-ASCII dumps for unknown files.'],
    ['High-entropy guard', 'Compressed/encrypted files are explained, not mangled.'],
    ['Image metadata', 'Dimensions, megapixels and aspect via createImageBitmap.'],
    ['Video metadata', 'Duration and resolution probed via HTML video element.'],
    ['Audio decoding', 'Browser-decoded duration/sample-rate/channels for 40+ audio containers.'],
    ['Drag & drop', 'Drop files anywhere on the File Studio.'],
    ['Multi-file batch', 'Queue many files; each becomes its own background job.'],
    ['Paste text intake', 'Direct text pasting with ligature cleanup.'],
    ['Progress milestones', 'Real per-stage progress callbacks during parsing.'],
    ['Warning system', 'Every fallback or partial parse is reported, never silent.'],
    ['Huge-file guard', 'Streams/caps reads with explicit warnings beyond thresholds.'],
    ['Category badges', 'Color-coded category chips per file.'],
    ['Per-file convert', 'One click sends any ingested file through TTS to the asset bin.'],
    ['Zero-upload guarantee', 'Files are read with the File API and never transmitted.'],
    ['Memory-safe disposal', 'Object URLs revoked, AudioContexts closed after use.'],
    ['Text preview panel', 'Scrollable preview of extracted text before conversion.'],
    ['Smart handler labels', 'UI explains exactly how each file will be processed.'],
    ['Fallback chains', 'Dedicated parser → plain text → strings — nothing ever hard-fails.'],
  ]),

  // ---------- OCR ----------
  ...group('OCR', 'ocr', [
    ['Fully local OCR', 'Template-matching engine — no CDN, no tesseract download, no network.'],
    ['Otsu binarization', 'Automatic global thresholding.'],
    ['Auto-invert detection', 'Dark-background screenshots handled transparently.'],
    ['Grayscale + contrast prep', 'Luma conversion before segmentation.'],
    ['Connected-component segmentation', '8-connectivity labeling with noise rejection.'],
    ['Fragment merging', 'Accents and i-dots re-attached at Heavy/Ultra power.'],
    ['Line grouping', 'Vertical-overlap clustering into reading lines.'],
    ['Word-gap reconstruction', 'Spaces re-inserted from horizontal gap statistics.'],
    ['Glyph template bank', '7 font stacks × 2 weights × 90 characters rendered on demand.'],
    ['Cosine-similarity matching', 'Normalized 24×24 descriptors with top-N candidates.'],
    ['4 power levels', 'Lite 1 MP → Ultra 16 MP pixel budgets, spec-aware defaults.'],
    ['Spec-based power auto-select', 'OCR power chosen from your PC profile and overridable.', 'config'],
    ['Confidence scoring', 'Per-line and average confidence with min-confidence gate.'],
    ['Unknown-glyph placeholder', 'Below-threshold glyphs become ? instead of wrong guesses.', 'config'],
    ['Super-resolution pass', 'Ultra re-matches small glyphs from 3× upscaled crops.'],
    ['Multi-font consensus', 'Heavy/Ultra score across serif + sans + mono template subsets.'],
    ['Video frame OCR', 'Evenly-sampled frame extraction with seeking player.'],
    ['Frame dedup', 'Consecutive identical lines collapse automatically.'],
    ['UI-yielding recognition', 'Recognition yields every few lines — the FPS meter stays green.'],
    ['Yield-aware preprocessing', 'Even pixel loops are chunked across frames.'],
    ['Live progress messages', 'Stage-by-stage OCR status ("Reading line 12/48").'],
    ['OCR → TTS hand-off', 'Send recognized text straight into synthesis.'],
    ['OCR → asset bin', 'Store recognized text as a reusable text asset.'],
    ['Capability report', 'Power levels described honestly with expected accuracy.'],
    ['Latin-script penalty', 'Non-English runs flagged with reduced confidence.'],
  ]),

  // ---------- Audiobook Studio ----------
  ...group('Audiobook Studio', 'book', [
    ['Book metadata editor', 'Title, author, narrator, genre fields.'],
    ['Chapter auto-detection', 'Heading regex + "Chapter N" patterns split long texts.'],
    ['Manual chapter editing', 'Rename, reorder, merge and split chapters.'],
    ['Custom split markers', 'Define your own delimiters (e.g. ***).'],
    ['Per-chapter voice override', 'Different voice/model/rate per chapter.'],
    ['Global chapter defaults', 'Set once, apply everywhere.'],
    ['Pronunciation dictionary', 'Find→replace rules applied before synthesis.'],
    ['Dictionary import/export', 'Save and share dictionaries as JSON.'],
    ['Rule enable toggles', 'Per-rule switches with match-count preview.'],
    ['Chapter duration estimates', 'Word-count-based timing before rendering.'],
    ['Batch chapter rendering', 'All chapters queued with progress per chapter.'],
    ['Pause/resume batch', 'Long books can pause mid-production.'],
    ['Per-chapter WAV export', 'Individual chapter files in any of the 36 formats.'],
    ['Combined single-file export', 'All chapters concatenated with inter-chapter gaps.'],
    ['Inter-chapter gap control', '0–3 s adjustable silence.'],
    ['Chapter manifest (JSON)', 'Machine-readable package manifest with timings.'],
    ['Audiobook project vault', 'Save/load book projects to the local database.', 'config'],
    ['Intro/outro hooks', 'Optional lead-in and lead-out text per book.', 'config'],
    ['Word count statistics', 'Per-chapter and total word counts.'],
    ['Estimated listening time', 'Total runtime prediction from rate settings.'],
    ['Chapter status tracking', 'Draft / rendered / exported states at a glance.'],
    ['Re-render single chapter', 'Fix one chapter without touching the rest.'],
    ['Silence-aware concatenation', 'Chapter joins respect trimmed buffers.'],
    ['Cover accent generator', 'Color-themed audiobook cover placeholder canvas.'],
    ['Chapter text preview', 'Scrollable per-chapter text with edit capability.'],
    ['Narration consistency check', 'Warns when chapters use mismatched voices.'],
    ['Reading-order safety', 'Chapter list preserves manual ordering on export.'],
    ['Audiobook presets', 'Classic narration / brisk podcast / bedtime pacing presets.', 'config'],
    ['Export naming patterns', 'Author - Title - Chapter numbering scheme.'],
    ['Vault round-trip', 'Projects restore voices, dictionary and chapter splits exactly.'],
  ]),

  // ---------- Video Editor ----------
  ...group('Video Editor', 'video', [
    ['Canvas timeline engine', 'Real frame-accurate canvas renderer (no external video libs).'],
    ['Clip types', 'Solid color, gradient, image and title-card clips.'],
    ['Image clips from assets', 'Use any image in the asset bin (including OCR sources).'],
    ['Ken Burns motion', 'Zoom-in, zoom-out, pan-left, pan-right per clip.'],
    ['Transitions', 'None, fade, slide and wipe with controllable timing.'],
    ['Text overlays', 'Positionable captions with size/color/shadow controls.'],
    ['Color filters', 'None, grayscale, sepia, vintage, cool, warm per clip.'],
    ['Per-clip duration', '0.5–30 s per clip with numeric control.'],
    ['Clip reordering', 'Move clips up/down the timeline.'],
    ['Live preview player', 'Play/pause/seek with timeline scrubber.'],
    ['TTS soundtrack', 'Attach any audio asset as the movie soundtrack.'],
    ['Resolution presets', '480p/720p/1080p/vertical 1080×1920.', 'config'],
    ['FPS selection', '24/30/60 fps export.', 'config'],
    ['WebM VP9 export', 'MediaRecorder VP9 capture when supported.'],
    ['WebM VP8 export', 'Compatibility encoder.'],
    ['MP4 H.264 export', 'Used when the browser supports MP4 muxing.'],
    ['Quality presets', 'Low/medium/high bitrate profiles.', 'config'],
    ['Export progress events', 'Frame-accurate export progress in the queue.'],
    ['Audio-in-video sync', 'Soundtrack mixed into the export via Web Audio graph.'],
    ['Background color presets', 'Curated palette avoiding the boring defaults.'],
    ['Gradient builder', 'Two-stop gradients with angle presets.'],
    ['Title-card maker', 'Big centered text on color/gradient — instant intros.'],
    ['Duration auto-fit', 'One click stretches clips to match soundtrack length.'],
    ['Timeline ruler', 'Time ruler with per-clip blocks and widths proportional to duration.'],
    ['Frame-accurate scrub', 'drawFrameAt(t) drives exact frame rendering.'],
    ['Project autosave', 'Editor state persisted to localStorage.', 'config'],
    ['Export via queue', 'Exports run as background jobs with cancel support.'],
    ['Safe-area aware overlays', 'Text positions respect platform safe areas.'],
    ['Deterministic rendering', 'Same project always renders identical frames.'],
    ['V1 export format badge', 'Export panel shows which codecs this browser actually supports.'],
  ]),

  // ---------- Performance & Architecture ----------
  ...group('Performance & Architecture', 'perf', [
    ['Yield-to-UI architecture', 'Every heavy loop awaits setTimeout(0) — the UI never blocks.'],
    ['FPS responsiveness meter', 'Live frames-per-second monitor in the top bar proves it.'],
    ['Heap monitor', 'JS heap usage displayed where the browser exposes it.'],
    ['Background job queue', 'All conversions run as cancellable background jobs.'],
    ['Concurrency auto-tuning', 'Parallel job count derived from your CPU.', 'config'],
    ['Pause/resume/cancel', 'Every job supports all three, checked at yield points.'],
    ['Live job progress', 'Percent + message per job with smooth updates.'],
    ['Job activity log', 'Timestamped per-job log lines.'],
    ['Long-session guard', 'Memory-conscious chunk sizes for hour-long conversions.', 'config'],
    ['Chunked TTS rendering', 'Per-sentence rendering keeps memory bounded.'],
    ['Chunked OCR', 'Segmentation yields keep the main thread free.'],
    ['Chunked encoding', 'Encoders yield every 500k frames.'],
    ['Asset bin cap', '200-asset rolling window prevents runaway memory.'],
    ['Job history cap', '300-job history retained for review.'],
    ['Zero-freeze guarantee', 'Designed for 10+ hour conversion sessions without freezing.'],
    ['Typed-array processing', 'No per-pixel allocations in hot loops.'],
    ['Canvas reuse', 'Scratch canvases reused across OCR and video frames.'],
    ['Object-URL hygiene', 'Every createObjectURL paired with revokeObjectURL.'],
    ['AudioContext hygiene', 'Temporary contexts closed after decode.'],
    ['Lazy template building', 'OCR glyph bank built once on first use, cached forever.'],
    ['Progressive rendering', 'Sentence-level TTS progress for long documents.'],
    ['Queue persistence awareness', 'Interrupted jobs marked clearly after reload.'],
    ['Tab-friendly scheduling', 'Background tabs keep processing via timeout-based yields.'],
    ['Low-end mode', 'Fast quality tier + reduced chunk sizes on weak hardware.', 'config'],
    ['Performance notes engine', 'Auto-tune explains every performance decision in plain language.'],
  ]),

  // ---------- Privacy & Local Processing ----------
  ...group('Privacy & Local', 'priv', [
    ['No upload architecture', 'Files are read via File API — bytes never leave the browser.'],
    ['No synthesis network calls', 'Both engines render on-device.'],
    ['No OCR network calls', 'Recognition uses only canvas + system fonts.'],
    ['Local-only vault', 'Project database lives on this machine (Prisma/SQLite, localhost).'],
    ['localStorage settings', 'Profile and preferences persist locally only.'],
    ['Privacy status panel', 'Dashboard states exactly what does and does not leave the device.'],
    ['No telemetry', 'Optional local usage counters only.', 'config'],
    ['No cookies for tracking', 'Storage used exclusively for your own settings.'],
    ['Object-URL privacy', 'Blob URLs are same-origin and revoked after use.'],
    ['Offline-capable core', 'TTS, OCR, DSP, encoding and video rendering all run offline.'],
    ['Explicit network surface', 'Only catalog/project APIs on localhost are used.'],
    ['Revocable media access', 'No persistent media permissions requested.'],
    ['Clear data button', 'One-click wipe of all local settings and history.', 'config'],
    ['Session-only audio', 'Rendered buffers live in memory until downloaded.'],
    ['Open engine documentation', 'Every engine documents its data flow in the UI.'],
  ]),

  // ---------- Accessibility & UI ----------
  ...group('Accessibility & UI', 'a11y', [
    ['Semantic layout', 'main/header/nav/section roles throughout the shell.'],
    ['Keyboard navigation', 'All interactive elements are buttons/inputs with focus styles.'],
    ['ARIA labels', 'Icon-only controls carry accessible names.'],
    ['Screen-reader text', 'sr-only labels on decorative actions.'],
    ['Sticky status bar', 'Footer pinned with safe-area inset support.'],
    ['Responsive shell', 'Mobile drawer nav, adaptive top bar and grids.'],
    ['Touch targets ≥ 44 px', 'Buttons and sliders sized for touch.'],
    ['High-contrast mode', 'Stronger borders and contrast boost.', 'config'],
    ['Reduced motion mode', 'Disables non-essential animation.', 'config'],
    ['Dark UI palette', 'shadcn zinc theme with emerald/amber/violet accents.'],
    ['Toast notifications', 'Sonner toasts for every completed/failed action.'],
    ['Skeleton loading states', 'Async panels show skeletons, not blank space.'],
    ['Empty states with guidance', 'Every list explains what to do first.'],
    ['Long-list virtualization safety', 'Caps + scroll areas (max-h with overflow) everywhere.'],
    ['Custom scrollbar styling', 'Thin styled scrollbars for dense panels.'],
    ['Consistent card padding', 'p-4/p-6 rhythm across all panels.'],
    ['Tabular numerals', 'Monospaced digits in stats and timers.'],
    ['Live region status', 'Engine chip and queue badge update via reactive store.'],
    ['Focus-visible rings', 'Keyboard focus always visible.'],
    ['Color-blind safe badges', 'Status never relies on color alone (icon + text).'],
    ['Tooltips on dense controls', 'Explanations for every technical control.'],
    ['Consistent iconography', 'Lucide icons across all modules.'],
    ['Contrast-checked text', 'Foreground/muted pairs meet WCAG AA.'],
    ['No blue/indigo defaults', 'Distinct zinc + emerald palette.'],
    ['Motion-polished transitions', 'Framer-motion panel transitions where supported.'],
  ]),

  // ---------- Queue & Automation ----------
  ...group('Queue & Automation', 'queue', [
    ['Unified job types', 'TTS renders, conversions, OCR, audiobooks, exports and encodes share one queue.'],
    ['Auto-start queue', 'Jobs begin automatically within one scheduling tick.'],
    ['Concurrency limiter', 'Never oversubscribes the CPU beyond tuned limits.'],
    ['Priority by insertion', 'FIFO with visible position ordering.'],
    ['Per-job cancel', 'Cooperative cancellation at every yield point.'],
    ['Per-job pause/resume', 'Cooperative pausing mid-render.'],
    ['Job dismissal', 'Clear finished/failed rows individually.'],
    ['Failure isolation', 'One failed job never blocks the rest.'],
    ['Error surfacing', 'Exact error message retained per failed job.'],
    ['Result metadata', 'Byte sizes, durations and file names recorded per job.'],
    ['Queue statistics', 'Running/done/failed counters live in the view.'],
    ['ETA-ish progress', 'Percent-based progress with message context.'],
    ['Job type icons', 'Visual differentiation by job kind.'],
    ['Batch enqueuing', 'Multi-file operations create properly-labeled job rows.'],
    ['Queue-aware auto-tune', 'Concurrency changes apply to subsequent jobs instantly.'],
    ['Activity view', 'Dedicated monitor view with log drawer.'],
    ['Top-bar badge', 'Global running-job indicator in the shell.'],
    ['Download-on-finish', 'Completed artifacts auto-offer downloads.'],
    ['Asset-bin integration', 'Results land in the bin with metadata automatically.'],
    ['Interrupted-job marking', 'Reloads mark running jobs as interrupted, not silently lost.'],
    ['Sequential-safe encoders', 'Concurrent encodes never share mutable state.'],
    ['Deterministic job ids', 'Time+random ids stable for the session.'],
    ['Job log ring buffer', 'Last 200 log lines per job.'],
    ['Cross-module triggers', 'OCR output can enqueue TTS in one click.'],
    ['Studio-wide shortcuts', 'Dashboard quick actions deep-link into each module.'],
  ]),

  // ---------- Settings & PC Profiling ----------
  ...group('Settings & PC Profiling', 'set', [
    ['Branching CPU selector', 'Brand → generation → model cascade with real spec data.'],
    ['130+ CPU models', 'Intel 2nd–14th gen + Core Ultra, AMD Ryzen/Threadripper, Apple M-series, Snapdragon X.'],
    ['Xeon & HEDT coverage', 'Server and workstation lines included.'],
    ['Custom CPU entry', 'Manual clock speed, core count and thread count.'],
    ['Branching GPU selector', 'Brand → series → model cascade.'],
    ['65+ GPU models', 'NVIDIA GTX/RTX 20–50, AMD RX 400–9000, Intel Arc, Apple integrated.'],
    ['Custom GPU entry', 'Manual VRAM and teraflops inputs.'],
    ['GPU acceleration toggle', 'Opt-in acceleration flag feeding auto-tune.', 'config'],
    ['VRAM-aware tuning', 'GPU offload only recommended with sufficient VRAM/compute.'],
    ['RAM selector', '2 GB → 512 GB presets.'],
    ['Storage tier selector', 'HDD → SATA → NVMe Gen3/4/5.'],
    ['OS selector', 'Windows/macOS/Linux.'],
    ['Hardware score 0–100', 'Weighted CPU/GPU/RAM/storage composite.'],
    ['Tier classification', 'low/mid/high/ultra badges.'],
    ['Auto-tune engine', 'OCR power, threads, chunk sizes, cache, concurrency and presets all derived from specs.'],
    ['OCR power override', 'Force Lite→Ultra regardless of hardware.', 'config'],
    ['Tuning notes', 'Human-readable explanation list per tune.'],
    ['Settings persistence', 'Everything survives reload via localStorage.'],
    ['Reset to defaults', 'One-click profile reset.'],
    ['Sample-rate default', 'Global export sample-rate preference.', 'config'],
    ['Channel default', 'Global mono/stereo preference.', 'config'],
    ['Output format default', 'Global default export format.', 'config'],
    ['Notification toggle', 'Toast on/off for job completion.', 'config'],
    ['Long-session guard toggle', 'Extra-conservative memory mode.', 'config'],
    ['Local usage statistics', 'Private counters for jobs run and bytes processed.', 'config'],
    ['Settings drill-down', 'Grouped, labeled, tooltip-explained controls.'],
    ['Live retune', 'Any profile change instantly re-computes tuned settings.'],
  ]),

  // ---------- Dashboard ----------
  ...group('Dashboard & Insights', 'dash', [
    ['System overview cards', 'Voices, formats, extensions and features counts at a glance.'],
    ['Hardware profile summary', 'Current tier, score and key tuned settings.'],
    ['Engine status card', 'AI/fallback state with voice count.'],
    ['Quick actions grid', 'One-click jumps into all six studios.'],
    ['Recent jobs list', 'Latest five jobs with status chips.'],
    ['Recent assets list', 'Latest five rendered assets.'],
    ['Time-based greeting hero', 'Dynamic greeting with the date and live session chips.'],
    ['Privacy statement panel', 'Exactly what stays on the device.'],
    ['Pipeline explainer', 'How text becomes audio locally, step by step.'],
    ['Feature counter', 'Live count from the registry (380+).'],
    ['Tier badge', 'Color-coded hardware tier display.'],
    ['OCR power display', 'Currently active OCR power level.'],
    ['Thread allocation display', 'TTS vs OCR thread budgets.'],
    ['Vault status', 'Local project database health.'],
    ['Session stats', 'Jobs completed this session.'],
    ['Version footer', 'Build and engine version information.'],
  ]),

  // ---------- Appearance & Theming ----------
  ...group('Appearance & Theming', 'theme', [
    ['Dark mode', 'Complete dark theme tuned for studio use at night.', 'config'],
    ['System theme sync', 'Follows the OS light/dark preference automatically.', 'config'],
    ['One-click theme toggle', 'Animated sun/moon switch in the top bar.', 'config'],
    ['Theme-aware scrollbars', 'Custom thin scrollbars styled for both themes.'],
    ['Purple selection accent', 'Branded text-selection highlight color.'],
    ['Focus ring polish', 'Consistent violet focus outlines across all controls.'],
    ['View transition animations', 'Incoming views fade and slide in smoothly.'],
    ['No-transition theme switch', 'Theme changes apply instantly without flicker.'],
  ]),

  // ---------- Command Palette ----------
  ...group('Command Palette', 'cmd', [
    ['Global command palette', 'Press ⌘K / Ctrl+K anywhere for instant actions.'],
    ['Fuzzy navigation', 'Type-to-filter across every module.'],
    ['Theme action', 'Switch light/dark from the palette.'],
    ['Re-tune action', 'Re-run hardware auto-tune on demand.'],
    ['Session summary row', 'Live asset and job counts inside the palette.'],
    ['Keyboard-first UX', 'Full arrow-key + Enter navigation.'],
    ['Top-bar entry point', 'Visible ⌘K button with shortcut hint.'],
    ['Footer shortcut hint', 'Persistent keyboard hint in the status bar.'],
  ]),

  // ---------- Asset Management ----------
  ...group('Asset Management', 'asset', [
    ['Dedicated Asset Bin view', 'Full module for browsing every artifact.'],
    ['Inline audio players', 'Play any rendered clip without leaving the bin.'],
    ['Image thumbnails', 'Instant visual preview for image assets.'],
    ['Inspect dialog', 'Rich detail view with metadata chips per asset.'],
    ['Kind filters', 'Filter audio/image/video/text/data instantly.'],
    ['Asset search', 'Name-based filtering across the bin.'],
    ['One-click downloads', 'Save any asset with its proper filename.'],
    ['Soundtrack hand-off', 'Send audio straight into the video editor timeline.'],
    ['Text reuse', 'Send extracted/OCR text back into TTS Studio.'],
    ['Memory-safe deletion', 'Blob URLs revoked on every delete.'],
    ['Clear-all with revoke', 'One click frees the whole bin safely.'],
    ['Session totals', 'Live byte and audio-duration totals.'],
    ['Persistent asset bin', 'Blobs are mirrored to on-device IndexedDB and survive reloads.'],
    ['Restore on launch', 'Saved assets rehydrate automatically when the studio opens.'],
    ['Restored badges', 'Items restored from disk are marked in the bin.'],
    ['Storage eviction cap', 'Newest 120 assets kept on disk; older ones evicted on write.'],
    ['On-device only storage', 'The IndexedDB mirror lives in this browser profile — never synced.'],
  ]),

  // ---------- Text Preparation Tools ----------
  ...group('Text Preparation Tools', 'text', [
    ['Whitespace cleaner', 'Collapse double spaces, normalize paragraph breaks.'],
    ['Markdown stripper', 'Removes #/**/`/> etc. for clean narration.'],
    ['Timestamp remover', 'Strips [00:12], 00:00:00 and SRT-style ranges.'],
    ['Sentence flow joiner', 'Merges hard-wrapped lines into flowing prose.'],
    ['One-click toolbar', 'Text tools inline above the editor.'],
    ['Waveform image export', 'Download the rendered waveform as a PNG.'],
    ['Waveform scrub-seek', 'Click or drag the rendered waveform to jump anywhere.'],
    ['Rendered transport controls', 'Play/pause with a live playhead over the waveform.'],
    ['Loop playback', 'Repeat the rendered clip continuously for review.'],
    ['Variable-speed playback', 'Audition renders at 0.5×–2× without re-rendering.'],
    ['Played-region highlight', 'Waveform brightens up to the playhead as it plays.'],
  ]),

  // ---------- Expressive Voice Markup ----------
  ...group('Expressive Voice Markup', 'markup', [
    ['Inline voice markup', 'Mini-SSML layer compiled to a synthesis plan before rendering.', 'engine'],
    ['Precision pauses', '[pause 500] / [pause 1.5s] insert exact silence; [break] for a breath.', 'engine'],
    ['Emphasis spans', '[em]…[/em] slows, brightens and lifts the wrapped words.', 'engine'],
    ['Rate spans', '[rate 1.2]…[/rate] mid-sentence speed control.', 'engine'],
    ['Pitch spans', '[pitch 0.9]…[/pitch] per-phrase pitch control.', 'engine'],
    ['Whisper spans', '[whisper]…[/whisper] quiet, breathy delivery.', 'engine'],
    ['Spelling mode', '[spell]NASA[/spell] reads letter-by-letter with gaps.', 'engine'],
    ['Composable nesting', 'Tags nest — rate/pitch/volume compose multiplicatively.', 'engine'],
    ['Markup toolbar', 'One-click tag insertion at the cursor, wrapping the selection.'],
    ['Cheat-sheet popover', 'Built-in help documenting every tag inline in the editor.'],
    ['Live markup badge', 'Active tags are listed above the editor as you type.'],
    ['AI-safe stripping', 'AI previews read the stripped text so tags are never spoken.'],
    ['Markup-aware estimation', 'Duration estimate includes pauses and styled-span slowdowns.'],
  ]),

  // ---------- Waveform Region Tools ----------
  ...group('Waveform Region Tools', 'region', [
    ['Drag region selection', 'Drag across the waveform to select any time region, DAW-style.'],
    ['Region badge readout', 'Selection start, end and duration shown live in the transport bar.'],
    ['Region-confined playback', 'Playback is bounded to the selection; the playhead wraps or stops at its edge.'],
    ['Region loop', 'Loop toggle combined with a selection loops exactly that region.'],
    ['Export selection', 'Render just the selected region to any of the 36 formats as a new asset.'],
    ['Trim to selection', 'Destructive trim: replace the working buffer with only the selected region.'],
    ['One-click clear', 'Instantly drop the selection and return to full-clip transport.'],
    ['Selection-aware canvas', 'Outside of the selection the waveform dims; amber edge handles mark the region.'],
    ['Keyboard seeking', '←/→ nudge the playhead by 2 s, Space toggles transport, ⌘⏎ renders.'],
  ]),

  // ---------- Cover Art & Packaging ----------
  ...group('Cover Art & Packaging', 'packaging', [
    ['Canvas cover studio', 'Draw a 600×900 audiobook cover locally from book metadata — no templates leave the device.'],
    ['Four cover styles', 'Aurora gradient, Minimalist, Classic frame and Bold type layouts.'],
    ['Five accent palettes', 'Violet, emerald, amber, rose and zinc color systems.'],
    ['Live preview', 'Cover repaints instantly as title, author or style changes.'],
    ['Cover PNG export', 'Save the cover to the asset bin and download it in one click.'],
    ['M4B-style packaging', 'Combined audio export plus a package manifest with embedded cover art.'],
    ['Chapter timestamps', 'Package manifest records exact start/end times of every chapter in the combined timeline.'],
    ['Package metadata', 'Title, author, narrator, genre, gap length and audio file reference embedded in the manifest.'],
    ['Silence-aware splicing', 'Chapter gap silence is accounted for in package timings.'],
  ]),

  // ---------- Keyboard Workflow ----------
  ...group('Keyboard Workflow', 'keyboard', [
    ['Shortcuts panel', 'Press ? anywhere for the grouped keyboard reference dialog.'],
    ['Alt-number navigation', 'Alt+1…9,0 jumps straight to any of the 11 workspace views.'],
    ['Goto-chord navigation', 'G then a letter (T, F, A, V, O, D, B, Q, L, S, X) navigates like a pro app.'],
    ['Command palette', '⌘K / Ctrl+K opens fuzzy navigation + actions from anywhere.'],
    ['Palette shortcuts entry', 'Keyboard shortcuts listed as a palette action for discoverability.'],
    ['Footer shortcut hints', 'Live ⌘K and ? reminders in the sticky status bar, one click to open.'],
    ['Typing-safe bindings', 'Single-key navigation never fires while you are typing in inputs.'],
  ]),

  // ---------- Chapter Editing ----------
  ...group('Chapter Editing', 'chapter-edit', [
    ['Inline chapter editor', 'Expand any chapter to edit its text without leaving the chapter list.'],
    ['Per-chapter markup', 'Voice markup works inside chapter scripts — pauses, emphasis, whispers.'],
    ['Markup badge per chapter', 'Chapters containing tags are flagged before you render.'],
    ['Per-chapter re-estimate', 'Word count and duration estimates update as you edit.'],
    ['Chapter self-containment', 'Edits survive navigation — views stay mounted in the background.'],
  ]),

  // ---------- Dialogue Studio ----------
  ...group('Dialogue Studio', 'dialogue', [
    ['Multi-speaker script renderer', 'Screenplay-style scripts (Name: line) rendered as a full-cast recording by the local engine.'],
    ['Cast voice assignment', 'Every speaker gets a built-in voice profile with individual rate and pitch sliders.'],
    ['Speaker color system', 'Chat-style bubbles with per-speaker color dots and initials across the whole script.'],
    ['Screenplay parser', 'Paste an entire script; unprefixed lines automatically continue the previous speaker.'],
    ['Append or replace import', 'Parse results can extend an existing production or start it fresh.'],
    ['Per-line preview', 'Audition any single line in its speaker voice before committing to a full render.'],
    ['Per-line mute', 'Mute takes stay visible for reference but are skipped in the render.'],
    ['Line reordering', 'Move lines up and down to retime the conversation.'],
    ['Inline line editing', 'Click any bubble to rewrite the take in place.'],
    ['Configurable inter-line pause', '0–2 s exact silence inserted between takes, on top of [pause] markup.'],
    ['Dialogue duration estimate', 'Live total runtime across speech and pauses while you write.'],
    ['Speaker rename on the fly', 'Click a speaker name to rename it everywhere it appears.'],
    ['Script JSON export/import', 'Round-trip an entire production (cast + lines + timing) as a local file.'],
    ['Sample production', 'A two-actor sci-fi scene loads with one click for instant demos.'],
    ['Full-cast render pipeline', 'One background job renders every take sequentially and stitches the final file.'],
    ['Lexicon-aware dialogue', 'The shared pronunciation dictionary applies to dialogue lines too.'],
  ]),

  // ---------- Pronunciation Lexicon ----------
  ...group('Pronunciation Lexicon', 'lexicon', [
    ['Global pronunciation dictionary', 'Word→saying rules applied before synthesis in TTS Studio and Dialogue Studio.'],
    ['Word-boundary matching', 'Replacements respect word edges — “SQL” never fires inside “sequel”.'],
    ['Longest-match priority', '“PostgreSQL” wins over shorter overlapping rules deterministically.'],
    ['Case-style preservation', 'KUBERNETES stays uppercase, Kubernetes stays capitalized.'],
    ['Preset dictionaries', 'Four curated packs: Tech terms, AI & models, Fantasy names, Everyday fixes.'],
    ['Substitution preview badge', 'Live banner shows exactly which words the lexicon will replace before you render.'],
    ['Rule enable/disable', 'Toggle any rule without deleting it.'],
    ['Text import', 'Paste find=>replace lines (CSV/TSV also accepted, # comments ignored).'],
    ['File import', 'Load .txt/.csv/.tsv/.json lexicon files with duplicate detection.'],
    ['Text export', 'Download the full lexicon in the portable find=>replace format.'],
    ['Cross-module sharing', 'Rules persist in localStorage and apply across modules automatically.'],
    ['Render log reporting', 'The render job logs every substitution it made for auditability.'],
  ]),

  // ---------- Waveform Zoom & Ruler ----------
  ...group('Waveform Zoom & Ruler', 'wave-zoom', [
    ['40× waveform zoom', 'Pixel-level zoom across the render for precise editing.'],
    ['Time ruler', 'Nice-interval tick marks and labels under the waveform at every zoom level.'],
    ['Scrollable timeline', 'The zoomed waveform scrolls horizontally inside its own viewport.'],
    ['Playhead auto-follow', 'During playback the view glides to keep the playhead visible — never fighting your scroll.'],
    ['Center playhead command', 'One click recenters the viewport on the playhead.'],
    ['Zoom-fit reset', 'Fit button restores the whole-file view instantly.'],
    ['High-res zoom cache', 'Per-column min/max cache at up to 16k columns keeps zoom repaints cheap for hour-long files.'],
    ['Region tools at any zoom', 'Drag-select, export-selection and trim keep working at 40×.'],
  ]),

  // ---------- Audiobook Draft Autosave ----------
  ...group('Audiobook Draft Autosave', 'draft', [
    ['IndexedDB draft persistence', 'Manuscript, chapters, metadata, rules and cover choices save automatically on-device.'],
    ['Debounced autosave', 'Changes settle for ~1 s before a write — no disk churn while typing.'],
    ['Reload-proof projects', 'An accidental refresh restores the full book with a friendly toast.'],
    ['Draft-saved indicator', 'A timestamped badge in Book metadata shows the last autosave.'],
    ['Discard draft control', 'Clear the on-device draft without touching the open work.'],
    ['Buffer-aware restore', 'Restored chapters return as drafts ready to re-render — audio never pretends to persist.'],
  ]),

  // ---------- Chapter Reordering ----------
  ...group('Chapter Reordering', 'reorder', [
    ['Drag-and-drop chapters', 'Grab any chapter card and drop it where it belongs.'],
    ['Drop-target highlight', 'The card under the cursor lifts with a ring while dragging.'],
    ['Keyboard reordering', 'Up/down buttons mirror drag-and-drop for accessibility.'],
    ['Order-aware exports', 'Manifests, combined exports and packages all follow the new order.'],
    ['Status accent bars', 'Chapter cards carry a left color bar: draft, queued, rendered, error.'],
  ]),

  // ---------- Listen & Sleep Timer ----------
  ...group('Listen & Sleep Timer', 'listen', [
    ['Audiobook listen mode', 'Headphone button plays any rendered chapter in place.'],
    ['Sleep timer', '5–60 minute timers fade the last 10 seconds and pause playback gently.'],
    ['End-of-chapter fade', 'Timer mode that only fades the chapter ending — perfect for one-more-chapter nights.'],
    ['Live countdown chip', 'The remaining sleep time ticks down in the listen bar.'],
    ['Bookmark resume', 'Listen positions save per book and offer “resume at 3:24” chips.'],
    ['Auto-bookmarking', 'Position snapshots every 3 s while listening, plus on pause and stop.'],
    ['Bookmark clear on finish', 'Finishing a chapter clears its bookmark automatically.'],
    ['Listen progress bar', 'Live progress with current/total time in the listen bar.'],
  ]),

  // ---------- Chapter Thumbnails ----------
  ...group('Chapter Thumbnails', 'thumbs', [
    ['Per-chapter cover art', 'Every chapter renders a miniature cover with its number and title.'],
    ['Accent-following thumbs', 'Thumbnails repaint when you change the cover studio palette.'],
    ['Cached rendering', 'Thumbnails redraw only when titles or accents change, never during job updates.'],
  ]),

  // ---------- EQ & Dynamics (Enhancer) ----------
  ...group('EQ & Dynamics', 'eq', [
    ['3-band parametric EQ', 'Real biquad filters (low shelf 180 Hz, peaking 1.2 kHz, high shelf 3.8 kHz) rendered offline — sample-accurate.', 'engine'],
    ['Voice EQ presets', 'Seven characters: Natural, Podcast, Broadcast, Warm analog, Bright & airy, Telephone, Megaphone.'],
    ['Live EQ curve preview', 'Boost/cut bars show the exact dB per band for the active preset.'],
    ['Dynamics compressor', 'Soft-knee 3.5:1 compressor at −24 dB with +2 dB makeup — evens quiet syllables.', 'engine'],
    ['Render-time processing', 'EQ and compression are baked into exports and logged in the job history.'],
    ['Enhancer status badge', 'The render panel shows exactly which processing is armed before you render.'],
    ['Enhancer settings in vault', 'EQ preset and compressor state are saved with TTS projects in the local vault.'],
  ]),

  // ---------- Dialogue Draft Autosave ----------
  ...group('Dialogue Draft Autosave', 'dialogue-draft', [
    ['IndexedDB draft autosave', 'Title, script, cast voices and pacing persist debounced (1.2 s) as you work.'],
    ['Restore on open', 'A reloaded page brings back the whole production with a confirmation toast.'],
    ['Draft-saved badge', 'Live timestamp chip confirms on-device persistence at a glance.'],
    ['Discard draft', 'One-click removal of the stored draft while keeping the current session script.'],
    ['Cast settings persisted', 'Per-speaker voice profile, rate and pitch are all part of the saved draft.'],
  ]),

  // ---------- Lexicon Audition ----------
  ...group('Lexicon Audition', 'lex-audition', [
    ['Per-rule audition', 'Hover any pronunciation rule and press the speaker button to hear its replacement.'],
    ['Current-voice auditioning', 'Rule previews use the active built-in voice profile for context-accurate checks.'],
    ['Playback takeover safety', 'Auditioning stops any other preview first so sounds never overlap.'],
    ['Failure surfaced', 'Audition errors appear as toasts instead of failing silently.'],
  ]),

  // ---------- Batch Conversion ----------
  ...group('Batch Conversion', 'batch', [
    ['Convert all files', 'One button queues every parsed, speakable file for conversion in order.'],
    ['Live batch counter', 'The action shows exactly how many files are eligible right now.'],
    ['Order-aware batch', 'Files convert FIFO; the queue view reflects the exact processing order.'],
    ['Batch summary toast', 'A confirmation lists the first queued files (and the remainder count).'],
  ]),

  // ---------- Subtitle Export ----------
  ...group('Subtitle Export', 'srt', [
    ['Timed OCR cues', 'Video OCR records when each line appears and disappears on screen.', 'engine'],
    ['SRT subtitle builder', 'Cues are serialized to standard .srt with timestamp formatting.', 'engine'],
    ['Minimum cue duration', 'Every subtitle lives at least 1.2 s so fast cuts stay readable.'],
    ['Export .srt file', 'Download subtitles named after the source video, ready for any player/editor.'],
    ['Copy SRT to clipboard', 'Clipboard variant for pasting straight into another tool.'],
    ['Cue count reporting', 'Job rows and result panels show how many timed cues were recognized.'],
  ]),

  // ---------- Queue Prioritization ----------
  ...group('Queue Prioritization', 'queue-prio', [
    ['Run-next boost', 'Promote any queued job to jump ahead of the entire normal queue.'],
    ['Priority scheduling', 'Boosted jobs always start before non-boosted ones (oldest boost first).', 'engine'],
    ['True FIFO ordering', 'Queued jobs run strictly in the order they were submitted — no more last-in-first-out.'],
    ['Up-next indicator', 'The row that will run next is labeled live as the queue drains.'],
    ['Priority accent styling', 'Boosted jobs glow amber with a dedicated accent bar and badge.'],
    ['Reversible boost', 'Click the boost control again to return a job to normal order.'],
  ]),

  // ---------- Video Subtitle Track ----------
  ...group('Video Subtitle Track', 'vtt', [
    ['Burned-in subtitles', 'Active cues render onto every preview frame and are baked into exported video.', 'engine'],
    ['SRT & WebVTT import', 'Tolerant parser handles SRT and VTT, CRLF, missing separators, tags and entities.', 'engine'],
    ['Paste subtitles', 'Drop subtitle text straight into a textarea and parse — no file needed.'],
    ['OCR → subtitle handoff', 'One click sends timed OCR cues from the lab into the editor as a subtitle track.'],
    ['Add cue at playhead', 'Creates a 3-second cue starting exactly where the preview is parked.'],
    ['Inline cue editor', 'Click any cue text to rewrite it in place; blur or Enter commits.'],
    ['Subtitle style studio', 'Font size, color, screen position, pill background and text outline — all live.'],
    ['Two-line auto-wrap', 'Long captions wrap to two centered lines with ellipsis clipping.', 'engine'],
    ['Cue extent strip', 'A violet track under the timeline shows exactly where every cue lives.'],
    ['Subtitle-aware export', 'Export jobs report burned-in cue counts in their logs.'],
  ]),

  // ---------- Volume Envelope ----------
  ...group('Volume Envelope', 'envelope', [
    ['Brush envelope editing', 'Draw volume automation directly on the rendered waveform like a DAW.', 'engine'],
    ['Piecewise-linear gain', 'Sample-accurate segment walk applies the exact drawn curve, clamped to [-1, 1].', 'engine'],
    ['Click to add / move', 'Pointer down near a point drags it; on empty space it creates one.'],
    ['Right-click delete', 'Context menu removes the nearest point within a 10 px radius.'],
    ['Unity guide line', 'A dashed emerald line marks gain 1.0 so boosts and cuts stay honest.'],
    ['Implicit unity tails', 'Gain returns to unity before the first and after the last point — previewed live.'],
    ['Collision absorption', 'Points closer than 10 ms merge automatically to keep curves clean.'],
    ['Apply via job queue', 'Envelope rendering runs as a cancellable background job for hour-long buffers.'],
  ]),

  // ---------- Compressed Export Formats ----------
  ...group('Compressed Export Formats', 'compressed', [
    ['WebM Opus export', 'Native Opus encoding at 128 kbps for web-ready voice files.', 'engine'],
    ['MP4 AAC export', 'AAC-LC in an MP4/M4A container where the browser provides it.', 'engine'],
    ['Ogg Opus export', 'Ogg-container Opus for players that prefer it.', 'engine'],
    ['Real-time encoding', 'Compressed renders record through MediaRecorder with live progress.', 'engine'],
    ['Graceful fallback', 'Unsupported codecs fail with an actionable pick-a-WAV message.'],
    ['39 export formats', 'The format registry now spans lossless PCM, companded and compressed families.'],
  ]),

  // ---------- Speaker Groups ----------
  ...group('Speaker Groups', 'speaker-groups', [
    ['Narrator vs actors', 'Cast members are tagged narrator or actor with a one-tap selector.'],
    ['Narrator bubble styling', 'Narration renders italic with a dashed edge, book icon and zinc badge.'],
    ['Name auto-detection', 'Speakers called "narrator" are grouped automatically on paste and rename.'],
    ['Group-aware drafts', 'Speaker groups round-trip through IndexedDB autosave and JSON scripts.'],
    ['Cast summary logging', 'Render jobs log the mix, e.g. "3 speakers (1 narrator, 2 actors)".'],
    ['Legend row', 'A dashed/solid chip legend explains the bubble language at a glance.'],
  ]),

  // ---------- Chapter Markers ----------
  ...group('Chapter Markers', 'chapters', [
    ['WAV cue chunk embedding', 'Chapter positions are written into standard RIFF cue chunks of packaged audio.', 'engine'],
    ['Labelled text metadata', 'Each cue carries a labl entry — "Chapter N: title" — readable by pro tools.', 'engine'],
    ['YouTube chapter lists', 'One click copies a 0:00-styled chapter list for show notes and descriptions.'],
    ['Combined timeline offsets', 'Markers use gap-aware combined timing so they match the packaged file exactly.', 'engine'],
    ['Manifest redundancy', 'Non-WAV packages keep full chapter timing in the JSON manifest.'],
    ['ffprobe-verified output', 'Patched files decode with real chapters in independent tooling.', 'engine'],
  ]),

  // ---------- Transcription Studio (v1.7) ----------
  ...group('Transcription Studio', 'transcribe', [
    ['Live mic transcription', 'Browser speech recognition turns your microphone into timestamped text — nothing is uploaded by this app.'],
    ['Interim ghost preview', 'In-flight recognition words stream in as a dashed live line before they commit.'],
    ['13 recognition locales', 'Language selector covering English, Spanish, French, German, Italian, Portuguese, Hindi, Arabic, Chinese, Japanese, Korean and Russian.'],
    ['Manual stamping mode', 'No speech recognition? Type notes and stamp them at the playhead — works everywhere.'],
    ['Live level meter', '40-bar emerald input history driven by an AnalyserNode at 60 fps.'],
    ['Segment confidence dots', 'Per-segment confidence colouring with a neutral state for engines that omit it.'],
    ['Playback ghost highlight', 'The currently-spoken segment lights up and auto-scrolls during playback.'],
    ['SRT / VTT / TXT export', 'SubRip, WebVTT and plain-text (optionally timecode-prefixed) transcript downloads.'],
    ['Large-transcript queue path', 'Exports over 200 segments run as yield-aware queue jobs that never freeze the UI.'],
    ['Transcript → TTS round-trip', 'One click hands the finished transcript to TTS Studio for re-synthesis.'],
    ['Transcript draft persistence', 'Segments and language autosave to IndexedDB and restore with a toast after reload.'],
    ['Recording → Asset Bin', 'The captured take is saved as a reusable audio asset with duration metadata.'],
  ]),

  // ---------- Subtitle Round-Trip Export (v1.7) ----------
  ...group('Subtitle Round-Trip', 'srt-export', [
    ['SRT cue export', 'Download the subtitle track as a standard .srt file with comma-millisecond timecodes.', 'engine'],
    ['WebVTT cue export', 'Download the same track as .vtt with dot-millisecond timecodes and WEBVTT header.', 'engine'],
    ['Copy cues to clipboard', 'Clipboard-friendly SRT text for pasting into other editors.'],
    ['Per-cue nudge buttons', 'Shift any cue ±0.1 s or ±0.5 s with clamping and live lane updates.'],
    ['Shift-all timing tool', 'Offset the whole cue list at once by any seconds value, negative included.'],
  ]),

  // ---------- Music Bed & Ducking (v1.7) ----------
  ...group('Music Bed & Ducking', 'music-bed', [
    ['Music bed layer', 'Attach any Asset Bin audio as a loopable second layer under the narration soundtrack.'],
    ['Sidechain duck envelope', 'RMS-driven bed gain automatically dips while the narrator speaks.', 'engine'],
    ['Attack & release shaping', 'Duck-in speed (5–200 ms) and recovery (50–2000 ms) modelled as one-pole filters.', 'engine'],
    ['Duck depth control', '0–100% dip amount with a 20 ms analysis window and adaptive threshold.', 'engine'],
    ['Sample-accurate mixdown', 'Deterministic manual mixing loop with linear resampling and wrap-around looping.', 'engine'],
    ['Duck preview canvas', 'Emerald bed-gain curve drawn over the narration RMS blocks, debounced and cheap.'],
    ['10-second preview mix', 'Hear the ducked mix instantly via a short background job before exporting.'],
    ['Baked-in exports', 'Video exports automatically carry the ducked bed mix — no extra step.'],
  ]),

  // ---------- Encoder Capability Badges (v1.7) ----------
  ...group('Encoder Capability Badges', 'codec-badges', [
    ['Live codec probing', 'MediaRecorder.isTypeSupported is probed once per session for every compressed format.', 'engine'],
    ['Availability dots', 'Emerald (native), violet (hardware recorder) and blank (unsupported) markers in every format row.'],
    ['Device format summary', '"N of 39 formats available on this device" with a legend tooltip in both studios.'],
    ['Unsupported-format guard', 'Amber alert explains exactly what happens if the picked codec is missing, with a WAV/Ogg suggestion.'],
  ]),

  // ---------- Onboarding & Insights (v1.7) ----------
  ...group('Onboarding & Insights', 'onboard', [
    ['Guided first-run tour', 'Six-step introduction covering privacy, studios and navigation — shown once per browser.'],
    ['Replayable tour', 'Reopen the tour any time from the Dashboard.'],
    ['Recent activity feed', 'The Dashboard lists the last five jobs with live status icons and wall-clock durations.'],
    ['Rotating studio tips', 'Ten concrete power-user tips cycle every eight seconds with instant swap under reduced motion.'],
    ['Reduced-motion aware', 'Tour and tip animations honour both the OS setting and the in-app motion switch.'],
    ['Keyboard-first onboarding', 'The tour teaches ⌘K, G-then-key jumps and the ? shortcuts panel.'],
  ]),

  // ---------- Video Project Manager (v1.8) ----------
  ...group('Video Project Manager', 'vproj', [
    ['Named project library', 'Save unlimited named video projects to IndexedDB with clips, subtitles and music bed settings.'],
    ['Autosaved current project', 'The editor autosaves your working project every 1.5 s and restores it after a reload.'],
    ['One-time legacy migration', 'Old localStorage projects migrate to IndexedDB automatically, then the legacy key is removed.', 'engine'],
    ['Load / rename / duplicate', 'Full project lifecycle without leaving the editor.'],
    ['JSON export & import', 'Download any project as .auravoice-video.json and re-import it with tolerant validation.'],
    ['Conflict-safe ids', 'Projects colliding with the internal autosave key get fresh ids on save, load or import.', 'engine'],
    ['Loaded-project badge', 'The list marks which project is currently open and shows clips · duration · cues metadata.'],
    ['Destructive-action guards', 'Deletes confirm through an alert dialog; loads autosave first so nothing is lost.'],
  ]),

  // ---------- Speaker Subtitles (v1.8) ----------
  ...group('Speaker Subtitles', 'spk-sub', [
    ['Per-line dialogue timings', 'The dialogue render loop records exact start/end times for every line.', 'engine'],
    ['Send to Video Editor', 'One click hands speaker-tagged cues to the video timeline via the cross-module channel.'],
    ['Speaker-tagged cues', 'Each cue carries its speaker name through import, edit, export and persistence.'],
    ['Burned-in speaker prefixes', 'Exports render "Name: text" with a per-speaker colour hashed from the name.', 'engine'],
    ['Speaker chip palette', 'Eight theme-safe hues (emerald, violet, amber, rose, teal, orange, lime, fuchsia) stay readable in both themes.'],
    ['Dialogue SRT export', 'Download the take as .srt with an optional "Include speaker names" prefix.'],
    ['Freshness guard', 'Editing the script invalidates stale timings so handoffs always match the last render.', 'engine'],
  ]),

  // ---------- Custom Voice Profiles (v1.8) ----------
  ...group('Custom Voice Profiles', 'custom-voice', [
    ['Voice designer', 'Create voices from name, gender, base pitch, timbre, breath, language and description.'],
    ['Live auditioning', 'Hear unsaved slider values instantly before committing a voice.'],
    ['Persisted voices', 'Custom profiles ride the app store and survive reloads.'],
    ['Engine registry', 'Synthesis resolves custom profiles first, then builtins — transparently everywhere.', 'engine'],
    ['TTS picker badge', 'Custom voices show a violet "custom" mini-badge in the profile combobox.'],
    ['Edit / duplicate / delete', 'Full profile management with confirmation guards.'],
    ['Graceful fallback', 'Deleting a voice in use falls back to the builtin default without errors.', 'engine'],
  ]),

  // ---------- Queue Intelligence (v1.8) ----------
  ...group('Queue Intelligence', 'queue-iq', [
    ['Realtime-phase detection', 'Compressed exports that record via MediaRecorder are detected from live progress messages.', 'engine'],
    ['REALTIME chip', 'Running realtime jobs show a pulsing violet badge explaining the time cost.'],
    ['Wall-clock history', 'Completed rows show true durations alongside relative times.'],
    ['Slash filter', 'Press / to filter both panels by label or type; Escape clears.'],
  ]),

  // ---------- Asset Bin Power Tools (v1.8) ----------
  ...group('Asset Bin Power Tools', 'asset-tools', [
    ['Sort controls', 'Newest, oldest, name, size or duration ordering across the whole bin.'],
    ['Text asset preview', 'Read any text asset in a scrollable dialog with word and character counts.'],
    ['Preview copy & handoff', 'Copy text or send it straight to TTS Studio from the preview.'],
    ['Batch selection mode', 'Select many assets and delete them in one confirmed action.'],
    ['Waveform thumbnails', 'Audio cards with live buffers draw a static min/max waveform at mount.', 'engine'],
  ]),

  // ---------- Transcript Speaker Tagging (v1.9) ----------
  ...group('Transcript Speaker Tagging', 'tspk', [
    ['Per-segment speakers', 'Tag any transcript segment with a speaker name for downstream subtitles.'],
    ['Shared color identity', 'A speaker keeps the same color chip in Transcribe and Video — one deterministic hash.', 'engine'],
    ['Assign remaining to…', 'Bulk-tag every unassigned segment with one name in a single click.'],
    ['Speaker filter chips', 'View-only per-speaker filtering with counts, keeping exports complete.'],
    ['Speaker-prefixed SRT/VTT', 'Downloads fold "Name: " into cues with an include-speakers switch.'],
    ['Speaker-aware drafts', 'Tags autosave to IndexedDB and restore across reloads.'],
    ['Speakers badge', 'The header counts distinct speakers at a glance.'],
  ]),

  // ---------- Transcript Handoffs (v1.9) ----------
  ...group('Transcript Handoffs', 'handoff', [
    ['Transcript → Video cues', 'One click sends timed, speaker-tagged cues to the Video Editor subtitle track.'],
    ['Transcript → Audiobook chapters', 'Chapters are auto-split from the transcript and pushed to Audiobook Studio.'],
    ['Gap-based splitting', 'Silence gaps ≥ a chosen threshold (default 1.5 s) become chapter boundaries.'],
    ['Live split preview', 'The send dialog shows the resulting chapter count before anything is committed.'],
  ]),

  // ---------- Project Undo/Redo (v1.9) ----------
  ...group('Project Undo/Redo', 'undo', [
    ['Full-project history', 'Every clip, cue, style and music-bed edit is undoable via 50-snapshot stack.', 'engine'],
    ['Slider coalescing', 'Rapid same-field changes merge into one step so history stays meaningful.', 'engine'],
    ['Keyboard undo/redo', '⌘Z / ⇧⌘Z (and Ctrl+Y) while the Video Editor is in view — typing is never intercepted.'],
    ['Step indicator', 'A quiet "3/12" counter shows exactly where you are in the history.'],
    ['Loads reset history', 'Opening or importing a project starts a fresh timeline — no cross-project undo.'],
  ]),

  // ---------- Unified Voice Pickers (v1.9) ----------
  ...group('Unified Voice Pickers', 'picker-voices', [
    ['Custom voices everywhere', 'Dialogue cast and Audiobook narration pickers now list user-created voices.'],
    ['Custom badge in rows', 'Violet mini-badges mark custom voices in every picker.'],
    ['Missing-voice tolerance', 'Deleted voices show an amber hint without breaking stored selections.', 'engine'],
  ]),

  // ---------- Transcript Chapters Import (v1.9) ----------
  ...group('Transcript Chapters Import', 'chapter-import', [
    ['Channel consumption', 'Audiobook Studio ingests pushed transcript chapters once, validated and capped.', 'engine'],
    ['Paste chapters parser', '"Title | text" rows or "## Title" headings become chapters from any text.', 'engine'],
    ['Draft-safe ordering', 'Imports append in transcript order and ride the existing autosave.'],
    ['Shared chapter factory', 'Imports and detection use one creation path — no duplicate logic.', 'engine'],
  ]),

  // ---------- Batch Export (v1.9) ----------
  ...group('Batch Export', 'batch-export', [
    ['Render once, encode many', 'One synthesis fans out into up to six formats in a single queue job.'],
    ['Format checkboxes', 'Picker with availability dots — unsupported codecs visible but disabled.'],
    ['Per-format size estimates', 'PCM math is exact; compressed uses nominal bitrates, shown per row and in total.', 'engine'],
    ['Resumable cancellation', 'Cancelling mid-batch keeps every completed file.'],
    ['Sequential yield-aware job', 'Progress, pause and cancel work across the whole batch without freezing the UI.', 'engine'],
    ['Picker size hint', 'The selected format shows its estimated footprint right in the summary line.'],
  ]),

  // ---------- Queue Reordering (v2.0) ----------
  ...group('Queue Reordering', 'queue-dnd', [
    ['Drag to reorder', 'Grab any queued job and drop it above or below another — running rows never move.', 'engine'],
    ['Insertion indicator', 'An emerald line pins to the hovered edge so the drop position is never a guess.'],
    ['Keyboard reordering', 'Focus a queued row and press Alt+↑/↓ to swap it with the neighboring job.'],
    ['"next" badge', 'The job the pump will actually run next is always labeled — reorder and watch it move.', 'engine'],
    ['Rocket run-next', 'One click boosts a job past the whole queue, badge and all.'],
    ['Reorder-aware pump', 'Execution follows the visible order exactly — what you see is what runs.', 'engine'],
  ]),

  // ---------- Activity Analytics (v2.0) ----------
  ...group('Activity Analytics', 'activity-chart', [
    ['Persisted activity log', 'Job, asset and export events are stored locally (newest 500) and survive reloads.', 'engine'],
    ['Weekly bar chart', 'A per-day column chart of everything this device processed, right on the dashboard.'],
    ['7/14-day range toggle', 'Flip between week and fortnight views; the axis rescales automatically.'],
    ['Outcome colouring', 'Emerald for successes, rose for failures, amber for cancellations — stacked per day.', 'engine'],
    ['Screen-reader summary', 'The chart exposes its range and event count through an accessible label.'],
  ]),

  // ---------- Speaker Suggestions (v2.0) ----------
  ...group('Speaker Suggestions', 'diarize', [
    ['Pause-based splitting', 'Silences beyond a threshold suggest a speaker change between segments.', 'engine'],
    ['Duration clustering', 'Similar clip lengths inherit an existing speaker — k-means on log duration.', 'engine'],
    ['Review-then-apply', 'Nothing changes until you approve: suggestions render as ghost chips first.'],
    ['Confidence tiers', 'Each suggestion carries a percentage; high-confidence ones are colour-coded.'],
    ['Per-row accept/reject', 'Check or skip individual suggestions before committing the batch.'],
    ['Bulk smart apply', "Apply everything, or only the suggestions the engine is sure about — manual tags are never overwritten.", 'engine'],
  ]),

  // ---------- Duck Automation Points (v2.0) ----------
  ...group('Duck Automation Points', 'duck-points', [
    ['Click-to-add points', 'Click the duck preview to place an automation point at that time and depth.'],
    ['Drag & double-click', 'Drag points to retime them, double-click (or Delete) to remove.'],
    ['Keyboard nudging', 'Arrows move the selected point; Shift fine-steps to 10 ms / 0.05 depth.'],
    ['Interpolated envelope', 'Points interpolate linearly and clamp at both ends, replacing the flat duck amount.', 'engine'],
    ['Preview equals export', 'The canvas renders the same point-driven envelope the export bakes.', 'engine'],
    ['Undo-integrated', 'Every point operation is a tagged history step — ⌘Z rewinds them individually.'],
    ['Override hinting', 'Manual points visibly supersede the duck slider until cleared.'],
  ]),

  // ---------- Chapter Power Tools (v2.0) ----------
  ...group('Chapter Power Tools', 'chapter-tools', [
    ['Drag-reorder chapters', 'Reorder the reading list by hand with a live insertion line; Alt+↑/↓ works too.'],
    ['Merge with next', 'Fold a chapter into the following one — text joins, formatting resets to draft.', 'engine'],
    ['Merge selected', 'Multi-select chapters and collapse them into one, in list order.'],
    ['Three-way split', 'Split at blank lines, every N sentences, or a --- marker with a live part preview.', 'engine'],
    ['Duplicate chapter', 'Clone any chapter (fresh id, "(copy)" title) right below the original.'],
    ['Word-count chip', 'The chapters header always shows the running chapter and word totals.'],
    ['Live region announcements', 'Reorders, merges and splits are announced politely to screen readers.'],
  ]),

  // ---------- AutoBook Pipeline (v2.1) ----------
  ...group('AutoBook Pipeline', 'autobook', [
    ['One-click book ingestion', 'Drop txt, md, epub, pdf, docx, rtf, html, subtitles — 900+ formats via File-Studio handlers, scans flagged for OCR.'],
    ['Five-stage pipeline strip', 'Ingest → Understand → Cast → Script → Produce, each stage visible, announced and job-tracked.'],
    ['Genre auto-detection', 'Fiction vs non-fiction from dialogue density, speech verbs, scholarly apparatus and more — with a confidence score.'],
    ['Dialogue attribution engine', 'Tag verbs, pronoun resolution, vocatives, action beats and alternation decide WHO speaks every quoted line.'],
    ['Character voice casting', 'Names, honorifics, kinship words and pronouns infer age & gender; each character gets a fitting voice automatically.'],
    ['Skip-list intelligence', 'Page numbers, running heads, TOC, copyright pages, front matter, index, references and footnotes are detected and never read aloud.'],
    ['Chapter detection', 'Chapter/Part/Prologue headings become silent markers that shape pacing, chapter gaps and backdrops.'],
    ['Explainable evidence', 'Every casting and genre decision carries human-readable evidence — no black box.'],
    ['Editable script', 'Rewrite or un-skip any line before rendering; the render follows the reviewed script exactly.'],
    ['Audiobook producer', 'One job synthesizes the full cast recording with chapter-aware pauses and encodes to any of 36 formats.'],
    ['Videobook producer', 'Chapter backdrops plus the book text burned in, word-synced — no timestamps or speaker labels, ever.'],
    ['Videobook backdrops', 'Aurora, Parchment and Ink themes at 720p/1080p with Ken Burns motion and 60 s preview scope for real-time capture.'],
    ['Studio handoffs', 'Chapters → Audiobook Studio, script → Dialogue Studio clipboard, timeline → Video Editor, SRT + TXT downloads.'],
    ['Deterministic intelligence', 'Same book, same script — the NLP core is pure TypeScript with zero network, zero model downloads.', 'engine'],
  ]),

  // ---------- Fiction Intelligence (v2.1) ----------
  ...group('Fiction Intelligence', 'fiction-iq', [
    ['Dialogue density signal', 'Quoted spans per 1k words — the strongest single fiction marker, weighted and reported.', 'engine'],
    ['Speech-verb census', 'said/asked/whispered patterns feed both the genre verdict and line attribution.', 'engine'],
    ['Scholarly apparatus detector', 'Citations, figures, ISBNs, URLs and textbook furniture push toward non-fiction.', 'engine'],
    ['Two-pass pronoun resolution', 'A first pass discovers the speaking roster; a second resolves “she said” from full-text genders.', 'engine'],
    ['Mention-window demographics', 'Gender and age cues are read only within ±60 characters of each name mention — other characters’ cues cannot leak.', 'engine'],
    ['Possessive-relative guard', '“Her father’s logbook” describes someone else’s family and is skipped by inference.', 'engine'],
    ['Action-beat attribution', '“The boy hesitated…” — role nouns like the/boy map the next quote to the matching cast member.', 'engine'],
    ['Conversation alternation', 'Unattributed exchanges alternate between the two most recent speakers; unknown quotes fall to the Narrator.'],
    ['Emotion direction', 'whispered → whisper markup, shouted → emphasis — the director’s hints ride the voice markup engine.', 'engine'],
    ['300-name gender database', 'Compact international given-name tables with unisex fallback, kept fully offline.', 'engine'],
  ]),

  // ---------- Videobook Captions (v2.1) ----------
  ...group('Videobook Captions', 'videobook-captions', [
    ['Word-synced text track', 'Per-line render timings become exact caption cues — the words appear as they are spoken.', 'engine'],
    ['Artifact-free captions', 'showSpeaker forced off and speaker-less cues: nothing but the book text reaches the frame.'],
    ['Clean caption styling', 'Outline mode on dark backdrops, pill mode on Parchment — legible without clutter.'],
    ['Chapter gradient backdrops', 'One clip per chapter span with fade transitions and slow zoom — sized from real render timings.'],
    ['Real-time scope control', 'Full-length or 60-second preview exports with honest duration expectations.'],
    ['Editor round-trip', 'The generated project lands in Video Editor with timeline, subtitles and soundtrack intact for fine-tuning.'],
  ]),

  // ---------- AI Assistance ----------
  ...group('AI Assistance', 'ai', [
    ['Local AI model runtime', 'One shared in-browser model (SmolLM2, WebGPU/WASM) powers every AI feature; remote loading is disabled.', 'engine'],
    ['AI OCR post-correction', 'Fixes template-OCR substitution errors, restores punctuation and strips page furniture and scan noise.'],
    ['AI transcript cleanup', 'Punctuates, paragraphs and de-noises raw speech-to-text output before anything else touches it.'],
    ['AI transcript chaptering', 'Splits transcripts into titled, topic-boundary chapters with zero dropped content.'],
    ['AI speech direction', 'Normalizes numbers, symbols and abbreviations into a speakable director\'s script for TTS.'],
    ['AI document intelligence', 'Title guess, summary, key points and keywords for any ingested document.'],
    ['AI asset auto-tagging', 'Tags, describes and re-classifies assets in the bin automatically.'],
    ['AI video storyboard', 'Turns a brief into a clip plan with durations, transitions, Ken Burns moves, filters and captions.'],
    ['AI caption writer', 'Writes verbatim, evenly-timed subtitle captions from any narration script.'],
    ['AI dialogue direction', 'Scores every dialogue line with a delivery emotion using subtext and context.'],
    ['AI voice design', 'Derives formant-synthesizer parameters (pitch, timbre, breath) from a prose description.'],
    ['Deep AutoBook direction', 'Multi-pass AI: genre, cast, dialogue adjudication, chapter titles, narration tone, pacing and pronunciation.'],
    ['Complex dialogue resolution', 'Handles thoughts, mutterings, interruptions and nested quotes with correct speaker attribution.'],
    ['Character relationship mapping', 'AI infers character relationships, personalities and physical descriptions from text.'],
    ['Per-domain AI toggles', 'Every module\'s AI use can be switched off individually in Settings.', 'config'],
    ['AI depth control', 'Light / Standard / Deep passes scale how heavily the model is used.', 'config'],
    ['Deterministic AI fallback', 'When the model is missing, every feature degrades to its original rule-based engine.', 'engine'],
    ['ZIP audiobook export', 'Packages script, subtitles, metadata, audio and video into a single downloadable ZIP.', 'active'],
  ]),
];

export const FEATURE_CATEGORIES: { id: string; label: string; count: number }[] = (() => {
  const map = new Map<string, number>();
  for (const f of FEATURES) map.set(f.category, (map.get(f.category) ?? 0) + 1);
  return Array.from(map.entries()).map(([id, count]) => ({ id, label: id, count }));
})();

export function searchFeatures(query: string, category: string | 'all'): FeatureEntry[] {
  const q = query.trim().toLowerCase();
  return FEATURES.filter((f) => {
    if (category !== 'all' && f.category !== category) return false;
    if (!q) return true;
    return (
      f.name.toLowerCase().includes(q) ||
      f.description.toLowerCase().includes(q) ||
      f.keywords?.some((k) => k.includes(q))
    );
  });
}
