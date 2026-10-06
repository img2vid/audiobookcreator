'use client';

import { useSyncExternalStore } from 'react';

const emptySubscribe = () => () => {};

/** True after the component has hydrated on the client. Use to gate
 *  browser-only UI (speech synthesis, MediaRecorder, etc.) so the
 *  server-rendered markup matches the first client render. */
export function useMounted(): boolean {
  return useSyncExternalStore(emptySubscribe, () => true, () => false);
}
