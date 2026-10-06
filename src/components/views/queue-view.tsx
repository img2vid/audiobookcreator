'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/lib/stores/app-store';
import { boostJob, cancelJob, dismissJob, getJobLogs, pauseJob, resumeJob, runQueuedNow, subscribeQueue } from '@/lib/queue';
import type { QueueJob } from '@/lib/types';
import { REALTIME_PHASE_HINT, isRealtimeEncodePhase } from '@/lib/engines/encode';
import { SectionPanel } from '@/components/widgets/section-panel';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { formatBytes, timeAgo } from '@/lib/utils/format';
import {
  Activity, AudioLines, BookOpen, CheckCircle2, ChevronUp, Clock, Download, Film, FileStack,
  Gauge, GripVertical, Pause, Play, Rocket, ScanText, Search, Trash2, TriangleAlert, WandSparkles, X, XCircle,
} from 'lucide-react';

const TYPE_ICON: Record<QueueJob['type'], typeof Activity> = {
  autobook: WandSparkles,
  'tts-render': AudioLines,
  'file-convert': FileStack,
  ocr: ScanText,
  audiobook: BookOpen,
  'video-export': Film,
  encode: Gauge,
};

const STATUS_TONE: Record<QueueJob['status'], string> = {
  queued: 'border-zinc-500/30 bg-zinc-500/10 text-zinc-600',
  running: 'border-violet-500/30 bg-violet-500/10 text-violet-600',
  paused: 'border-amber-500/30 bg-amber-500/10 text-amber-600',
  done: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600',
  error: 'border-rose-500/30 bg-rose-500/10 text-rose-600',
  cancelled: 'border-zinc-500/30 bg-zinc-500/10 text-zinc-500',
};

/**
 * Job types whose labels carry an audio/video format — used with
 * isRealtimeEncodePhase(label) as the weak signal for the "real-time encode"
 * ETA hint next to the progress %. (file-convert included on purpose: its
 * labels look like `Speak "file.txt" → WebM Opus (compressed)`.)
 */
const REALTIME_HINT_TYPES = new Set<QueueJob['type']>(['encode', 'video-export', 'tts-render', 'file-convert']);

/** Wall-clock ms → "12.3s" / "1m 05s" / "1h 14m" (tabular-nums friendly). */
function formatWallClock(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(Math.round(s) % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

/**
 * Queued jobs in DISPLAY = RUN order: boosted rows first (in store-array
 * order — pump() picks `find(j => j.priority)`, i.e. the first boosted entry
 * of the newest-first array), then the normal queue OLDEST-FIRST (the store
 * array is newest-first, so its reverse is the true FIFO run order).
 * Non-queued jobs are ignored. The "next" badge sits on the FIRST row of this
 * list — exactly the job pump() will execute next.
 */
function queuedRunOrder(jobs: QueueJob[]): QueueJob[] {
  const queued = jobs.filter((j) => j.status === 'queued');
  return [...queued.filter((j) => j.priority), ...queued.filter((j) => !j.priority).reverse()];
}

/**
 * Translate a visual drop position into store-array semantics. The view shows
 * queued jobs in run order, but the store array is NEWEST-FIRST. For normal
 * (non-boosted) rows the display is the REVERSED array, so "place the drag
 * above the target" (runs before) means "insert AFTER the target in the
 * array". Boosted rows display in store-array order, so there the mapping is
 * direct. Mixed pairs use the normal-queue rule (the boosted row outranks the
 * target regardless; the recorded array order still reflects the move).
 */
function toArrayPlaceBefore(drag: QueueJob, target: QueueJob, placeBeforeDisplay: boolean): boolean {
  if (drag.priority && target.priority) return placeBeforeDisplay;
  return !placeBeforeDisplay;
}

// Reordering is applied through the store; a component ref holds the dragged
// row id for the HTML5 drag-and-drop session (survives the re-renders that the
// dragover indicator causes; dataTransfer 'text/plain' carries the same id as
// a fallback).

export function QueueView() {
  const jobs = useAppStore((s) => s.jobs);
  const isQueueActive = useAppStore((s) => s.view) === 'queue';
  const [, force] = useState(0);
  const [logJob, setLogJob] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  // drag & drop state: the row being dragged (opacity) + the hovered row edge
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; placeBefore: boolean } | null>(null);
  const dragIdRef = useRef<string | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const unsub = subscribeQueue(() => force((n) => n + 1));
    return () => { unsub(); };
  }, []);

  // "/" focuses the job filter from anywhere — unless the user is already typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
      filterRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Alt+ArrowUp / Alt+ArrowDown moves the FOCUSED queued row one slot among
  // the queued section (display = run order). Document-level, but ONLY while
  // the queue view is active — the shell keeps every view mounted
  // (display:none), so an ungated listener would also fire from every other
  // tab (same gating pattern as the Video Editor's ⌘Z listener). Typing
  // targets are skipped so text fields keep their arrow-key behaviour. The
  // move operates on the FULL queued run order (unfiltered) via
  // reorderQueuedJobs, which no-ops unless both rows are still queued.
  useEffect(() => {
    if (!isQueueActive) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (!e.altKey || e.metaKey || e.ctrlKey) return;
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
      const rowEl = target?.closest?.('[data-queued-row]');
      if (!(rowEl instanceof HTMLElement)) return;
      const dragId = rowEl.getAttribute('data-queued-row');
      if (!dragId) return;
      const order = queuedRunOrder(useAppStore.getState().jobs);
      const idx = order.findIndex((j) => j.id === dragId);
      if (idx === -1) return;
      const neighbor = order[idx + (e.key === 'ArrowUp' ? -1 : 1)];
      if (!neighbor) return; // already at the top/bottom of the queued section
      e.preventDefault();
      const placeBefore = toArrayPlaceBefore(order[idx], neighbor, e.key === 'ArrowUp');
      useAppStore.getState().reorderQueuedJobs(dragId, neighbor.id, placeBefore);
      // the keyed row element survives the reorder — refocus to be safe
      requestAnimationFrame(() => rowEl.focus());
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isQueueActive]);

  const q = filter.trim().toLowerCase();
  const filterActive = q.length > 0;
  const matches = (j: QueueJob) => !filterActive || j.label.toLowerCase().includes(q) || j.type.includes(q);

  // Unfiltered totals for the stat cards; panels below respect the filter.
  const activeAll = jobs.filter((j) => j.status === 'running' || j.status === 'queued' || j.status === 'paused');
  const finishedAll = jobs.filter((j) => ['done', 'error', 'cancelled'].includes(j.status));
  const active = activeAll.filter(matches);
  const finished = finishedAll.filter(matches);
  const paused = jobs.filter((j) => j.status === 'paused');
  const logs = logJob ? getJobLogs(logJob) : [];

  // Display order for the live queue: running/paused first (most recent start on top),
  // then queued jobs in TRUE scheduling order — priority boosts first, then oldest.
  // (No manual useMemo — React Compiler memoizes; manual memo was not preservable.)
  const runningOrPaused = active.filter((j) => j.status !== 'queued');
  const visibleQueuedOrder = queuedRunOrder(active);
  const liveOrdered = [...runningOrPaused, ...visibleQueuedOrder];

  const handleDragStart = (e: React.DragEvent, job: QueueJob) => {
    dragIdRef.current = job.id;
    e.dataTransfer.setData('text/plain', job.id);
    e.dataTransfer.effectAllowed = 'move';
    setDraggingId(job.id);
  };

  const handleDragOver = (e: React.DragEvent, job: QueueJob) => {
    if (!dragIdRef.current || dragIdRef.current === job.id) return;
    e.preventDefault(); // required to allow the drop
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const placeBefore = e.clientY < rect.top + rect.height / 2;
    setDropTarget((prev) =>
      prev?.id === job.id && prev.placeBefore === placeBefore ? prev : { id: job.id, placeBefore },
    );
  };

  const handleDragLeave = (e: React.DragEvent) => {
    // ignore leaf-flicker: only clear when the pointer truly left the row
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDropTarget(null);
  };

  const handleDrop = (e: React.DragEvent, target: QueueJob) => {
    e.preventDefault();
    const dragId = dragIdRef.current;
    const intent = dropTarget;
    dragIdRef.current = null;
    setDraggingId(null);
    setDropTarget(null);
    if (!dragId || dragId === target.id || !intent || intent.id !== target.id) return;
    const drag = useAppStore.getState().jobs.find((j) => j.id === dragId);
    if (!drag || drag.status !== 'queued' || target.status !== 'queued') return;
    useAppStore.getState().reorderQueuedJobs(dragId, target.id, toArrayPlaceBefore(drag, target, intent.placeBefore));
  };

  const handleDragEnd = () => {
    dragIdRef.current = null;
    setDraggingId(null);
    setDropTarget(null);
  };

  const nextQueuedId = visibleQueuedOrder[0]?.id;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {([
          ['Running', activeAll.length, 'violet'],
          ['Paused', paused.length, 'amber'],
          ['Completed', finishedAll.filter((j) => j.status === 'done').length, 'emerald'],
          ['Failed', finishedAll.filter((j) => j.status === 'error').length, 'rose'],
        ] as const).map(([label, n, tone]) => (
          <div key={label} className="rounded-lg border bg-card p-3.5">
            <div className="text-2xl font-semibold tabular-nums">{n}</div>
            <div className={cn('text-xs',
              tone === 'violet' && 'text-violet-600',
              tone === 'amber' && 'text-amber-600',
              tone === 'emerald' && 'text-emerald-600',
              tone === 'rose' && 'text-rose-600',
            )}>{label}</div>
          </div>
        ))}
      </div>

      <SectionPanel
        title={`Active & queued (${active.length})`}
        description="All heavy work runs here — chunked and yield-aware, so the UI stays responsive. Drag queued rows (or Alt+↑/↓) to reorder; rocket or boost a job to run it next."
        actions={
          <div className="flex items-center gap-1.5">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                ref={filterRef}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') { setFilter(''); e.currentTarget.blur(); }
                }}
                placeholder="Filter jobs…  /"
                aria-label="Filter jobs by label or type"
                className="queue-filter h-7 max-w-40 pl-6 text-xs"
              />
            </div>
            {filterActive ? (
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" aria-label="Clear job filter" onClick={() => setFilter('')}>
                <X className="mr-1 h-3 w-3" />Clear
              </Button>
            ) : (
              <kbd className="hidden rounded border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground sm:inline-block" title="Press / to filter jobs">/</kbd>
            )}
          </div>
        }
      >
        {active.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-10 text-center">
            <Activity className="h-7 w-7 text-muted-foreground/50" />
            <div className="text-sm font-medium">{filterActive && activeAll.length > 0 ? 'No active jobs match your filter' : 'Nothing running'}</div>
            <div className="max-w-sm text-xs text-muted-foreground">
              Renders, conversions, OCR scans and exports appear here with live progress and pause/resume/cancel controls.
            </div>
          </div>
        ) : (
          <div className="space-y-2" role="list" aria-label="Active and queued jobs">
            {liveOrdered.map((job) => {
              const Icon = TYPE_ICON[job.type] ?? Activity;
              const isQueued = job.status === 'queued';
              const running = job.status === 'running';
              const realtimeNow = running && isRealtimeEncodePhase(job.message);
              const realtimeHint = running && REALTIME_HINT_TYPES.has(job.type) && isRealtimeEncodePhase(job.label);
              const queuedPos = isQueued ? visibleQueuedOrder.findIndex((j) => j.id === job.id) + 1 : 0;
              return (
                <div
                  key={job.id}
                  role="listitem"
                  data-queued-row={isQueued ? job.id : undefined}
                  tabIndex={isQueued ? 0 : undefined}
                  aria-label={isQueued ? `Queued job ${job.label}, position ${queuedPos} of ${visibleQueuedOrder.length}` : undefined}
                  draggable={isQueued}
                  onDragStart={isQueued ? (e) => handleDragStart(e, job) : undefined}
                  onDragOver={isQueued ? (e) => handleDragOver(e, job) : undefined}
                  onDragLeave={isQueued ? handleDragLeave : undefined}
                  onDrop={isQueued ? (e) => handleDrop(e, job) : undefined}
                  onDragEnd={isQueued ? handleDragEnd : undefined}
                  className={cn(
                    'job-row-enter relative overflow-hidden rounded-lg border p-3 pl-3.5',
                    running && 'border-violet-500/40',
                    job.priority && isQueued && 'border-amber-500/50 bg-amber-500/5',
                    isQueued && 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 focus-visible:ring-offset-1',
                    draggingId === job.id && 'opacity-50',
                  )}
                >
                  {/* drag insertion indicator — emerald line at the hovered edge */}
                  {isQueued && dropTarget?.id === job.id && (
                    <span
                      aria-hidden
                      className={cn(
                        'pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-emerald-500 shadow-[0_0_0_1px_rgba(16,185,129,0.35)]',
                        dropTarget.placeBefore ? 'top-0' : 'bottom-0',
                      )}
                    />
                  )}
                  {/* status accent bar */}
                  <span
                    aria-hidden
                    className={cn(
                      'absolute inset-y-0 left-0 w-1',
                      running && 'bg-violet-500/70',
                      job.status === 'paused' && 'bg-amber-500/70',
                      isQueued && !job.priority && 'bg-zinc-400/50',
                      job.priority && isQueued && 'bg-amber-500',
                    )}
                  />
                  <div className="flex items-center gap-3">
                    {isQueued ? (
                      <GripVertical aria-hidden className="h-3.5 w-3.5 shrink-0 cursor-grab text-muted-foreground/50 active:cursor-grabbing" />
                    ) : (
                      <span aria-hidden className="w-3.5 shrink-0" />
                    )}
                    <div className={cn(
                      'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
                      running ? 'bg-violet-500/10 text-violet-600' : isQueued && job.priority ? 'bg-amber-500/10 text-amber-600' : 'bg-muted text-muted-foreground',
                    )}>
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium">{job.label}</span>
                        {isQueued && job.id === nextQueuedId && (
                          <span
                            data-next-job
                            className="shrink-0 rounded border border-emerald-500/40 bg-emerald-500/10 px-1 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400"
                          >
                            next
                          </span>
                        )}
                        {realtimeNow && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="realtime-chip inline-flex h-4 shrink-0 cursor-default items-center gap-1 rounded border border-violet-500/40 bg-violet-500/10 px-1 text-[9px] font-semibold text-violet-600 dark:text-violet-400">
                                <span className="relative flex h-1.5 w-1.5" aria-hidden>
                                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-violet-500 opacity-75" />
                                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-violet-500" />
                                </span>
                                REALTIME
                              </span>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="max-w-64 text-[11px] leading-snug">
                              {REALTIME_PHASE_HINT}
                            </TooltipContent>
                          </Tooltip>
                        )}
                      </div>
                      <div className="truncate text-xs text-muted-foreground">{job.message ?? job.status}</div>
                    </div>
                    <Badge variant="outline" className={cn('shrink-0', STATUS_TONE[job.status])}>{job.status}</Badge>
                    <div className="flex shrink-0 items-center gap-1">
                      {isQueued && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8 text-emerald-600 hover:bg-emerald-500/10 hover:text-emerald-700"
                              aria-label="Run this job next"
                              onClick={() => runQueuedNow(job.id)}
                            >
                              <Rocket className="h-3.5 w-3.5" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="text-[11px]">
                            Run this job next — jumps ahead of the whole queue
                          </TooltipContent>
                        </Tooltip>
                      )}
                      {isQueued && (
                        <Button
                          size="icon"
                          variant="ghost"
                          className={cn('h-8 w-8', job.priority && 'text-amber-600')}
                          aria-label={job.priority ? 'Remove priority — normal queue order' : 'Run this job next'}
                          title={job.priority ? 'Priority on — click to un-boost' : 'Run next'}
                          onClick={() => boostJob(job.id, !job.priority)}
                        >
                          <ChevronUp className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      {job.status === 'running' && (
                        <Button size="icon" variant="ghost" className="h-8 w-8" aria-label="Pause job" title="Pause" onClick={() => pauseJob(job.id)}>
                          <Pause className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      {job.status === 'paused' && (
                        <Button size="icon" variant="ghost" className="h-8 w-8" aria-label="Resume job" title="Resume" onClick={() => resumeJob(job.id)}>
                          <Play className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      <Button size="icon" variant="ghost" className="h-8 w-8" aria-label="Cancel job" title="Cancel" onClick={() => cancelJob(job.id)}>
                        <X className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="icon" variant="ghost" className="h-8 w-8" aria-label="Toggle log" title="Job log" onClick={() => setLogJob(logJob === job.id ? null : job.id)}>
                        <Activity className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                  <Progress value={job.progress * 100} className="mt-2.5 h-1.5" />
                  <div className="mt-1 flex justify-between text-[11px] tabular-nums text-muted-foreground">
                    <span className="flex items-center gap-2">
                      <span>{(job.progress * 100).toFixed(0)}%</span>
                      {realtimeHint && <span className="text-[10px]">real-time encode</span>}
                    </span>
                    {logJob === job.id && <span>log below</span>}
                  </div>
                  {logJob === job.id && (
                    <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-2.5 text-[11px] leading-relaxed">
                      {logs.length ? logs.join('\n') : 'Waiting for log output…'}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </SectionPanel>

      <SectionPanel
        title={`History (${finished.length})`}
        description="Completed, failed and cancelled jobs. Results (file name, size, duration) are kept here."
        actions={finished.length > 0 ? (
          <Button size="sm" variant="ghost" onClick={() => finished.forEach((j) => dismissJob(j.id))}>
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />Clear all
          </Button>
        ) : undefined}
      >
        {finished.length === 0 ? (
          <div className="rounded-lg border border-dashed py-8 text-center text-xs text-muted-foreground">
            {filterActive && finishedAll.length > 0 ? 'No history matches your filter.' : 'History is empty.'}
          </div>
        ) : (
          <ScrollArea className="max-h-96">
            <div className="space-y-1.5 pr-3">
              {finished.map((job) => {
                const Icon = TYPE_ICON[job.type] ?? Activity;
                return (
                  <Fragment key={job.id}>
                    <div className="flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm">
                      <Icon className={cn('h-4 w-4 shrink-0', job.status === 'done' ? 'text-emerald-600' : job.status === 'error' ? 'text-rose-600' : 'text-zinc-500')} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate">{job.label}</div>
                        {job.error && (
                          <div className="flex items-center gap-1 truncate text-xs text-rose-600">
                            <TriangleAlert className="h-3 w-3 shrink-0" />{job.error}
                          </div>
                        )}
                        {job.status === 'done' && job.result && (
                          <div className="text-xs text-muted-foreground">
                            {typeof job.result.bytes === 'number' && formatBytes(job.result.bytes as number)}
                            {typeof job.result.durationSec === 'number' && ` · ${(job.result.durationSec as number).toFixed(1)}s audio`}
                            {typeof job.result.fileName === 'string' && ` · ${job.result.fileName}`}
                          </div>
                        )}
                      </div>
                      {job.startedAt != null && job.finishedAt != null && (
                        <Badge
                          variant="outline"
                          className="shrink-0 gap-1 text-[10px] font-normal tabular-nums text-muted-foreground"
                          title="Wall-clock duration"
                        >
                          <Clock className="h-2.5 w-2.5" />{formatWallClock(job.finishedAt - job.startedAt)}
                        </Badge>
                      )}
                      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground" title={new Date(job.finishedAt ?? job.createdAt).toLocaleString()}>
                        {timeAgo(job.finishedAt ?? job.createdAt)}
                      </span>
                      <Badge variant="outline" className={cn('shrink-0', STATUS_TONE[job.status])}>
                        {job.status === 'done' ? <CheckCircle2 className="mr-1 h-3 w-3" /> : job.status === 'error' ? <XCircle className="mr-1 h-3 w-3" /> : null}
                        {job.status}
                      </Badge>
                      {job.status === 'done' && job.result?.bytes != null && (
                        <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" aria-label="Find in asset bin" title="Saved in asset bin" disabled>
                          <Download className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8 shrink-0"
                        aria-label="Toggle log"
                        title="Job log"
                        onClick={() => setLogJob(logJob === job.id ? null : job.id)}
                      >
                        <Activity className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" aria-label="Dismiss" title="Dismiss from history" onClick={() => dismissJob(job.id)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    {logJob === job.id && (
                      <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border bg-muted/30 p-2.5 text-[11px] leading-relaxed">
                        {getJobLogs(job.id).length ? getJobLogs(job.id).join('\n') : 'No log output was recorded.'}
                      </pre>
                    )}
                  </Fragment>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </SectionPanel>
    </div>
  );
}
