'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  Activity, AudioLines, ChevronLeft, ChevronRight, Cpu, Keyboard,
  Mic, ScanText, type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { useMounted } from '@/hooks/use-mounted';
import { useAppStore } from '@/lib/stores/app-store';
import { cn } from '@/lib/utils';

/** localStorage flag — set once the tour has been dismissed, so it only
 *  auto-opens on the very first dashboard visit per browser. */
export const TOUR_SEEN_KEY = 'auravoice-tour-done-v1';

/** Clear the seen flag and re-open the tour (Dashboard "Replay intro tour"). */
export function replayTour(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(TOUR_SEEN_KEY);
  } catch {
    // storage unavailable — still fire the event so an open tour restarts
  }
  window.dispatchEvent(new CustomEvent('auravoice:tour'));
}

type TourTone = 'emerald' | 'violet' | 'zinc';

interface TourStep {
  id: string;
  eyebrow: string;
  title: string;
  body: string;
  points: string[];
  icon: LucideIcon;
  tone: TourTone;
}

const TONE_CLASSES: Record<TourTone, string> = {
  emerald: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  violet: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
  zinc: 'bg-zinc-500/10 text-zinc-600 dark:bg-zinc-400/15 dark:text-zinc-300',
};

const STEPS: TourStep[] = [
  {
    id: 'welcome',
    eyebrow: 'Welcome',
    title: 'Your voice studio — 100% local',
    body: 'Openmukti Audiobook Creator runs entirely in this browser tab. No accounts, no uploads, no audio ever leaves this machine.',
    points: [
      'Files are read with the browser File API — nothing is transmitted',
      'Synthesis, OCR and encoding all run on-device',
      'Everything keeps working with the network unplugged',
    ],
    icon: Mic,
    tone: 'emerald',
  },
  {
    id: 'create',
    eyebrow: 'Create',
    title: 'Five studios for every script',
    body: 'The Create group covers the whole pipeline, from raw text to finished video.',
    points: [
      'TTS Studio — type or paste, render natural speech',
      'Dialogue Studio — multi-speaker scripts with narrator groups',
      'File Studio — turn any document into audio',
      'Audiobook — chapters, sleep timer, chapter markers',
      'Video Editor — timeline, soundtrack, burned subtitles',
    ],
    icon: AudioLines,
    tone: 'violet',
  },
  {
    id: 'intelligence',
    eyebrow: 'Intelligence',
    title: 'Understand audio, images and video',
    body: 'Pull text back out of media and manage every voice in one place.',
    points: [
      'OCR Lab — extract text from images and video frames',
      'Transcribe Studio — speech to text, then straight back into TTS',
      'Voice Library — system voices, formant profiles and models',
    ],
    icon: ScanText,
    tone: 'emerald',
  },
  {
    id: 'system',
    eyebrow: 'System',
    title: 'Tuned to your machine',
    body: 'Openmukti Audiobook Creator adapts itself — set your hardware once and every studio follows.',
    points: [
      'PC Profiler auto-tunes quality, chunking and concurrency',
      'Feature Explorer catalogs the full capability registry',
      'Settings adjust automatically — no manual fiddling required',
    ],
    icon: Cpu,
    tone: 'zinc',
  },
  {
    id: 'queue',
    eyebrow: 'Queue & assets',
    title: 'Background jobs and an asset bin',
    body: 'Long renders never block the UI, and every result is kept for reuse.',
    points: [
      'Jobs run in the background with pause, resume and cancel',
      'Finished audio, OCR text and video land in the Asset Bin',
      'Assets persist on-device and survive reloads',
    ],
    icon: Activity,
    tone: 'violet',
  },
  {
    id: 'ready',
    eyebrow: 'Ready',
    title: 'Fly through the studio',
    body: 'A few keystrokes are all it takes to move at full speed.',
    points: [
      '⌘K opens the command palette from anywhere',
      'G then T jumps to TTS Studio — G plus a letter reaches every view',
      '? shows every keyboard shortcut',
    ],
    icon: Keyboard,
    tone: 'emerald',
  },
];

export function OnboardingTour() {
  const mounted = useMounted();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const nextRef = useRef<HTMLButtonElement>(null);
  const prefersReducedMotion = useReducedMotion();
  const reducedMotionSetting = useAppStore((s) => s.settings.reducedMotion);
  const reduced = Boolean(prefersReducedMotion) || reducedMotionSetting;

  const markSeen = useCallback(() => {
    try {
      window.localStorage.setItem(TOUR_SEEN_KEY, '1');
    } catch {
      // storage unavailable (private mode) — tour just won't persist the flag
    }
  }, []);

  const closeTour = useCallback(() => {
    setOpen(false);
    markSeen();
  }, [markSeen]);

  // auto-open once per browser, shortly after the dashboard mounts
  useEffect(() => {
    if (!mounted) return;
    let seen = false;
    try {
      seen = window.localStorage.getItem(TOUR_SEEN_KEY) === '1';
    } catch {
      seen = false;
    }
    if (seen) return;
    const t = setTimeout(() => setOpen(true), 600);
    return () => clearTimeout(t);
  }, [mounted]);

  // "Replay intro tour" button support
  useEffect(() => {
    if (!mounted) return;
    const openTour = () => {
      setStep(0);
      setOpen(true);
    };
    window.addEventListener('auravoice:tour', openTour);
    return () => window.removeEventListener('auravoice:tour', openTour);
  }, [mounted]);

  // focus management: keep focus on the primary (Next) action
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => nextRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, [open, step]);

  const isLast = step === STEPS.length - 1;
  const goNext = useCallback(() => {
    if (isLast) closeTour();
    else setStep((s) => Math.min(s + 1, STEPS.length - 1));
  }, [isLast, closeTour]);

  const current = STEPS[step];
  const Icon = current.icon;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) closeTour(); }}>
      <DialogContent
        showCloseButton={false}
        aria-label="Openmukti Audiobook Creator intro tour"
        className="max-h-[90vh] overflow-y-auto rounded-xl sm:max-w-md"
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={current.id}
            initial={reduced ? { opacity: 0 } : { opacity: 0, x: 28 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, x: -28 }}
            transition={{ duration: reduced ? 0 : 0.22, ease: 'easeOut' }}
          >
            <div className={cn('mx-auto flex h-12 w-12 items-center justify-center rounded-xl', TONE_CLASSES[current.tone])}>
              <Icon className="h-6 w-6" aria-hidden />
            </div>
            <DialogHeader className="items-center space-y-1 text-center sm:text-center">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                {current.eyebrow}
              </div>
              <DialogTitle className="text-lg leading-snug">{current.title}</DialogTitle>
              <DialogDescription className="text-sm leading-relaxed">{current.body}</DialogDescription>
            </DialogHeader>
            <ul className="mx-auto mt-4 max-w-sm space-y-1.5">
              {current.points.map((p) => (
                <li key={p} className="flex items-start gap-2 text-xs leading-snug text-muted-foreground">
                  <span
                    className={cn(
                      'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
                      current.tone === 'emerald' && 'bg-emerald-500',
                      current.tone === 'violet' && 'bg-violet-500',
                      current.tone === 'zinc' && 'bg-zinc-500',
                    )}
                    aria-hidden
                  />
                  {p}
                </li>
              ))}
            </ul>
          </motion.div>
        </AnimatePresence>

        {/* progress: dots + "Step n of 6" */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5" aria-label="Tour progress">
            {STEPS.map((s, i) => (
              <button
                key={s.id}
                type="button"
                aria-label={`Step ${i + 1}: ${s.title}`}
                aria-current={i === step ? 'step' : undefined}
                onClick={() => setStep(i)}
                className={cn(
                  'tour-dot h-1.5 rounded-full transition-all',
                  i === step
                    ? 'w-5 bg-violet-600 dark:bg-violet-400'
                    : 'w-1.5 bg-muted-foreground/30 hover:bg-muted-foreground/50',
                )}
              />
            ))}
          </div>
          <span className="text-[11px] tabular-nums text-muted-foreground">
            Step {step + 1} of {STEPS.length}
          </span>
        </div>

        {/* controls */}
        <div className="flex items-center justify-between gap-2">
          <Button variant="ghost" size="sm" onClick={closeTour} className="text-muted-foreground">
            Skip tour
          </Button>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setStep((s) => Math.max(0, s - 1))}
              disabled={step === 0}
              aria-label="Previous step"
            >
              <ChevronLeft className="mr-0.5 h-3.5 w-3.5" />Back
            </Button>
            <Button ref={nextRef} size="sm" onClick={goNext} aria-label={isLast ? 'Finish tour' : 'Next step'}>
              {isLast ? 'Finish' : 'Next'}<ChevronRight className="ml-0.5 h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
