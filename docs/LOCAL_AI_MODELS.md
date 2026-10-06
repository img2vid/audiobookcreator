# Local AI model setup

The AutoBook intelligence layer is a real in-browser language model, not just the existing name/quote heuristic. It is implemented with `@huggingface/transformers` and ONNX weights stored under `public/models/autobook-ai/`.

## Quick start

Run the fetch script for the model you want:

```bash
npm run fetch:model            # default: SmolLM2 360M (recommended)
node scripts/fetch-assets.mjs model 135m      # ultra-light
node scripts/fetch-assets.mjs model 1.7b      # advanced
node scripts/fetch-assets.mjs model qwen1.5b  # advanced
node scripts/fetch-assets.mjs model llama1b   # advanced
node scripts/fetch-assets.mjs model phi3.5    # largest
```

Or download the files manually from Hugging Face — each model needs `config.json`, `tokenizer.json`, `tokenizer_config.json`, and at least one ONNX weight under `onnx/`.

## Model tiers

| Tier | Model | Size | Best for |
|------|-------|------|----------|
| fast | SmolLM2 135M Instruct | ~117 MB | Low-memory machines; quick drafts |
| balanced (default) | SmolLM2 360M Instruct | ~272 MB | Everyday use — good dialogue/casting decisions |
| advanced | SmolLM2 1.7B Instruct | ~1.1 GB | Best SmolLM reasoning; slow on CPU |
| advanced | Qwen2.5 1.5B Instruct | ~980 MB | Strong instruction following, long books |
| advanced | Llama 3.2 1B Instruct | ~800 MB | Sharp character/persona inference |
| advanced | Phi-3.5 Mini Instruct | ~2.4 GB | Highest quality overall; WebGPU strongly recommended |

Advanced-tier models run on CPU (WASM) if WebGPU is unavailable — the pipeline
never aborts, it just takes longer. Every line is still AI-verified.

## Folder layout

```text
public/models/autobook-ai/smollm2-360m-instruct/
├── config.json
├── generation_config.json
├── special_tokens_map.json
├── tokenizer.json
├── tokenizer_config.json
└── onnx/
    └── model_q4f16.onnx        # or model_q4.onnx / model_fp16.onnx …
```

Model sources (onnx-community):

- `SmolLM2-360M-Instruct-ONNX` — recommended
- `SmolLM2-135M-Instruct-ONNX` — ultra-light
- `SmolLM2-1.7B-Instruct-ONNX` — advanced
- `Qwen2.5-1.5B-Instruct-ONNX` — advanced
- `Llama-3.2-1B-Instruct-ONNX` — advanced
- `Phi-3.5-mini-instruct-ONNX` — advanced, largest

The loader probes each declared dtype (`q4f16`, `q4`, `q8`, `fp16`, `fp32`) and
uses the first weight file present, so partial downloads of a different dtype
still work. Some repositories do not publish `vocab.json`/`merges.txt` (e.g.
Llama 3.2) — the fetch script treats those as optional.
