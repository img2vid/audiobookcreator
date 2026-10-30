'use client';
export default function StudioError({ error, reset }: { error: Error; reset: () => void }) {
  return <main className="mx-auto max-w-xl space-y-4 p-8">
    <h1 className="text-xl font-semibold">This studio could not open</h1>
    <p role="alert" className="break-words">{error.message || 'An unexpected error occurred.'}</p>
    <p>Saved Book Conversion Desk projects and completed audio chunks remain in this browser. You can reopen them after recovering.</p>
    <button className="rounded border px-4 py-2" onClick={reset}>Try again</button>
  </main>;
}
