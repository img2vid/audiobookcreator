// Node ESM loader: maps the app's "@/lib/…" alias to real paths so the pure
// engine modules (autobook.ts, autobook-cast.ts, dialogue-patterns.ts) can be
// exercised directly under Node's TypeScript type-stripping.
// Also resolves extensionless relative imports ("./formant" → "./formant.ts"),
// which lets the test suite load the full engine graph (markup → formant, …).
import { pathToFileURL } from 'node:url';

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@/lib/')) {
    const target = pathToFileURL(new URL('../src/lib/' + specifier.slice(6) + '.ts', import.meta.url).pathname);
    return next(target.href, context);
  }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) &&
    !/\.(ts|mts|js|mjs|json|node|css|wasm)$/.test(specifier)) {
    return next(specifier + '.ts', context);
  }
  return next(specifier, context);
}
