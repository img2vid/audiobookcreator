// Optional helper that downloads the large files which are deliberately NOT part
// of the repository:
//
//   node scripts/fetch-assets.mjs ocr [lang ...]        default: eng
//   node scripts/fetch-assets.mjs model [360m|135m]     default: 360m
//
// Existing files are kept (pass --force to re-download). Works on Windows, macOS
// and Linux with Node >= 20 — no extra dependencies. Used by the GitHub Pages
// workflow, and handy locally (`npm run fetch:ocr`, `npm run fetch:model`).

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const force = args.includes('--force');
const [kind, ...rest] = args.filter((a) => !a.startsWith('--'));

const MODELS = {
  '360m': { repo: 'onnx-community/SmolLM2-360M-Instruct-ONNX', folder: 'smollm2-360m-instruct', weights: 'onnx/model_q4f16.onnx' },
  '135m': { repo: 'onnx-community/SmolLM2-135M-Instruct-ONNX', folder: 'smollm2-135m-instruct', weights: 'onnx/model_q4f16.onnx' },
  '1.7b': { repo: 'onnx-community/SmolLM2-1.7B-Instruct-ONNX', folder: 'smollm2-1p7b-instruct', weights: 'onnx/model_q4.onnx' },
  'qwen1.5b': { repo: 'onnx-community/Qwen2.5-1.5B-Instruct-ONNX', folder: 'qwen25-1p5b-instruct', weights: 'onnx/model_q4.onnx' },
  'llama1b': { repo: 'onnx-community/Llama-3.2-1B-Instruct-ONNX', folder: 'llama32-1b-instruct', weights: 'onnx/model_q4.onnx' },
  'phi3.5': { repo: 'onnx-community/Phi-3.5-mini-instruct-ONNX', folder: 'phi35-mini-instruct', weights: 'onnx/model_q4.onnx' },
};
const MODEL_FILES = [
  'config.json',
  'generation_config.json',
  'merges.txt',
  'quantize_config.json',
  'special_tokens_map.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'vocab.json',
];

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

async function download(url, dest) {
  if (!force && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    console.log(`  ✓ already present: ${path.relative(root, dest)}`);
    return;
  }
  const tmp = `${dest}.part`;
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const total = Number(res.headers.get('content-length')) || 0;
      let got = 0;
      let lastPrint = 0;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const body = Readable.fromWeb(res.body);
      body.on('data', (chunk) => {
        got += chunk.length;
        const now = Date.now();
        if (process.stdout.isTTY && now - lastPrint > 400) {
          lastPrint = now;
          process.stdout.write(`\r  ↓ ${path.basename(dest)} ${mb(got)}${total ? ` / ${mb(total)}` : ''}   `);
        }
      });
      await pipeline(body, fs.createWriteStream(tmp));
      if (process.stdout.isTTY) process.stdout.write('\r');
      fs.renameSync(tmp, dest);
      console.log(`  ↓ downloaded ${path.relative(root, dest)} (${mb(got)})`);
      return;
    } catch (err) {
      lastErr = err;
      fs.rmSync(tmp, { force: true });
      if (attempt < 3) await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw new Error(`Could not download ${url}: ${lastErr?.message ?? lastErr}`);
}

async function main() {
  if (kind === 'ocr') {
    const langs = rest.length ? rest : ['eng'];
    console.log(`OCR language data → public/ocr/lang/ (${langs.join(', ')})`);
    for (const lang of langs) {
      if (!/^[a-z_]{3,12}$/i.test(lang)) throw new Error(`Invalid language code: ${lang}`);
      await download(
        `https://github.com/tesseract-ocr/tessdata_fast/raw/main/${lang}.traineddata`,
        path.join(root, 'public', 'ocr', 'lang', `${lang}.traineddata`),
      );
    }
    return;
  }
  if (kind === 'model') {
    const key = (rest[0] ?? '360m').toLowerCase();
    const model = MODELS[key];
    if (!model) throw new Error(`Unknown model "${key}". Use: ${Object.keys(MODELS).join(' | ')}`);
    console.log(`AutoBook AI model ${model.repo} → public/models/autobook-ai/${model.folder}/`);
    const required = ['config.json', 'tokenizer.json', 'tokenizer_config.json', model.weights];
    const optional = MODEL_FILES.filter((f) => !required.includes(f));
    for (const file of required) {
      await download(
        `https://huggingface.co/${model.repo}/resolve/main/${file}`,
        path.join(root, 'public', 'models', 'autobook-ai', model.folder, ...file.split('/')),
      );
    }
    for (const file of optional) {
      try {
        await download(
          `https://huggingface.co/${model.repo}/resolve/main/${file}`,
          path.join(root, 'public', 'models', 'autobook-ai', model.folder, ...file.split('/')),
        );
      } catch {
        console.log(`  • skipped optional ${file} (not published for this model)`);
      }
    }
    return;
  }
  console.log(`Usage:\n  node scripts/fetch-assets.mjs ocr [lang ...]\n  node scripts/fetch-assets.mjs model [${Object.keys(MODELS).join('|')}]  [--force]`);
  process.exitCode = 1;
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(process.env.GITHUB_ACTIONS ? `::warning::${msg}` : `\n✗ ${msg}`);
  process.exitCode = 1;
});
