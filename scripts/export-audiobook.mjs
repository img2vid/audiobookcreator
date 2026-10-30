#!/usr/bin/env node
// Turn an EXTRACTED Book Conversion Desk ZIP into one tagged audiobook.
// CPU-only; requires ffmpeg on PATH. Never loads the audio into Node memory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export function exportCommand(folder, output, tempDir) {
  const root = fs.realpathSync(folder);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'chapters.json'), 'utf8'));
  if (!Array.isArray(manifest.chapters) || !manifest.chapters.length || manifest.chapters.length > 5000) throw new Error('No valid chapters in chapters.json');
  const ext = path.extname(output).toLowerCase();
  const codecs = { '.m4b': ['-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart'], '.mp3': ['-c:a', 'libmp3lame', '-b:a', '64k'], '.flac': ['-c:a', 'flac', '-compression_level', '5'], '.wav': ['-c:a', 'pcm_s16le'] };
  if (!codecs[ext]) throw new Error('Output must end in .m4b, .mp3, .flac or .wav');
  const escapeMeta = value => String(value ?? '').replace(/[\r\n]/g, ' ').replace(/[\\;#=]/g, '\\$&');
  const list = ['ffconcat version 1.0'];
  const meta = [';FFMETADATA1', `title=${escapeMeta(manifest.title)}`, `artist=${escapeMeta(manifest.author)}`, `language=${escapeMeta(manifest.language)}`];
  let elapsed = 0;
  for (const chapter of manifest.chapters) {
    if (typeof chapter.file !== 'string' || !Number.isFinite(chapter.duration) || chapter.duration <= 0) throw new Error('Invalid chapter entry');
    const file = fs.realpathSync(path.resolve(root, chapter.file));
    if (!file.startsWith(root + path.sep) || path.extname(file).toLowerCase() !== '.wav' || /[\r\n]/.test(file)) throw new Error('Unsafe chapter path');
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size < 44) throw new Error('Missing/empty WAV');
    // The manifest is advisory. Read actual PCM duration from our fixed WAV header.
    const fd = fs.openSync(file, 'r'), header = Buffer.alloc(44);
    try { fs.readSync(fd, header, 0, 44, 0); } finally { fs.closeSync(fd); }
    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 36, 40) !== 'data' || header.readUInt16LE(20) !== 1 || header.readUInt16LE(22) !== 1 || header.readUInt32LE(24) !== 22050 || header.readUInt16LE(34) !== 16 || header.readUInt32LE(40) !== stat.size - 44) throw new Error('Expected a Book Conversion Desk 22,050 Hz mono PCM WAV');
    const duration = header.readUInt32LE(40) / (22050 * 2);
    list.push(`file '${file.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`);
    const start = Math.round(elapsed * 1000); elapsed += duration;
    meta.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${start}`, `END=${Math.round(elapsed * 1000)}`, `title=${escapeMeta(chapter.title)}`);
  }
  const concat = path.join(tempDir, 'chapters.ffconcat'), metadata = path.join(tempDir, 'metadata.txt');
  fs.writeFileSync(concat, list.join('\n') + '\n'); fs.writeFileSync(metadata, meta.join('\n') + '\n');
  return ['-nostdin', '-n', '-hide_banner', '-f', 'concat', '-safe', '0', '-i', concat,
    '-f', 'ffmetadata', '-i', metadata, '-map', '0:a:0', '-map_metadata', '1', '-map_chapters', '1',
    '-threads', '1', '-ac', '1', ...codecs[ext], path.resolve(output)];
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [folder, output] = process.argv.slice(2);
  if (!folder || !output) { console.error('Usage: node scripts/export-audiobook.mjs EXTRACTED_BOOK_FOLDER OUTPUT.m4b|mp3|flac|wav'); process.exit(1); }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'audiobook-export-'));
  try {
    const args = exportCommand(folder, output, temp);
    const child = spawn(process.env.FFMPEG_PATH || 'ffmpeg', args, { stdio: 'inherit', windowsHide: true });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    process.exitCode = code === 0 ? 0 : 1;
  } catch (err) { console.error(err.message); process.exitCode = 1; }
  finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
