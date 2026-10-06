# Openmukti Audiobook Studio

Fully local, in-browser text-to-speech, OCR, audiobook, dialogue and video suite.
It is a **static site** — no server, no database, no uploads. It runs from `npm run dev`
on your machine and deploys as-is to **GitHub Pages**.

## Quick start (VS Code + npm)

Requires **Node.js 20.9 or newer** (22 recommended — see `.nvmrc`).

```bash
npm install
npm run dev          # http://localhost:3000
```

Open the folder in VS Code and accept the recommended extensions. `Ctrl+Shift+B` builds, and
**Terminal → Run Task…** has dev server, preview, type-check, lint and the asset downloaders.

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server on port 3000 (copies runtime assets first) |
| `npm run build` | Production static export into `out/` |
| `npm run preview` | Serves `out/` exactly like GitHub Pages (honours `NEXT_PUBLIC_BASE_PATH`) |
| `npm run typecheck` / `npm run lint` | TypeScript and ESLint checks |
| `npm run fetch:ocr` | Downloads `eng.traineddata` into `public/ocr/lang/` |
| `npm run fetch:model` | Downloads the AutoBook AI model (`-- 135m` for the small one) |
| `npm run clean` | Deletes `.next/` and `out/` |

## Files you add yourself (optional)

The app runs without them; the matching features just stay off or fall back.

**OCR language data** — needed for scanned PDFs:
`public/ocr/lang/eng.traineddata` (the "tessdata_fast" English file, ~4 MB, not gzipped).
Other languages: `npm run fetch:ocr -- deu fra` (or drop `<lang>.traineddata` files in the same folder).

**AutoBook AI model** — needed for the language-model "director". Place the files from
`onnx-community/SmolLM2-360M-Instruct-ONNX` here:

```text
public/models/autobook-ai/smollm2-360m-instruct/
├── config.json  generation_config.json  merges.txt  quantize_config.json
├── special_tokens_map.json  tokenizer.json  tokenizer_config.json  vocab.json
└── onnx/model_q4f16.onnx          (~272 MB)
```

For low-memory machines use `smollm2-135m-instruct/` (`onnx-community/SmolLM2-135M-Instruct-ONNX`, ~117 MB).
Details: [`docs/LOCAL_AI_MODELS.md`](docs/LOCAL_AI_MODELS.md).

## Deploy to GitHub Pages

1. Push this folder to a GitHub repository (branch `main`).
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. The workflow `.github/workflows/deploy-pages.yml` runs on every push to `main`
   (or run it by hand from the **Actions** tab). It installs, type-checks, builds and publishes.
4. Your site appears at `https://<user>.github.io/<repo>/`.

The base path is set automatically from the repository name (a repository called
`<user>.github.io` is served from `/`). Building by hand for a project site:

```bash
NEXT_PUBLIC_BASE_PATH=/my-repo npm run build        # PowerShell: $env:NEXT_PUBLIC_BASE_PATH="/my-repo"
NEXT_PUBLIC_BASE_PATH=/my-repo npm run preview      # → http://localhost:3000/my-repo/
```

**The AI model and GitHub's 100 MB limit.** The `.onnx` weight is larger than GitHub allows in a
repository, so it is git-ignored and **not committed**. Instead the workflow downloads it from
Hugging Face while building and publishes it as part of the site (the published site may be up to
1 GB). Control this with a repository variable (**Settings → Secrets and variables → Actions →
Variables**): `AUTOBOOK_MODEL` = `360m` (default), `135m`, or `none` to skip the model.
The small OCR file *can* be committed; if it isn't, the workflow fetches it too.

## Where your data lives

Saved projects, drafts, the asset bin and settings are stored in your browser (IndexedDB /
localStorage) for that site's address. Nothing is sent anywhere. Clearing site data removes them;
`localhost:3000` and the GitHub Pages address each keep their own separate copy.

## Notes and limits

- GitHub Pages cannot send the `COOP/COEP` headers that multi-threaded WebAssembly needs, so the
  AI model runs single-threaded on the CPU path; WebGPU is used automatically when available.
- Everything the app needs at runtime (fonts, OCR engine, PDF renderer, ONNX Runtime) is served
  from the site itself — nothing loads from a CDN. The build itself needs internet only for `npm install`
  (and the optional downloads above).
- Private repositories need a GitHub plan that includes Pages for private repos.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Blank page / 404s for `/_next/...` on GitHub Pages | The build used the wrong base path. Use the provided workflow, or set `NEXT_PUBLIC_BASE_PATH=/<repo>` |
| "Model not installed" in AutoBook | Add the model files above (or `npm run fetch:model`) and reload |
| Scanned PDF returns no text | `public/ocr/lang/eng.traineddata` is missing — run `npm run fetch:ocr` |
| `npm run preview` says "No ./out folder" | Run `npm run build` first |
| Port 3000 busy | `PORT=3001 npm run preview`, or `npx next dev -p 3001` |
