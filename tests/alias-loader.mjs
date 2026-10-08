// Node ESM loader: maps the app's "@/lib/…" alias to real paths so the pure
// engine modules (autobook.ts, autobook-cast.ts, dialogue-patterns.ts) can be
// exercised directly under Node's TypeScript type-stripping.
import { pathToFileURL } from 'node:url';

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@/lib/')) {
    const target = pathToFileURL(new URL('../src/lib/' + specifier.slice(6) + '.ts', import.meta.url).pathname);
    return next(target.href, context);
  }
  return next(specifier, context);
}
