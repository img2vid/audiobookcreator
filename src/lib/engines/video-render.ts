// ============================================================
// Openmukti Audiobook Creator — video timeline renderer & exporter
// Canvas-based frame renderer + MediaRecorder export (WebM/MP4).
// ============================================================
import type { AssetItem, MusicBedSettings, SubtitleCue, VideoClip, VideoProject, VideoExportOptions } from '@/lib/types';
import { computeDuckEnvelope, makeSilenceBuffer, mixMusicBed } from '@/lib/engines/dsp';
import { yieldToUI } from '@/lib/utils/async';

export function createDefaultProject(): VideoProject {
  return {
    id: 'vp-default',
    name: 'Untitled Video',
    width: 1280,
    height: 720,
    fps: 30,
    clips: [],
  };
}

// ---------- subtitle parsing (SRT + WebVTT) ----------

/** Parse `HH:MM:SS,mmm` / `HH:MM:SS.mmm` / `MM:SS.mmm` into seconds. Returns null when invalid. */
function parseTimestamp(raw: string): number | null {
  const m = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(raw.trim());
  if (!m) return null;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  const min = parseInt(m[2], 10);
  const sec = parseInt(m[3], 10);
  const ms = m[4] ? parseInt(m[4].padEnd(3, '0'), 10) : 0;
  return h * 3600 + min * 60 + sec + ms / 1000;
}

/** Match a cue timing line: `start --> end` (plus optional VTT settings after the end). */
function parseTimingLine(line: string): [number, number] | null {
  const arrow = line.indexOf('-->');
  if (arrow === -1) return null;
  const start = parseTimestamp(line.slice(0, arrow));
  // end timestamp = first whitespace-delimited token after the arrow (drops VTT cue settings)
  const end = parseTimestamp(line.slice(arrow + 3).trim().split(/\s+/)[0] ?? '');
  if (start === null || end === null) return null;
  return [start, end];
}

/**
 * Parse SRT and WebVTT subtitle text into cues.
 * Tolerates CRLF, missing blank lines, absent cue numbering, the WEBVTT header,
 * NOTE/STYLE blocks and inline HTML tags. Empty cues are dropped; output is sorted by start.
 */
export function parseSrt(raw: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  let start = 0;
  let end = 0;
  let hasTiming = false;
  let textLines: string[] = [];

  const flush = () => {
    if (hasTiming) {
      const text = textLines
        .join('\n')
        .replace(/<[^>]*>/g, '') // strip <i>, <b>, <c.class>, <00:00:01.000> …
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();
      if (text && end > start) cues.push({ startSec: start, endSec: end, text });
    }
    hasTiming = false;
    textLines = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const times = parseTimingLine(line);
    if (times) {
      flush();
      start = times[0];
      end = times[1];
      hasTiming = true;
      continue;
    }
    if (!line) {
      flush();
      continue;
    }
    if (!hasTiming) continue; // WEBVTT header, NOTE/STYLE blocks, cue numbering
    // bare number while collecting text: either a literal text line or the next
    // block's numbering when the blank separator is missing — peek ahead to decide
    if (/^\d+$/.test(line)) {
      let ni = i + 1;
      while (ni < lines.length && !lines[ni].trim()) ni++;
      if (ni < lines.length && parseTimingLine(lines[ni].trim())) {
        flush();
        continue;
      }
    }
    textLines.push(line);
  }
  flush();
  return cues.sort((a, b) => a.startSec - b.startSec);
}

// ---------- subtitle export (SRT + WebVTT round-trip) ----------

const pad2 = (n: number) => String(n).padStart(2, '0');
const pad3 = (n: number) => String(n).padStart(3, '0');

/** Format seconds as `HH:MM:SS,mmm` (SRT) or `HH:MM:SS.mmm` (WebVTT). Negative input clamps to 0. */
function formatCueTime(sec: number, msSep: ',' | '.'): string {
  const total = Math.max(0, Math.round(sec * 1000));
  const ms = total % 1000;
  const t = (total - ms) / 1000;
  const ss = t % 60;
  const mm = Math.floor(t / 60) % 60;
  const hh = Math.floor(t / 3600);
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}${msSep}${pad3(ms)}`;
}

/** Canonical cue order/timing for export: sorted by startSec (stable), end clamped strictly past start. */
function orderedCues(cues: SubtitleCue[]): SubtitleCue[] {
  return [...cues]
    .filter((c) => c && Number.isFinite(c.startSec) && Number.isFinite(c.endSec))
    .sort((a, b) => a.startSec - b.startSec)
    .map((c) => {
      const start = Math.max(0, c.startSec);
      const end = c.endSec > start ? c.endSec : start + 0.001; // end must be > start
      return { startSec: start, endSec: end, text: c.text };
    });
}

/**
 * Serialize cues to SRT: `1\nHH:MM:SS,mmm --> HH:MM:SS,mmm\ntext` blocks separated
 * by blank lines. Text passes through verbatim (multi-line preserved); cues are
 * ordered by startSec; end times are clamped to be strictly greater than start.
 */
export function buildSrt(cues: SubtitleCue[]): string {
  const ordered = orderedCues(cues);
  if (!ordered.length) return '';
  return ordered
    .map((c, i) => `${i + 1}\n${formatCueTime(c.startSec, ',')} --> ${formatCueTime(c.endSec, ',')}\n${c.text}`)
    .join('\n\n') + '\n';
}

/**
 * Serialize cues to WebVTT: `WEBVTT` header + numbered cue blocks with
 * `HH:MM:SS.mmm` timestamps. Same ordering/clamping rules as buildSrt.
 */
export function buildVtt(cues: SubtitleCue[]): string {
  const ordered = orderedCues(cues);
  if (!ordered.length) return 'WEBVTT\n';
  return 'WEBVTT\n\n' + ordered
    .map((c, i) => `${i + 1}\n${formatCueTime(c.startSec, '.')} --> ${formatCueTime(c.endSec, '.')}\n${c.text}`)
    .join('\n\n') + '\n';
}

/** Word-wrap subtitle text to at most `maxLines` lines, breaking at ~`maxChars` characters. */
function wrapSubtitleText(text: string, maxChars = 42, maxLines = 2): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];
  const words = clean.split(' ');
  const lines: string[] = [];
  let cur = '';
  let i = 0;
  for (; i < words.length; i++) {
    const cand = cur ? `${cur} ${words[i]}` : words[i];
    if (cand.length > maxChars && cur) {
      if (lines.length === maxLines - 1) break; // last line keeps the remainder
      lines.push(cur);
      cur = words[i];
    } else {
      cur = cand;
    }
  }
  let last = words.slice(i).join(' ');
  if (last && cur) last = `${cur} ${last}`;
  else if (cur) last = cur;
  const lastMax = Math.round(maxChars * 1.4); // long single lines are hard-clipped with an ellipsis
  if (last.length > lastMax) last = `${last.slice(0, lastMax).trimEnd()}…`;
  if (last) lines.push(last);
  return lines.slice(0, maxLines);
}

/**
 * Theme-safe saturated hues for subtitle speaker prefixes — emerald / violet /
 * amber / rose / teal / orange / lime / fuchsia. Deliberately NO blue/indigo
 * (project palette rule). A speaker's hue is a pure function of their name
 * (stable hash), so the same character keeps the same color across renders,
 * sessions and exports.
 */
const SPEAKER_HUES = ['#10b981', '#8b5cf6', '#f59e0b', '#f43f5e', '#14b8a6', '#f97316', '#84cc16', '#d946ef'] as const;

function speakerHue(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return SPEAKER_HUES[h % SPEAKER_HUES.length];
}

/** Rounded-rectangle path (manual, works everywhere `arcTo` does). */
function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

const FILTERS: Record<VideoClip['filter'], string> = {
  none: 'none',
  grayscale: 'grayscale(1)',
  sepia: 'sepia(0.85)',
  vintage: 'sepia(0.4) contrast(1.1) saturate(0.85) brightness(1.05)',
  cool: 'saturate(1.1) hue-rotate(-12deg) brightness(1.03)',
  warm: 'saturate(1.12) hue-rotate(10deg) brightness(1.04)',
};

export class VideoRenderer {
  private images = new Map<string, HTMLImageElement>();
  private bgmSource: AudioBufferSourceNode | null = null;

  constructor(private canvas: HTMLCanvasElement, private project: VideoProject) {
    canvas.width = project.width;
    canvas.height = project.height;
  }

  setProject(p: VideoProject) {
    this.project = p;
    if (this.canvas.width !== p.width || this.canvas.height !== p.height) {
      this.canvas.width = p.width;
      this.canvas.height = p.height;
    }
  }

  getProject(): VideoProject {
    return this.project;
  }

  clipStart(index: number): number {
    let t = 0;
    for (let i = 0; i < index; i++) t += this.project.clips[i]?.durationSec ?? 0;
    return t;
  }

  totalDurationSec(): number {
    return this.project.clips.reduce((a, c) => a + Math.max(0.1, c.durationSec), 0);
  }

  private loadImage(assetId: string, url: string): HTMLImageElement {
    let img = this.images.get(assetId);
    if (!img) {
      img = new Image();
      img.src = url;
      this.images.set(assetId, img);
    }
    return img;
  }

  /** Draw the frame at time t (seconds) onto the canvas. */
  drawFrameAt(tSec: number, assets: AssetItem[] = []): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const { width: W, height: H, clips } = this.project;
    ctx.save();
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0b0b0c';
    ctx.fillRect(0, 0, W, H);

    let elapsed = 0;
    let activeIdx = -1;
    let localT = 0;
    for (let i = 0; i < clips.length; i++) {
      const d = Math.max(0.1, clips[i].durationSec);
      if (tSec < elapsed + d || i === clips.length - 1) {
        activeIdx = i;
        localT = tSec - elapsed;
        break;
      }
      elapsed += d;
    }
    if (activeIdx < 0) {
      if (this.project.subtitles?.length) this.drawSubtitles(ctx, tSec, W, H); // empty timeline still previews the subtitle track
      ctx.restore();
      return;
    }

    const clip = clips[activeIdx];
    const dur = Math.max(0.1, clip.durationSec);
    const progress = Math.min(1, Math.max(0, localT / dur));

    // transition-in from previous clip
    const TRANS = 0.6;
    const inTransition = localT < TRANS && activeIdx > 0 && clip.transition !== 'none';

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.clip();

    if (clip.transition === 'wipe' && inTransition) {
      ctx.beginPath();
      ctx.rect(0, 0, W * (localT / TRANS), H);
      ctx.clip();
    }

    // base layer
    this.drawClipBase(ctx, clip, progress, assets, W, H);

    // transition-in overlay (previous clip fading out)
    if (inTransition && clip.transition === 'fade') {
      const prev = clips[activeIdx - 1];
      ctx.globalAlpha = 1 - localT / TRANS;
      this.drawClipBase(ctx, prev, 1, assets, W, H);
      ctx.globalAlpha = 1;
    }
    if (clip.transition === 'slide' && inTransition) {
      const shift = W * (1 - localT / TRANS);
      ctx.translate(-shift, 0);
    }
    if (clip.transition === 'wipe' && inTransition) {
      // handled via clip region
    }
    ctx.restore();

    // filter applied over base: re-draw with filter by snapshotting — simpler: apply via ctx.filter during base draw
    // (base draw applies filter internally)

    // overlay text
    if (clip.overlay?.text) {
      this.drawOverlay(ctx, clip, W, H);
    }

    // title-clip main text
    if (clip.type === 'text' && clip.text) {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const size = Math.round(W / 12);
      ctx.font = `bold ${size}px "Segoe UI", Arial, sans-serif`;
      ctx.fillStyle = clip.color2 ?? '#ffffff';
      ctx.shadowColor = 'rgba(0,0,0,0.45)';
      ctx.shadowBlur = 12;
      const lines = clip.text.split('\n').slice(0, 4);
      const midY = H / 2 - ((lines.length - 1) * size * 1.2) / 2;
      lines.forEach((line, i) => ctx.fillText(line, W / 2, midY + i * size * 1.2));
      ctx.restore();
    }

    // subtitles — always the top-most layer (above overlay + title text)
    if (this.project.subtitles?.length) {
      this.drawSubtitles(ctx, tSec, W, H);
    }

    ctx.restore();
  }

  private drawClipBase(
    ctx: CanvasRenderingContext2D,
    clip: VideoClip,
    progress: number,
    assets: AssetItem[],
    W: number,
    H: number,
  ) {
    ctx.save();
    if (clip.filter !== 'none') ctx.filter = FILTERS[clip.filter];

    if (clip.type === 'color' && clip.color) {
      ctx.fillStyle = clip.color;
      ctx.fillRect(0, 0, W, H);
    } else if (clip.type === 'gradient' && clip.color && clip.color2) {
      const g = ctx.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, clip.color);
      g.addColorStop(1, clip.color2);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    } else if (clip.type === 'image') {
      const asset = assets.find((a) => a.id === clip.assetId);
      let img = asset?.blobUrl ? this.loadImage(asset.id, asset.blobUrl) : undefined;
      if (img && img.complete && img.naturalWidth > 0) {
        // Ken Burns
        let scale = 1.02;
        let dx = 0;
        let dy = 0;
        const kb = 0.12 * progress;
        switch (clip.kenBurns) {
          case 'zoom-in': scale = 1.02 + kb; break;
          case 'zoom-out': scale = 1.14 - kb; break;
          case 'pan-left': scale = 1.1; dx = kb * W * 0.5; break;
          case 'pan-right': scale = 1.1; dx = -kb * W * 0.5; break;
          default: break;
        }
        const ratio = Math.max(W / img.naturalWidth, H / img.naturalHeight) * scale;
        const dw = img.naturalWidth * ratio;
        const dh = img.naturalHeight * ratio;
        ctx.drawImage(img, (W - dw) / 2 + dx, (H - dh) / 2 + dy, dw, dh);
      } else {
        ctx.fillStyle = clip.color ?? '#1c1c1f';
        ctx.fillRect(0, 0, W, H);
      }
    }
    ctx.restore();
  }

  /**
   * Draw the active subtitle for time t — wrapped, centered, optional pill
   * background + outline. When the cue carries a `speaker` and the style does
   * not explicitly disable it (`showSpeaker !== false`), the name is drawn as a
   * bold colored prefix at the head of the first line (hue = stable hash of the
   * name). Cues without a speaker keep the exact pre-speaker pixel behavior.
   */
  private drawSubtitles(ctx: CanvasRenderingContext2D, tSec: number, W: number, H: number) {
    const cue = this.project.subtitles?.find((c) => tSec >= c.startSec && tSec < c.endSec);
    if (!cue) return;
    const st = {
      fontSize: 5, // % of frame height
      color: '#ffffff',
      position: 'bottom' as const,
      background: true,
      outline: true,
      ...this.project.subtitleStyle,
    };
    const speaker = st.showSpeaker !== false && typeof cue.speaker === 'string' ? cue.speaker.trim() : '';
    // folding `speaker` into the wrapped text makes line 1 account for the prefix width
    const wrapped = wrapSubtitleText(speaker ? `${speaker} ${cue.text}` : cue.text, 42, 2);
    if (!wrapped.length) return;

    const size = Math.max(10, Math.round((st.fontSize / 100) * H));
    const lineH = size * 1.25;
    const totalH = wrapped.length * lineH;
    let midY: number;
    if (st.position === 'top') midY = size * 1.2 + totalH / 2;
    else if (st.position === 'center') midY = H / 2;
    else midY = H - size * 1.2 - totalH / 2;

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `bold ${size}px "Segoe UI", Arial, sans-serif`;

    if (st.background) {
      const maxLineW = Math.max(...wrapped.map((l) => ctx.measureText(l).width));
      const padX = size * 0.55;
      const padY = size * 0.3;
      const boxW = Math.min(W * 0.94, maxLineW + padX * 2);
      const boxH = totalH + padY * 2;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      roundRectPath(ctx, (W - boxW) / 2, midY - totalH / 2 - padY, boxW, boxH, Math.min(boxH / 2, size * 0.5));
      ctx.fill();
    }

    if (st.outline) {
      ctx.lineWidth = Math.max(2, size / 8);
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
    }

    wrapped.forEach((line, i) => {
      const y = midY + (i - (wrapped.length - 1) / 2) * lineH;
      if (i === 0 && speaker && line.startsWith(`${speaker} `)) {
        // first line = speaker prefix + cue text, one centered block, two fills
        const rest = line.slice(speaker.length + 1);
        const prefixW = ctx.measureText(speaker).width;
        const spaceW = ctx.measureText(' ').width;
        const restW = ctx.measureText(rest).width;
        const x0 = W / 2 - (prefixW + spaceW + restW) / 2;
        ctx.textAlign = 'left';
        const restX = x0 + prefixW + spaceW;
        if (st.outline) {
          ctx.strokeText(speaker, x0, y);
          ctx.strokeText(rest, restX, y);
        }
        ctx.fillStyle = speakerHue(speaker);
        ctx.fillText(speaker, x0, y);
        ctx.fillStyle = st.color;
        ctx.fillText(rest, restX, y);
        ctx.textAlign = 'center';
      } else {
        if (st.outline) ctx.strokeText(line, W / 2, y);
        ctx.fillStyle = st.color;
        ctx.fillText(line, W / 2, y);
      }
    });
    ctx.restore();
  }

  private drawOverlay(ctx: CanvasRenderingContext2D, clip: VideoClip, W: number, H: number) {
    const ov = clip.overlay!;
    ctx.save();
    ctx.textAlign = 'center';
    const size = Math.max(14, Math.round((ov.size / 100) * H));
    ctx.font = `bold ${size}px "Segoe UI", Arial, sans-serif`;
    if (ov.shadow) {
      ctx.shadowColor = 'rgba(0,0,0,0.55)';
      ctx.shadowBlur = size / 5;
    }
    ctx.fillStyle = ov.color;
    const lines = ov.text.split('\n').slice(0, 3);
    const y = ov.position === 'top' ? size * 1.6 : ov.position === 'center' ? H / 2 : H - size * 1.4 - (lines.length - 1) * size * 1.25;
    lines.forEach((line, i) => ctx.fillText(line, W / 2, y + i * size * 1.25, W * 0.92));
    ctx.restore();
  }

  /** Play a buffer into the given destination node (must share the same context). Returns a stop function. */
  playSoundtrack(ctx: BaseAudioContext, buffer: AudioBuffer, destination: AudioNode, fromSec = 0): () => void {
    this.stopSoundtrack();
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(destination);
    src.start(0, fromSec);
    this.bgmSource = src as unknown as AudioBufferSourceNode;
    return () => {
      try { src.stop(); } catch { /* already stopped */ }
      this.bgmSource = null;
    };
  }

  stopSoundtrack() {
    try { this.bgmSource?.stop(); } catch { /* noop */ }
    this.bgmSource = null;
  }
}

// ---------- export ----------
interface Mp4Support {
  mp4: boolean;
}
let mp4SupportCache: Mp4Support | null = null;

export function detectExportFormats(): { id: VideoExportOptions['format']; label: string; supported: boolean }[] {
  if (typeof MediaRecorder === 'undefined') {
    return [
      { id: 'webm-vp9', label: 'WebM (VP9)', supported: false },
      { id: 'webm-vp8', label: 'WebM (VP8)', supported: false },
      { id: 'mp4-h264', label: 'MP4 (H.264)', supported: false },
    ];
  }
  const supported = (mime: string) => MediaRecorder.isTypeSupported(mime);
  if (!mp4SupportCache) {
    mp4SupportCache = { mp4: supported('video/mp4;codecs=avc1.42E01E') || supported('video/mp4') };
  }
  return [
    { id: 'webm-vp9', label: 'WebM (VP9)', supported: supported('video/webm;codecs=vp9') },
    { id: 'webm-vp8', label: 'WebM (VP8)', supported: supported('video/webm;codecs=vp8') },
    { id: 'mp4-h264', label: 'MP4 (H.264)', supported: mp4SupportCache.mp4 },
  ];
}

const BITRATES: Record<VideoExportOptions['quality'], number> = {
  low: 1_200_000,
  medium: 4_000_000,
  high: 10_000_000,
};

/**
 * Bake the optional music bed (project.musicBedAssetId + project.musicBed) into a
 * single soundtrack buffer: voice = narration soundtrack, bed looped/ducked under
 * it via mixMusicBed. Returns null when no bed is configured — callers keep their
 * existing voice-only path untouched. Bed failures never throw: they log (via
 * `onLog` when provided) and return null so exports continue voice-only.
 */
export function bakeMusicBed(
  project: VideoProject,
  assets: AssetItem[],
  lengthSec: number,
  onLog?: (msg: string) => void,
): { buffer: AudioBuffer; envelope: Float32Array | null; settings: MusicBedSettings } | null {
  const bedAsset = project.musicBedAssetId ? assets.find((a) => a.id === project.musicBedAssetId && a.buffer) : undefined;
  const settings = project.musicBed;
  if (!bedAsset?.buffer || !settings) return null;
  try {
    const bed = bedAsset.buffer;
    const soundtrack = assets.find((a) => a.id === project.soundtrackAssetId && a.buffer);
    const voice = soundtrack?.buffer ?? makeSilenceBuffer(lengthSec, bed.sampleRate, bed.numberOfChannels as 1 | 2);
    // mixMusicBed outputs the voice's length/rate — size the envelope to match exactly
    const len = voice.length;
    const env = settings.duck
      ? computeDuckEnvelope(voice, len, voice.sampleRate, { amount: settings.duckAmount, attackMs: settings.attackMs, releaseMs: settings.releaseMs })
      : null;
    const mixed = mixMusicBed(voice, bed, { ...settings, duckEnvelope: env ?? undefined });
    if (onLog) {
      if (env) {
        let minGain = 1;
        for (let i = 0; i < env.length; i++) if (env[i] < minGain) minGain = env[i];
        const floorDb = 20 * Math.log10(Math.max(1e-6, minGain));
        onLog(`Ducked music bed mixed: ${floorDb.toFixed(1)} dB floor (bed ${Math.round(settings.volume * 100)}%, amount ${Math.round(settings.duckAmount * 100)}%)`);
      } else {
        onLog(`Music bed mixed at ${Math.round(settings.volume * 100)}% (ducking off)`);
      }
    }
    return { buffer: mixed, envelope: env, settings };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onLog?.(`Music bed mix failed — continuing with voice only (${msg})`);
    return null;
  }
}

/**
 * Export the project by recording the canvas in real time with MediaRecorder,
 * mixing the soundtrack (and an optional ducked music bed) in via Web Audio.
 * Designed for the job queue: yields to the UI, supports cancellation via
 * `aborted`, and reports mixdown details via `onLog`. The no-bed path is
 * byte-identical to the pre-music-bed behavior.
 */
export async function exportVideo(
  project: VideoProject,
  assets: AssetItem[],
  opts: VideoExportOptions & { aborted?: () => boolean; onLog?: (msg: string) => void },
): Promise<Blob> {
  const canvas = document.createElement('canvas');
  const renderer = new VideoRenderer(canvas, project);
  const total = renderer.totalDurationSec();
  if (total <= 0) throw new Error('Timeline is empty — add clips first');

  const formats = detectExportFormats();
  const fmt = formats.find((f) => f.id === opts.format && f.supported);
  if (!fmt) throw new Error(`${opts.format} is not supported by this browser — pick an enabled format`);

  const mime = opts.format === 'mp4-h264'
    ? 'video/mp4;codecs=avc1.42E01E'
    : opts.format === 'webm-vp9'
      ? 'video/webm;codecs=vp9'
      : 'video/webm;codecs=vp8';

  const audioCtx = new AudioContext();
  const dest = audioCtx.createMediaStreamDestination();
  const gain = audioCtx.createGain();
  gain.gain.value = 1;
  gain.connect(dest);

  const stream = canvas.captureStream(project.fps);
  const audioTrack = dest.stream.getAudioTracks()[0];
  if (audioTrack) stream.addTrack(audioTrack);

  const recorder = new MediaRecorder(stream, {
    mimeType: mime,
    videoBitsPerSecond: BITRATES[opts.quality],
    audioBitsPerSecond: 192_000,
  });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  const done = new Promise<Blob>((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mime.split(';')[0] }));
  });

  // soundtrack (+ optional baked music bed — mixdown happens before recording so
  // the exported audio track contains the ducked mix)
  const soundtrack = assets.find((a) => a.id === project.soundtrackAssetId && a.buffer);
  const bed = bakeMusicBed(project, assets, total, opts.onLog);
  const sourceBuffer = bed?.buffer ?? soundtrack?.buffer ?? null;
  const stopMusic = sourceBuffer ? renderer.playSoundtrack(audioCtx, sourceBuffer, gain) : () => {};

  recorder.start(1000);
  const t0 = performance.now();
  await new Promise<void>((resolve) => {
    const loop = () => {
      const t = (performance.now() - t0) / 1000;
      if (t >= total || opts.aborted?.()) {
        resolve();
        return;
      }
      renderer.drawFrameAt(t, assets);
      opts.onProgress?.(t / total);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });

  stopMusic();
  recorder.stop();
  const blob = await done;
  stream.getTracks().forEach((tr) => tr.stop());
  void audioCtx.close();
  await yieldToUI();
  return blob;
}
