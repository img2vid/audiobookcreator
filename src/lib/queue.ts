'use client';

import { useAppStore } from '@/lib/stores/app-store';
import type { QueueJob, QueueJobType } from '@/lib/types';
import { uid, yieldMs } from '@/lib/utils/async';

export interface JobApi {
  /** Report progress 0..1 with optional status message. */
  setProgress: (p: number, msg?: string) => void;
  /** True if user requested cancellation — check frequently and bail out. */
  shouldCancel: () => boolean;
  /** Await while paused — call periodically in long loops. */
  waitWhilePaused: () => Promise<void>;
  /** Emit a log line visible in the activity view. */
  log: (msg: string) => void;
}

type TaskFn = (api: JobApi) => Promise<Record<string, unknown> | void>;

interface QueueController {
  paused: boolean;
  cancelled: boolean;
  logLines: string[];
}

const controllers = new Map<string, QueueController>();

// ---------- reactive listeners ----------
type Listener = () => void;
const listeners = new Set<Listener>();
export function subscribeQueue(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
function emit() {
  listeners.forEach((l) => l());
}

// ---------- concurrency ----------
let activeCount = 0;
let running = false;

function maxConcurrency(): number {
  try {
    return Math.max(1, useAppStore.getState().tuned.queueConcurrency);
  } catch {
    return 2;
  }
}

function jobsSnapshot(): QueueJob[] {
  return useAppStore.getState().jobs;
}

function patchJob(id: string, patch: Partial<QueueJob>) {
  const s = useAppStore.getState();
  const job = s.jobs.find((j) => j.id === id);
  if (!job) return;
  s.syncJob({ ...job, ...patch });
}

function pump() {
  if (running) return;
  running = true;
  void (async () => {
    try {
      for (;;) {
        const concurrency = maxConcurrency();
        // The store keeps the newest job first, so the OLDEST queued job is the
        // last entry with status 'queued' — that preserves true FIFO ordering.
        // User-boosted (priority) jobs always jump ahead of the normal queue.
        //
        // Manual reordering (drag & drop / Alt+Arrow in the Queue view, via
        // reorderQueuedJobs) rewrites the relative order of the QUEUED entries
        // inside the array. Because the natural pick below is the array-tail
        // queued job, moving a queued job toward the array tail makes it the
        // next natural run — which is exactly the intent the view translates
        // for us (see toArrayPlaceBefore in queue-view.tsx). Boosted jobs are
        // unaffected by the tail choice: find(priority) still wins.
        const queued = jobsSnapshot().filter((j) => j.status === 'queued');
        const next = queued.find((j) => j.priority) ?? queued[queued.length - 1];
        if (!next) break;
        if (activeCount >= concurrency) {
          await yieldMs(250);
          continue;
        }
        activeCount++;
        void runJob(next.id).finally(() => {
          activeCount--;
        });
        await yieldMs(30);
      }
    } finally {
      running = false;
    }
  })();
}

async function runJob(id: string) {
  const s = useAppStore.getState();
  const job = s.jobs.find((j) => j.id === id);
  if (!job) return;
  const ctrl: QueueController = controllers.get(id) ?? {
    paused: false,
    cancelled: false,
    logLines: [],
  };
  controllers.set(id, ctrl);

  patchJob(id, { status: 'running', startedAt: Date.now(), progress: 0, message: 'Starting…' });
  emit();

  const api: JobApi = {
    setProgress: (p, msg) => {
      patchJob(id, { progress: Math.min(1, Math.max(0, p)), message: msg });
      emit();
    },
    shouldCancel: () => ctrl.cancelled,
    waitWhilePaused: async () => {
      // Wait in small increments so cancel can still break through.
      while (ctrl.paused && !ctrl.cancelled) {
        await yieldMs(200);
      }
    },
    log: (msg) => {
      ctrl.logLines.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
      if (ctrl.logLines.length > 200) ctrl.logLines.shift();
      patchJob(id, { message: msg });
      emit();
    },
  };

  const task = taskMap.get(id);
  if (!task) {
    patchJob(id, { status: 'error', finishedAt: Date.now(), error: 'Task not found' });
    emit();
    return;
  }

  try {
    const result = (await task(api)) ?? {};
    if (ctrl.cancelled) {
      patchJob(id, { status: 'cancelled', finishedAt: Date.now(), message: 'Cancelled' });
      useAppStore.getState().logActivity('job-cancelled', job.label);
    } else {
      patchJob(id, {
        status: 'done',
        progress: 1,
        finishedAt: Date.now(),
        result,
        message: 'Completed',
      });
      useAppStore.getState().logActivity('job-done', job.label);
    }
  } catch (err) {
    patchJob(id, {
      status: 'error',
      finishedAt: Date.now(),
      error: err instanceof Error ? err.message : String(err),
      message: 'Failed',
    });
    useAppStore.getState().logActivity('job-error', job.label);
  } finally {
    emit();
    pump();
  }
}

// Tasks live in a parallel map so QueueJob stays serializable.
const taskMap = new Map<string, TaskFn>();

export function enqueueJob(
  input: { type: QueueJobType; label: string },
  task: TaskFn,
): string {
  const id = uid('job');
  const job: QueueJob = {
    id,
    type: input.type,
    label: input.label,
    status: 'queued',
    progress: 0,
    createdAt: Date.now(),
  };
  taskMap.set(id, task);
  controllers.set(id, { paused: false, cancelled: false, logLines: [] });
  useAppStore.getState().syncJob(job);
  useAppStore.getState().logActivity('job-queued', input.label);
  emit();
  // Defer to next tick so React can render the queued row before heavy work.
  setTimeout(() => pump(), 50);
  return id;
}

export function pauseJob(id: string) {
  const c = controllers.get(id);
  if (c) c.paused = true;
  patchJob(id, { status: 'paused' });
  emit();
}

export function resumeJob(id: string) {
  const c = controllers.get(id);
  if (c) c.paused = false;
  patchJob(id, { status: 'running' });
  emit();
}

export function cancelJob(id: string) {
  const c = controllers.get(id);
  if (c) c.cancelled = true;
  const job = useAppStore.getState().jobs.find((j) => j.id === id);
  if (job && (job.status === 'queued' || job.status === 'paused')) {
    patchJob(id, { status: 'cancelled', finishedAt: Date.now() });
  }
  emit();
  setTimeout(() => pump(), 100);
}

/** Toggle a queued job's priority — boosted jobs run before all normal queued jobs. */
export function boostJob(id: string, on: boolean) {
  patchJob(id, { priority: on });
  emit();
  if (on) setTimeout(() => pump(), 60);
}

/**
 * Run a queued job immediately — mirrors boostJob(id, true): flag it as
 * priority and pump the queue on the next tick. pump() always picks a boosted
 * queued job first, so this jumps the row ahead of the whole queued section.
 */
export function runQueuedNow(id: string) {
  const job = useAppStore.getState().jobs.find((j) => j.id === id);
  if (!job || job.status !== 'queued') return;
  patchJob(id, { priority: true });
  emit();
  setTimeout(() => pump(), 60);
}

export function dismissJob(id: string) {
  taskMap.delete(id);
  controllers.delete(id);
  useAppStore.getState().removeJob(id);
  emit();
}

export function getJobLogs(id: string): string[] {
  return controllers.get(id)?.logLines ?? [];
}

/** Re-pump after app load (persisted store may restore old rows). */
export function initQueue() {
  const s = useAppStore.getState();
  s.jobs
    .filter((j) => j.status === 'running' || j.status === 'queued')
    .forEach((j) => {
      if (j.status === 'running') patchJob(j.id, { status: 'error', error: 'Interrupted by reload' });
    });
}
