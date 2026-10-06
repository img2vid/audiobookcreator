// Copies browser runtime assets from node_modules into public/ so the finished
// static site never needs a CDN:
//   - Tesseract.js worker + WASM cores        -> public/ocr/
//   - PDF.js worker                            -> public/pdfjs/
//   - ONNX Runtime WASM (used by Transformers.js) -> public/ort/
// Runs automatically before `npm run dev` and `npm run build`.
// The copied files are build output and are git-ignored.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nm = (...p) => path.join(root, 'node_modules', ...p);
const publicDir = path.join(root, 'public');

const copy = (from, to) => {
  if (!fs.existsSync(from)) return false;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  return true;
};
const findFirst = (candidates) => candidates.find((p) => fs.existsSync(p));

// --- Tesseract.js worker + cores ---------------------------------------------
const worker = findFirst([nm('tesseract.js', 'dist', 'worker.min.js'), nm('tesseract.js', 'dist', 'tesseract.min.js')]);
if (worker) copy(worker, path.join(publicDir, 'ocr', 'worker.min.js'));

// Copy EVERY core variant. Tesseract.js picks one at runtime from the browser's
// WebAssembly features (plain / SIMD / relaxed-SIMD, with or without the legacy
// engine), so a partial copy breaks OCR on some browsers. The core is resolved
// the same way tesseract.js itself resolves it, so the versions always match.
import { createRequire } from 'node:module';
let coreDir = nm('tesseract.js-core');
try {
  const tessRequire = createRequire(path.join(path.dirname(createRequire(import.meta.url).resolve('tesseract.js/package.json')), 'package.json'));
  coreDir = path.dirname(tessRequire.resolve('tesseract.js-core/package.json'));
} catch { /* fall back to the top-level copy */ }
let copiedCore = 0;
const coreFiles = fs.existsSync(coreDir) ? fs.readdirSync(coreDir).filter((n) => /^tesseract-core.*\.wasm\.js$/.test(n)) : [];
for (const name of coreFiles) {
  if (copy(path.join(coreDir, name), path.join(publicDir, 'ocr', 'core', name))) copiedCore++;
}
const EXPECTED_CORES = 6; // core, simd, lstm, simd-lstm, relaxedsimd, relaxedsimd-lstm

// --- PDF.js worker --------------------------------------------------------------
const pdfWorker = findFirst([
  nm('pdfjs-dist', 'legacy', 'build', 'pdf.worker.min.mjs'),
  nm('pdfjs-dist', 'build', 'pdf.worker.min.mjs'),
]);
if (pdfWorker) copy(pdfWorker, path.join(publicDir, 'pdfjs', 'pdf.worker.min.mjs'));

// --- ONNX Runtime WASM (Transformers.js) ----------------------------------------
const ortNames = ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm'];
let copiedOrt = 0;
for (const name of ortNames) {
  const source = findFirst([
    nm('@huggingface', 'transformers', 'dist', name),
    nm('onnxruntime-web', 'dist', name),
  ]);
  if (source && copy(source, path.join(publicDir, 'ort', name))) copiedOrt++;
}

console.log(
  `Local browser assets prepared: Tesseract worker=${Boolean(worker)}, core variants=${copiedCore}/${EXPECTED_CORES}, ` +
  `PDF worker=${Boolean(pdfWorker)}, ONNX runtime=${copiedOrt}/${ortNames.length}.`,
);

const missing = [];
if (!worker) missing.push('tesseract.js/dist/worker.min.js');
if (copiedCore < EXPECTED_CORES) missing.push('tesseract.js-core browser WASM core files');
if (!pdfWorker) missing.push('pdfjs-dist/.../pdf.worker.min.mjs');
if (copiedOrt < ortNames.length) missing.push('@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.{mjs,wasm}');
if (missing.length) {
  console.warn('Some local assets are missing — run `npm install` first. OCR / local-AI features need them:');
  for (const item of missing) console.warn(` - ${item}`);
}

// Large optional files are NOT bundled. Tell the user what is still missing.
const hints = [];
if (!fs.existsSync(path.join(publicDir, 'ocr', 'lang', 'eng.traineddata'))) {
  hints.push('OCR language data: public/ocr/lang/eng.traineddata   (or: npm run fetch:ocr)');
}
const modelDir = path.join(publicDir, 'models', 'autobook-ai');
const modelFolders = fs.existsSync(modelDir) ? fs.readdirSync(modelDir) : [];
const WEIGHT_VARIANTS = ['model_q4f16.onnx', 'model_q4.onnx', 'model_q8.onnx', 'model_fp16.onnx', 'model_fp32.onnx', 'model.onnx'];
const hasModel = modelFolders.some((d) =>
  WEIGHT_VARIANTS.some((w) => fs.existsSync(path.join(modelDir, d, 'onnx', w))),
);
if (!hasModel) {
  hints.push('AutoBook AI model: public/models/autobook-ai/<model>/onnx/model_*.onnx   (or: npm run fetch:model)');
}
if (hints.length) {
  console.log('Optional files not found (the app still runs; those features fall back or stay off):');
  for (const h of hints) console.log(` - ${h}`);
}
