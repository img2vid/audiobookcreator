# AutoBook local AI models

AutoBook uses Transformers.js to load ONNX language models from this directory.
Runtime remote model downloads are disabled.

Recommended model:

- `smollm2-360m-instruct/`
  - `config.json`
  - `generation_config.json`
  - `merges.txt`
  - `quantize_config.json`
  - `special_tokens_map.json`
  - `tokenizer.json`
  - `tokenizer_config.json`
  - `vocab.json`
  - `onnx/model_q4f16.onnx`

Optional ultra-light model:

- `smollm2-135m-instruct/`
  - the same companion files and `onnx/model_q4f16.onnx` from the corresponding ONNX model repository.

The application can run without a model, but then AutoBook falls back to its deterministic resolver. No model is fetched at runtime.

For GitHub repositories, keep the large ONNX weight as a GitHub Release asset (or another repository distribution mechanism appropriate to your hosting setup) rather than committing a >100 MiB binary to ordinary Git history.
