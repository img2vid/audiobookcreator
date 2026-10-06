/** Yield control back to the event loop — keeps UI responsive during heavy work. */
export function yieldToUI(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Yield with a minimum delay (useful for progress animation smoothness). */
export function yieldMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run an async mapper over items in chunks, yielding between chunks, with progress. */
export async function chunkedMap<T, R>(
  items: T[],
  chunkSize: number,
  fn: (item: T, index: number) => Promise<R> | R,
  onProgress?: (done: number, total: number) => void,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    const slice = items.slice(i, i + chunkSize);
    for (let j = 0; j < slice.length; j++) {
      out.push(await fn(slice[j], i + j));
    }
    onProgress?.(Math.min(i + chunkSize, items.length), items.length);
    await yieldToUI();
  }
  return out;
}

/** Run fn while measuring wall time. */
export async function timed<T>(fn: () => Promise<T> | T): Promise<{ result: T; ms: number }> {
  const t0 = performance.now();
  const result = await fn();
  return { result, ms: performance.now() - t0 };
}

export function uid(prefix = 'id'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}
