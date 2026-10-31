#!/usr/bin/env node
// Deterministic synthetic WAV used by CI. NOT Balabolka or a voice-quality test.
// Simulates the balcon.exe protocol to test local bridge routing/export.
import fs from 'node:fs';

const args = process.argv.slice(2);
if (args.includes('-l')) {
  process.stdout.write('Microsoft Zira Desktop\nMicrosoft David Desktop\n');
  process.exit(0);
}
function value(flag) {
  const index = args.indexOf(flag);
  if (index < 0 || index + 1 >= args.length) throw new Error('Missing ' + flag);
  return args[index + 1];
}
const text = fs.readFileSync(value('-f'), 'utf8').replace(/^\uFEFF/, '');
const file = value('-w');
const hz = 22050;
const frames = Math.max(9000, Math.min(hz * 8, text.length * 700));
const wav = Buffer.alloc(44 + frames * 2);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4);
wav.write('WAVE', 8); wav.write('fmt ', 12); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(hz, 24); wav.writeUInt32LE(hz * 2, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(frames * 2, 40);
for (let i = 0; i < frames; i++) {
  const envelope = Math.sin(Math.PI * i / frames);
  const signal = Math.sin(2 * Math.PI * 220 * i / hz);
  wav.writeInt16LE(Math.round(signal * envelope * 4000), 44 + i * 2);
}
setTimeout(() => fs.writeFileSync(file, wav), text.includes('slow') ? 10000 : 20);
