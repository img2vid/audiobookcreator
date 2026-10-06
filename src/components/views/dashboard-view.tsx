'use client';

import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useAppStore } from '@/lib/stores/app-store';
import { useMounted } from '@/hooks/use-mounted';
import { OnboardingTour, replayTour } from '@/components/widgets/onboarding-tour';
import type { ActivityEvent, ActivityKind, QueueJob } from '@/lib/types';
import { FEATURES } from '@/lib/data/features';
import { AUDIO_FORMATS } from '@/lib/engines/encode';
import { getSupportedExtensionCount } from '@/lib/engines/ingest';
import { VOICE_PROFILES } from '@/lib/engines/formant';
import { TTS_MODELS } from '@/lib/data/tts-models';
import { isSpeechSynthesisAvailable } from '@/lib/engines/speech';
import { getSelectedCpu } from '@/lib/engines/autotune';
import { aiAsk } from '@/lib/engines/ai-services';
import { StatCard } from '@/components/widgets/stat-card';
import { SectionPanel } from '@/components/widgets/section-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { formatDuration, timeAgo } from '@/lib/utils/format';
import {
  Activity, AudioLines, BookOpen, Braces, CheckCircle2, ChevronRight, Clock, Cpu, Database,
  FileStack, Film, Gauge, HardDrive, Library, Lightbulb, Loader2, Lock, MessagesSquare, Mic2,
  ScanText, Sparkles, Sun, Sunrise, Sunset, Timer, TriangleAlert, XCircle, Zap,
} from 'lucide-react';

const QUICK_ACTIONS = [
  { view: 'tts' as const, label: 'TTS Studio', desc: 'Synthesize text locally', icon: AudioLines, tone: 'bg-violet-500/10 text-violet-600' },
  { view: 'dialogue' as const, label: 'Dialogue Studio', desc: 'Multi-speaker scripts', icon: MessagesSquare, tone: 'bg-fuchsia-500/10 text-fuchsia-600' },
  { view: 'files' as const, label: 'File Studio', desc: 'Any file → speech', icon: FileStack, tone: 'bg-emerald-500/10 text-emerald-600' },
  { view: 'audiobook' as const, label: 'Audiobook', desc: 'Chapters & dictionary', icon: BookOpen, tone: 'bg-amber-500/10 text-amber-600' },
  { view: 'video' as const, label: 'Video Editor', desc: 'Timeline & export', icon: Film, tone: 'bg-rose-500/10 text-rose-600' },
  { view: 'ocr' as const, label: 'OCR Lab', desc: 'Images & video OCR', icon: ScanText, tone: 'bg-teal-500/10 text-teal-600' },
  { view: 'voices' as const, label: 'Voice Library', desc: 'Models & system voices', icon: Library, tone: 'bg-zinc-500/10 text-zinc-600' },
];

const STUDIO_TIPS = [
  'Press ⌘K to open the command palette from anywhere.',
  'Brush a volume envelope directly on the TTS waveform.',
  'G then T jumps to TTS Studio — G plus a letter reaches every view.',
  'Paste SRT into the Video Editor to burn subtitles into exports.',
  'OCR a screenshot, then send the text straight to TTS Studio.',
  'Long renders run as background jobs — keep working while they finish.',
  'Add a lexicon rule to pin tricky pronunciations, like “Kubernetes”.',
  'Drop chapter breaks into Audiobook for player-visible WAV markers.',
  'Pick your favorite export format once in Settings — every studio follows.',
  'Press ? any time to see the full keyboard shortcut sheet.',
];

const WEEKDAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

/** Kinds rendered as emerald "productive" bars; job-error → rose, job-cancelled → amber. job-queued counts as neutral-positive. */
const SUCCESS_KINDS: ReadonlySet<ActivityKind> = new Set<ActivityKind>([
  'job-done', 'asset-added', 'project-saved', 'export', 'transcript', 'voice-profile', 'job-queued',
]);

interface DayBucket {
  key: string;
  date: Date;
  success: number;
  error: number;
  cancelled: number;
  total: number;
}

/**
 * Bucket activity events into the last `days` LOCAL days (index 0 = oldest,
 * last = today). DST-safe: buckets are keyed by the local date string, so a
 * 23/25-hour day never shifts events into the wrong column. Events older than
 * the window are ignored. Pure + deterministic apart from `new Date()`.
 */
function buildActivityBuckets(events: ActivityEvent[], days: number): DayBucket[] {
  const buckets: DayBucket[] = [];
  const byKey = new Map<string, DayBucket>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const key = d.toDateString();
    const bucket: DayBucket = { key, date: d, success: 0, error: 0, cancelled: 0, total: 0 };
    buckets.push(bucket);
    byKey.set(key, bucket);
  }
  for (const e of events) {
    const b = byKey.get(new Date(e.at).toDateString());
    if (!b) continue;
    if (e.kind === 'job-error') b.error += 1;
    else if (e.kind === 'job-cancelled') b.cancelled += 1;
    else if (SUCCESS_KINDS.has(e.kind)) b.success += 1;
    b.total += 1;
  }
  return buckets;
}

/** Local-midnight timestamp `daysAgo` days back (0 = today). */
function startOfDayDaysAgo(daysAgo: number): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d.getTime();
}

/** Wall-clock render time for jobs that actually started and finished. */
function jobDuration(job: QueueJob): string | null {
  if (typeof job.finishedAt !== 'number' || typeof job.startedAt !== 'number') return null;
  const sec = (job.finishedAt - job.startedAt) / 1000;
  return sec > 0 ? formatDuration(sec) : null;
}

export function DashboardView() {
  const mounted = useMounted();
  const setView = useAppStore((s) => s.setView);
  const tuned = useAppStore((s) => s.tuned);
  const pcProfile = useAppStore((s) => s.pcProfile);
  const engine = useAppStore((s) => s.engine);
  const jobs = useAppStore((s) => s.jobs);
  const assets = useAppStore((s) => s.assets);
  const settings = useAppStore((s) => s.settings);
  const activityEvents = useAppStore((s) => s.activityEvents);

  // time-based greeting (client-only to avoid hydration mismatch)
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    const tick = () => setNow(new Date());
    const initial = setTimeout(tick, 0);
    const t = setInterval(tick, 30_000);
    return () => { clearTimeout(initial); clearInterval(t); };
  }, []);
  const greeting = useMemo(() => {
    const h = now?.getHours() ?? 10;
    if (h < 5) return { text: 'Working late', Icon: Sunset };
    if (h < 12) return { text: 'Good morning', Icon: Sunrise };
    if (h < 18) return { text: 'Good afternoon', Icon: Sun };
    return { text: 'Good evening', Icon: Sunset };
  }, [now]);

  useEffect(() => {
    if (!tuned.notes.length || tuned.notes[0].includes('Placeholder')) {
      useAppStore.getState().retune();
    }
  }, [tuned]);

  // rotating studio tips (8 s cycle; instant swap when motion is reduced)
  const [tipIndex, setTipIndex] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTipIndex((i) => (i + 1) % STUDIO_TIPS.length), 8000);
    return () => clearInterval(t);
  }, []);
  const prefersReducedMotion = useReducedMotion();
  const reducedMotion = Boolean(prefersReducedMotion) || settings.reducedMotion;

  const cpu = useMemo(() => getSelectedCpu(pcProfile), [pcProfile]);
  const sessionDone = jobs.filter((j) => j.status === 'done').length;
  const running = jobs.filter((j) => j.status === 'running' || j.status === 'queued').length;
  const recentJobs = jobs.slice(0, 5);
  const recentAssets = assets.slice(0, 5);

  // Weekly activity chart — pre-mount the persisted log is not reliably
  // hydrated, so render the deterministic empty state first (keeps the server
  // HTML and the first client render identical, same pattern as the engine
  // cards above).
  const [chartDays, setChartDays] = useState<7 | 14>(7);
  const activityTotal = mounted ? activityEvents.length : 0;
  const weekCount = mounted ? activityEvents.filter((e) => e.at >= startOfDayDaysAgo(6)).length : 0;
  const buckets = mounted ? buildActivityBuckets(activityEvents, chartDays) : [];
  // Y auto-scale: the tallest day defines the top gridline, ceil-rounded so
  // fractional ticks can never appear (counts are integers, so this is the max).
  const yMax = Math.max(1, ...buckets.map((b) => b.total));

  return (
    <div className="space-y-4">
      {/* greeting hero */}
      <div className="relative overflow-hidden rounded-xl border bg-gradient-to-br from-violet-500/[0.07] via-transparent to-emerald-500/[0.07] p-5 sm:p-6">
        <AudioLines className="pointer-events-none absolute -right-4 -top-6 h-36 w-36 rotate-12 text-violet-500/[0.07]" aria-hidden />
        <div className="relative flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <greeting.Icon className="h-3.5 w-3.5 text-amber-500" />
              {greeting.text}
            </div>
            <h2 className="mt-1 text-xl font-semibold tracking-tight sm:text-2xl">
              Your voice studio is ready — <span className="text-violet-600">100% local</span>.
            </h2>
            <p className="mt-1 max-w-xl text-sm text-muted-foreground">
              {now ? now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) : '—'} ·
              Synthesize, convert, OCR, narrate and edit video without a single upload.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => setView('tts')}>
                <AudioLines className="mr-1.5 h-3.5 w-3.5" />Open TTS Studio
              </Button>
              <Button size="sm" variant="outline" onClick={() => setView('files')}>Convert a file</Button>
              <div className="ml-1 hidden items-center gap-1.5 sm:flex">
                <Badge variant="outline" className="tabular-nums border-emerald-500/30 bg-emerald-500/10 text-emerald-600">
                  <CheckCircle2 className="mr-1 h-3 w-3" />{sessionDone} done
                </Badge>
                {running > 0 && (
                  <Badge variant="outline" className="tabular-nums border-violet-500/30 bg-violet-500/10 text-violet-600">
                    <Timer className="mr-1 h-3 w-3 animate-pulse" />{running} running
                  </Badge>
                )}
                <Badge variant="outline" className="tabular-nums">{assets.length} assets</Badge>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* stat row */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard title="System voices detected" value={engine.systemVoices} sub={!mounted ? 'detecting…' : isSpeechSynthesisAvailable() ? 'speech synthesis ready' : 'using fallback engine'} icon={Mic2} tone="emerald" />
        <StatCard title="Export formats" value={AUDIO_FORMATS.length} sub="genuinely encoded in-browser" icon={AudioLines} tone="violet" />
        <StatCard title="Recognized extensions" value={`${getSupportedExtensionCount()}+`} sub="intelligent local parsing" icon={FileStack} tone="amber" />
        <StatCard title="Features in suite" value={`${FEATURES.length}+`} sub="registry & counting" icon={Braces} tone="default" />
      </div>

      {/* AI Assistant */}
      <SectionPanel title="Ask Aura" description="Ask the local AI assistant about your projects, features, or creative decisions.">
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Ask anything about your audio project..."
            className="flex-1 rounded-md border px-3 py-2 text-xs"
            onKeyDown={async (e) => {
              if (e.key === 'Enter') {
                const q = (e.target as HTMLInputElement).value;
                if (!q.trim()) return;
                const ans = await aiAsk(q);
                if (ans.ok) {
                  alert(`Aura: ${ans.value}`);
                } else {
                  alert(`Aura: ${ans.error ?? 'I am not available right now.'}`);
                }
                (e.target as HTMLInputElement).value = '';
              }
            }}
          />
          <Button size="sm" variant="outline" onClick={async () => {
            const input = document.querySelector('input[placeholder="Ask anything about your audio project..."]') as HTMLInputElement;
            const q = input?.value;
            if (!q?.trim()) return;
            const ans = await aiAsk(q);
            if (ans.ok) {
              alert(`Aura: ${ans.value}`);
            } else {
              alert(`Aura: ${ans.error ?? 'I am not available right now.'}`);
            }
            if (input) input.value = '';
          }}>
            <Sparkles className="mr-1.5 h-3.5 w-3.5" />Ask
          </Button>
        </div>
      </SectionPanel>

      {/* weekly activity — full-width row under the stat cards */}
      <SectionPanel
        title="Weekly activity"
        description="Jobs, assets and exports per local day — logged on this device, newest 500 kept."
        actions={
          <div role="group" aria-label="Activity chart range" className="flex items-center rounded-md border p-0.5">
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={chartDays === 7}
              onClick={() => setChartDays(7)}
              className={cn(
                'h-6 px-2 text-[11px] font-medium',
                chartDays === 7 ? 'bg-primary text-primary-foreground hover:bg-primary/90' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              7d
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-pressed={chartDays === 14}
              onClick={() => setChartDays(14)}
              className={cn(
                'h-6 px-2 text-[11px] font-medium',
                chartDays === 14 ? 'bg-primary text-primary-foreground hover:bg-primary/90' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              14d
            </Button>
          </div>
        }
      >
        {activityTotal === 0 ? (
          <div className="flex items-center gap-2 rounded-lg border border-dashed p-5 text-xs text-muted-foreground">
            <Activity className="h-3.5 w-3.5 shrink-0" aria-hidden />
            Activity will appear here as jobs run.
          </div>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs text-muted-foreground">
                <span className="font-semibold tabular-nums text-foreground">{activityTotal}</span> event{activityTotal === 1 ? '' : 's'} logged ·{' '}
                <span className="font-semibold tabular-nums text-foreground">{weekCount}</span> this week
              </div>
              <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-[2px] bg-emerald-500" aria-hidden />done · added · saved</span>
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-[2px] bg-rose-500" aria-hidden />errors</span>
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-[2px] bg-amber-500" aria-hidden />cancelled</span>
              </div>
            </div>
            <div data-activity-chart role="img" aria-label={`Activity chart, ${chartDays} days, ${activityTotal} events`}>
              <div className="flex gap-2">
                <div className="flex h-28 w-4 shrink-0 flex-col justify-between text-right text-[9px] leading-none tabular-nums text-muted-foreground" aria-hidden>
                  <span>{yMax}</span>
                  <span>0</span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex h-28 items-stretch gap-1.5 border-b border-dashed border-zinc-500/30">
                    {buckets.map((b, i) => {
                      const pct = (n: number) => `${(n / yMax) * 100}%`;
                      const label = b.date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
                      const topKind = b.cancelled > 0 ? 'cancelled' : b.error > 0 ? 'error' : 'success';
                      return (
                        <div
                          key={b.key}
                          className="group relative h-full flex-1"
                          title={`${label} — ${b.total} event${b.total === 1 ? '' : 's'}`}
                        >
                          {b.total === 0 && (
                            <div className="absolute inset-x-0 bottom-0 h-0.5 rounded-sm bg-zinc-400/40 dark:bg-zinc-600/40" />
                          )}
                          {b.success > 0 && (
                            <div
                              className={cn('absolute inset-x-0 bottom-0 bg-emerald-500/80 transition-colors group-hover:bg-emerald-500', topKind === 'success' && 'rounded-t-[2px]')}
                              style={{ height: pct(b.success) }}
                            />
                          )}
                          {b.error > 0 && (
                            <div
                              className={cn('absolute inset-x-0 bg-rose-500/80 transition-colors group-hover:bg-rose-500', topKind === 'error' && 'rounded-t-[2px]')}
                              style={{ height: pct(b.error), bottom: pct(b.success) }}
                            />
                          )}
                          {b.cancelled > 0 && (
                            <div
                              className={cn('absolute inset-x-0 bg-amber-500/80 transition-colors group-hover:bg-amber-500', topKind === 'cancelled' && 'rounded-t-[2px]')}
                              style={{ height: pct(b.cancelled), bottom: pct(b.success + b.error) }}
                            />
                          )}
                          {/* custom hover tooltip */}
                          <div
                            className={cn(
                              'pointer-events-none absolute bottom-full z-20 mb-1 hidden whitespace-nowrap rounded-md border bg-popover px-2 py-1 text-[10px] leading-snug text-popover-foreground shadow-md group-hover:block',
                              i < 2 ? 'left-0' : i >= buckets.length - 2 ? 'right-0' : 'left-1/2 -translate-x-1/2',
                            )}
                          >
                            <span className="font-medium">{label}</span> · {b.total} event{b.total === 1 ? '' : 's'}
                            {b.total > 0 && (
                              <span className="text-muted-foreground">
                                {' '}({b.success > 0 ? `${b.success} ok` : ''}
                                {b.error > 0 ? `${b.success > 0 ? ', ' : ''}${b.error} err` : ''}
                                {b.cancelled > 0 ? `${b.success + b.error > 0 ? ', ' : ''}${b.cancelled} cancel` : ''})
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="mt-1 flex gap-1.5" aria-hidden>
                    {buckets.map((b, i) => (
                      <span
                        key={b.key}
                        className={cn(
                          'flex-1 text-center text-[9px] leading-none tabular-nums',
                          i === buckets.length - 1 ? 'font-semibold text-foreground' : 'text-muted-foreground',
                        )}
                      >
                        {WEEKDAY_LETTERS[b.date.getDay()]}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </SectionPanel>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          {/* quick actions */}
          <SectionPanel
            title="Quick actions"
            description="Jump straight into a studio."
            actions={
              <Button size="sm" variant="ghost" onClick={replayTour} aria-label="Replay the intro tour">
                <Sparkles className="mr-1.5 h-3.5 w-3.5" />Replay intro tour
              </Button>
            }
          >
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
              {QUICK_ACTIONS.map((a) => (
                <button
                  key={a.view}
                  onClick={() => setView(a.view)}
                  className="group flex items-center gap-3 rounded-lg border p-3 text-left transition-all hover:border-primary/40 hover:bg-muted/40"
                >
                  <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-transform group-hover:scale-105', a.tone)}>
                    <a.icon className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{a.label}</div>
                    <div className="truncate text-[11px] text-muted-foreground">{a.desc}</div>
                  </div>
                </button>
              ))}
            </div>
          </SectionPanel>

          {/* studio tip (rotating) */}
          <SectionPanel
            title="Studio tip"
            description="A rotating pointer for faster work."
            actions={
              <Button size="sm" variant="ghost" onClick={() => setTipIndex((i) => (i + 1) % STUDIO_TIPS.length)} aria-label="Next tip">
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            }
          >
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600">
                <Lightbulb className="h-4 w-4" aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <AnimatePresence mode="wait" initial={false}>
                  <motion.p
                    key={tipIndex}
                    initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
                    transition={{ duration: reducedMotion ? 0 : 0.25, ease: 'easeOut' }}
                    className="text-sm leading-snug"
                    aria-live="polite"
                  >
                    {STUDIO_TIPS[tipIndex]}
                  </motion.p>
                </AnimatePresence>
                <div className="mt-1 text-[11px] tabular-nums text-muted-foreground/70">
                  {tipIndex + 1} / {STUDIO_TIPS.length} · rotates every 8 s
                </div>
              </div>
            </div>
          </SectionPanel>

          {/* hardware summary */}
          <SectionPanel
            title="Hardware profile & auto-tune"
            description="From Settings → PC Profiler. Every setting below adapts automatically."
            actions={<Button size="sm" variant="outline" onClick={() => setView('settings')}>Configure</Button>}
          >
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="gap-1.5 border-violet-500/30 bg-violet-500/10 text-violet-600">
                  <Gauge className="h-3.5 w-3.5" />{tuned.tier.toUpperCase()} tier · {tuned.score}/100
                </Badge>
                {cpu ? (
                  <Badge variant="outline" className="gap-1.5"><Cpu className="h-3.5 w-3.5" />{cpu.name} ({cpu.cores}C/{cpu.threads}T)</Badge>
                ) : (
                  <Badge variant="outline" className="gap-1.5"><Cpu className="h-3.5 w-3.5" />Custom CPU {pcProfile.customCpu.clockGhz} GHz</Badge>
                )}
                <Badge variant="outline" className="gap-1.5">
                  {pcProfile.gpuEnabled ? <Zap className="h-3.5 w-3.5 text-amber-600" /> : <HardDrive className="h-3.5 w-3.5" />}
                  {pcProfile.gpuEnabled ? 'GPU on' : 'GPU off'} · {pcProfile.ramGB} GB RAM
                </Badge>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                {([
                  ['OCR power', tuned.ocrPower, ScanText],
                  ['TTS quality', tuned.synthesisQuality, Sparkles],
                  ['Chunk size', `${tuned.ttsChunkChars} ch`, Timer],
                  ['Concurrency', tuned.queueConcurrency, Activity],
                ] as const).map(([label, value, Icon]) => (
                  <div key={label} className="rounded-lg border bg-muted/30 p-2.5">
                    <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground"><Icon className="h-3 w-3" />{label}</div>
                    <div className="mt-0.5 font-semibold capitalize">{value}</div>
                  </div>
                ))}
              </div>
              <ScrollArea className="max-h-28">
                <ul className="space-y-1 text-xs text-muted-foreground">
                  {tuned.notes.map((n, i) => (
                    <li key={i} className="flex gap-1.5"><Zap className="mt-0.5 h-3 w-3 shrink-0 text-amber-500" />{n}</li>
                  ))}
                </ul>
              </ScrollArea>
            </div>
          </SectionPanel>

          {/* privacy */}
          <SectionPanel title="Private by design" description="Openmukti Audiobook Creator never uploads your content.">
            <div className="grid gap-2.5 text-xs leading-relaxed md:grid-cols-3">
              {[
                ['Files never leave', 'Every file is read with the browser File API and parsed in this tab. No byte is transmitted.', Lock],
                ['Synthesis is local', 'Both the AI voice runtime (OS voices) and the bundled formant engine render audio on this device.', Mic2],
                ['Everything offline-capable', 'TTS, OCR, DSP, 36 audio encoders and the video renderer all run with the network unplugged.', CheckCircle2],
              ].map(([title, desc, Icon]) => (
                <div key={title as string} className="rounded-lg border bg-emerald-500/5 p-3">
                  <div className="mb-1 flex items-center gap-1.5 font-medium text-foreground">
                    {typeof Icon === 'function' ? <Icon className="h-3.5 w-3.5 text-emerald-600" /> : null}
                    {title as string}
                  </div>
                  <span className="text-muted-foreground">{desc as string}</span>
                </div>
              ))}
            </div>
          </SectionPanel>
        </div>

        <div className="space-y-4">
          {/* engine status */}
          <SectionPanel title="Engine status" description="Live state of the TTS engines.">
            <div className="space-y-2.5 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">AI TTS</span>
                {settings.fallbackMode ? (
                  <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-600">forced fallback</Badge>
                ) : !mounted ? (
                  <Badge variant="outline">detecting…</Badge>
                ) : isSpeechSynthesisAvailable() ? (
                  <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600"><CheckCircle2 className="mr-1 h-3 w-3" />available</Badge>
                ) : (
                  <Badge variant="outline" className="border-rose-500/30 bg-rose-500/10 text-rose-600">unavailable</Badge>
                )}
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Fallback engine</span>
                <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600"><CheckCircle2 className="mr-1 h-3 w-3" />ready · {VOICE_PROFILES.length} profiles</Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Models</span>
                <span className="font-medium tabular-nums">{TTS_MODELS.filter((m) => m.bundled).length} bundled</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Auto-fallback</span>
                <span className="font-medium">{settings.autoFallback ? 'armed' : 'off'}</span>
              </div>
              {engine.lastError && (
                <div className="flex items-start gap-1.5 rounded-md border border-rose-500/30 bg-rose-500/10 p-2 text-xs text-rose-600">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />{engine.lastError}
                </div>
              )}
            </div>
          </SectionPanel>

          {/* recent jobs */}
          <SectionPanel
            title="Recent activity"
            description={running > 0 ? `${running} job${running > 1 ? 's' : ''} in flight · ${sessionDone} done this session` : `${sessionDone} job${sessionDone === 1 ? '' : 's'} completed this session`}
            actions={<Button size="sm" variant="ghost" onClick={() => setView('queue')}><Activity className="mr-1.5 h-3.5 w-3.5" />Open queue</Button>}
          >
            {recentJobs.length === 0 ? (
              <div className="rounded-lg border border-dashed p-5 text-center text-xs text-muted-foreground">
                No jobs yet. Render something in TTS Studio — progress, pause/resume and cancel all live in the queue.
              </div>
            ) : (
              <div className="space-y-1.5">
                {recentJobs.map((j) => {
                  const dur = j.status === 'done' ? jobDuration(j) : null;
                  const inFlight = j.status === 'running' || j.status === 'queued' || j.status === 'paused';
                  return (
                    <button
                      key={j.id}
                      type="button"
                      onClick={() => setView('queue')}
                      aria-label={`Open queue — ${j.label}`}
                      className="activity-row flex w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left text-xs transition-colors hover:bg-muted/40"
                    >
                      {j.status === 'done' ? (
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                      ) : j.status === 'error' || j.status === 'cancelled' ? (
                        <XCircle className="h-3.5 w-3.5 shrink-0 text-rose-600" />
                      ) : j.status === 'running' ? (
                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-violet-600" />
                      ) : (
                        <Clock className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                      )}
                      <span className="min-w-0 flex-1 truncate">{j.label}</span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {inFlight
                          ? `${(j.progress * 100).toFixed(0)}%`
                          : <>
                              {dur ? `${dur} · ` : ''}
                              {timeAgo(j.finishedAt ?? j.createdAt)}
                            </>}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </SectionPanel>

          {/* recent assets */}
          <SectionPanel
            title="Asset bin"
            description={`${assets.length} item${assets.length === 1 ? '' : 's'} · mirrored on-device, survives reloads`}
            actions={assets.length > 0 ? <Button size="sm" variant="ghost" onClick={() => setView('video')}>Use in video</Button> : undefined}
          >
            {recentAssets.length === 0 ? (
              <div className="rounded-lg border border-dashed p-5 text-center text-xs text-muted-foreground">
                Rendered audio, OCR results and exported videos land here. The video editor uses them as soundtrack and image sources.
              </div>
            ) : (
              <div className="space-y-1.5">
                {recentAssets.map((a) => (
                  <div key={a.id} className="flex items-center gap-2 rounded-md border px-2.5 py-2 text-xs">
                    <Database className="h-3.5 w-3.5 shrink-0 text-violet-600" />
                    <span className="min-w-0 flex-1 truncate">{a.name}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {a.kind}{a.durationSec ? ` · ${formatDuration(a.durationSec)}` : ''}
                    </span>
                    {a.blobUrl && (
                      <a href={a.blobUrl} download={a.name} className="shrink-0 text-violet-600 hover:underline">save</a>
                    )}
                  </div>
                ))}
              </div>
            )}
          </SectionPanel>
        </div>
      </div>

      <OnboardingTour />
    </div>
  );
}
