'use client';

import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '@/lib/stores/app-store';
import { initQueue, subscribeQueue } from '@/lib/queue';
import { isSpeechSynthesisAvailable, listSystemVoices } from '@/lib/engines/speech';
import type { ViewId } from '@/lib/types';
import { cn } from '@/lib/utils';
import {
  Activity, AudioLines, BookOpen, Braces, Cpu, Database, FileStack, Film,
  Keyboard, LayoutDashboard, Library, Menu, MessagesSquare, Mic, Monitor, Moon, ScanText,
  Settings, Speech, Sun, Waves, WandSparkles, Zap,
} from 'lucide-react';
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandSeparator } from '@/components/ui/command';
import { useTheme } from 'next-themes';
import { PerfMeter } from '@/components/widgets/perf-meter';
import { ShortcutsDialog } from '@/components/widgets/shortcuts-dialog';
import { useMounted } from '@/hooks/use-mounted';
import { Badge } from '@/components/ui/badge';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';

interface NavItem {
  id: ViewId;
  label: string;
  icon: typeof LayoutDashboard;
  group: string;
  hint: string;
}

const NAV: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, group: 'Workspace', hint: 'Overview & quick actions' },
  { id: 'assets', label: 'Asset Bin', icon: Database, group: 'Workspace', hint: 'Renders, exports & OCR results' },
  { id: 'queue', label: 'Activity & Queue', icon: Activity, group: 'Workspace', hint: 'Background jobs monitor' },
  { id: 'autobook', label: 'AutoBook', icon: WandSparkles, group: 'Create', hint: 'One-click any file → audiobook' },
  { id: 'tts', label: 'TTS Studio', icon: AudioLines, group: 'Create', hint: 'Local AI text-to-speech' },
  { id: 'dialogue', label: 'Dialogue Studio', icon: MessagesSquare, group: 'Create', hint: 'Multi-speaker scripts' },
  { id: 'files', label: 'File Studio', icon: FileStack, group: 'Create', hint: 'Any file → speech' },
  { id: 'audiobook', label: 'Audiobook Studio', icon: BookOpen, group: 'Create', hint: 'Chapters, dict, export' },
  { id: 'video', label: 'Video Editor', icon: Film, group: 'Create', hint: 'Timeline, canvas, export' },
  { id: 'ocr', label: 'OCR Lab', icon: ScanText, group: 'Intelligence', hint: 'Local image & video OCR' },
  { id: 'transcribe', label: 'Transcribe Studio', icon: Speech, group: 'Intelligence', hint: 'Mic → text → speech round-trip' },
  { id: 'voices', label: 'Voice Library', icon: Library, group: 'Intelligence', hint: 'Models & system voices' },
  { id: 'settings', label: 'PC Profiler & Settings', icon: Settings, group: 'System', hint: 'Hardware auto-tune' },
  { id: 'features', label: 'Feature Explorer', icon: Braces, group: 'System', hint: 'Every capability' },
];

const GROUPS = ['Workspace', 'Create', 'Intelligence', 'System'];

function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const assetCount = useAppStore((s) => s.assets.length);
  const activeJobs = useAppStore((s) => s.jobs.filter((j) => j.status === 'running' || j.status === 'queued').length);
  const badgeFor = (id: ViewId) =>
    id === 'assets' ? assetCount : id === 'queue' ? activeJobs : 0;
  return (
    <div className="flex h-full flex-col gap-1 p-3">
      <div className="mb-3 flex items-center gap-2.5 px-2 pt-1">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow">
          <Mic className="h-5 w-5" />
        </div>
        <div>
          <div className="text-sm font-semibold leading-tight">Openmukti Audiobook Creator</div>
          <div className="text-[11px] text-muted-foreground">100% local · no uploads</div>
        </div>
      </div>
      {GROUPS.map((g) => (
        <div key={g} className="mb-1">
          <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            {g}
          </div>
          {NAV.filter((n) => n.group === g).map((n) => (
            <button
              key={n.id}
              onClick={() => {
                setView(n.id);
                onNavigate?.();
              }}
              className={cn(
                'group relative flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
                view === n.id
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-foreground/80 hover:bg-accent hover:text-accent-foreground',
              )}
              title={n.hint}
            >
              {view === n.id && (
                <span className="absolute left-0 top-1/2 h-4 w-1 -translate-y-1/2 rounded-r-full bg-primary-foreground/90" aria-hidden />
              )}
              <n.icon className={cn('h-4 w-4 shrink-0', view === n.id ? 'text-primary-foreground' : 'text-muted-foreground group-hover:text-foreground')} />
              <span className="truncate">{n.label}</span>
              {badgeFor(n.id) > 0 && (
                <span
                  className={cn(
                    'ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-semibold leading-none tabular-nums',
                    view === n.id ? 'bg-primary-foreground/20 text-primary-foreground' : 'bg-muted text-muted-foreground',
                    n.id === 'queue' && view !== n.id && 'bg-violet-500/10 text-violet-600',
                  )}
                >
                  {badgeFor(n.id)}
                </span>
              )}
            </button>
          ))}
        </div>
      ))}
      <div className="mt-auto rounded-lg border bg-muted/40 p-2.5 text-[11px] leading-snug text-muted-foreground">
        <div className="mb-1 flex items-center gap-1.5 font-medium text-foreground">
          <Waves className="h-3.5 w-3.5" /> Private by design
        </div>
        All synthesis, OCR, conversion and rendering happens on this device. Files never leave the browser.
      </div>
    </div>
  );
}

function EngineChip() {
  const engine = useAppStore((s) => s.engine);
  const settings = useAppStore((s) => s.settings);
  const label =
    settings.fallbackMode
      ? 'Fallback TTS'
      : engine.ttsEngine === 'ai'
        ? 'AI TTS active'
        : engine.ttsEngine === 'fallback'
          ? 'Fallback TTS'
          : engine.ttsEngine === 'error'
            ? 'Engine error'
            : 'Engine idle';
  const tone =
    engine.ttsEngine === 'error'
      ? 'bg-rose-500/10 text-rose-600 border-rose-500/30'
      : engine.ttsEngine === 'ai' && !settings.fallbackMode
        ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30'
        : 'bg-amber-500/10 text-amber-600 border-amber-500/30';
  return (
    <Badge variant="outline" className={cn('gap-1.5 border font-medium', tone)}>
      <span className={cn('h-1.5 w-1.5 rounded-full',
        engine.ttsEngine === 'error' ? 'bg-rose-500' : engine.ttsEngine === 'ai' ? 'bg-emerald-500' : 'bg-amber-500',
      )} />
      {label}
    </Badge>
  );
}

const VIEW_TITLES: Record<ViewId, { title: string; sub: string }> = {
  dashboard: { title: 'Dashboard', sub: 'Everything local. Everything fast.' },
  assets: { title: 'Asset Bin', sub: 'Session renders, exports & extracted text' },
  queue: { title: 'Activity & Queue', sub: 'Background jobs with pause/resume/cancel' },
  autobook: { title: 'AutoBook', sub: 'One click: any book file → cast-narrated audiobook or videobook' },
  tts: { title: 'TTS Studio', sub: 'Local AI text-to-speech with fallback engine' },
  dialogue: { title: 'Dialogue Studio', sub: 'Multi-speaker scripts rendered locally' },
  files: { title: 'File Studio', sub: 'Thousands of formats → intelligent speech' },
  audiobook: { title: 'Audiobook Studio', sub: 'Chapters, pronunciation, packaging' },
  video: { title: 'Video Editor', sub: 'Canvas timeline with TTS soundtrack' },
  ocr: { title: 'OCR Lab', sub: 'Local optical character recognition' },
  transcribe: { title: 'Transcribe Studio', sub: 'Live mic transcription — speech → text → speech' },
  voices: { title: 'Voice Library', sub: 'Local models & system voices' },
  settings: { title: 'PC Profiler & Settings', sub: 'Branching hardware selection + auto-tune' },
  features: { title: 'Feature Explorer', sub: 'The complete capability registry' },
};

export function AppShell() {
  const view = useAppStore((s) => s.view);
  const jobs = useAppStore((s) => s.jobs);
  const tuned = useAppStore((s) => s.tuned);
  const retune = useAppStore((s) => s.retune);
  const setEngine = useAppStore((s) => s.setEngine);
  const setView = useAppStore((s) => s.setView);
  const mounted = useMounted();
  const { resolvedTheme, setTheme } = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [activeJobs, setActiveJobs] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const gPendingRef = useRef(false);
  const gTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Global keyboard navigation:
  //   Alt+1…9,0 → jump to view by sidebar order
  //   G then key (t/f/a/v/o/d/b/q/l/s/x) → go-to view
  useEffect(() => {
    const GOTO: Record<string, ViewId> = {
      d: 'dashboard', b: 'assets', q: 'queue', k: 'autobook', t: 'tts', w: 'dialogue', f: 'files',
      a: 'audiobook', v: 'video', o: 'ocr', r: 'transcribe', l: 'voices', s: 'settings', x: 'features',
    };
    const typing = () => {
      const el = document.activeElement;
      return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el as HTMLElement)?.isContentEditable;
    };
    const down = (e: KeyboardEvent) => {
      if (typing()) return;
      if (e.altKey && /^[0-9]$/.test(e.key)) {
        e.preventDefault();
        const idx = e.key === '0' ? 9 : Number(e.key) - 1;
        const target = NAV[idx];
        if (target) setView(target.id);
        return;
      }
      if ((e.key === 'g' || e.key === 'G') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        gPendingRef.current = true;
        if (gTimerRef.current) clearTimeout(gTimerRef.current);
        gTimerRef.current = setTimeout(() => { gPendingRef.current = false; }, 1600);
        return;
      }
      if (gPendingRef.current && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const target = GOTO[e.key.toLowerCase()];
        gPendingRef.current = false;
        if (gTimerRef.current) clearTimeout(gTimerRef.current);
        if (target) {
          e.preventDefault();
          setView(target);
        }
      }
    };
    document.addEventListener('keydown', down);
    return () => {
      document.removeEventListener('keydown', down);
      if (gTimerRef.current) clearTimeout(gTimerRef.current);
    };
  }, [setView]);

  // ⌘K / Ctrl+K command palette
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, []);

  useEffect(() => {
    initQueue();
    retune();
    void listSystemVoices().then((voices) => {
      setEngine({
        systemVoices: voices.length,
        ttsEngine: isSpeechSynthesisAvailable() ? 'ai' : 'fallback',
        fallbackReason: isSpeechSynthesisAvailable() ? undefined : 'Speech synthesis unavailable',
      });
    });
  }, []);

  useEffect(() => {
    const unsub = subscribeQueue(() => {
      setActiveJobs(useAppStore.getState().jobs.filter((j) => j.status === 'running' || j.status === 'queued').length);
    });
    return () => {
      unsub();
    };
  }, []);

  const meta = VIEW_TITLES[view];

  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 border-r bg-card/50 md:block">
        <SidebarNav />
      </aside>

      {/* Mobile sidebar — gated behind mount: Radix Sheet generates a useId for
          aria-controls that differs between SSR and the first client render,
          which tripped React's hydration attribute check. Rendering the Sheet
          only after mount (with a visually identical inert button pre-hydration)
          keeps server and first client markup identical. */}
      {mounted ? (
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetTrigger asChild>
            <Button variant="outline" size="icon" className="md:hidden absolute left-3 top-3 z-40">
              <Menu className="h-4 w-4" />
              <span className="sr-only">Open navigation</span>
            </Button>
          </SheetTrigger>
          <SheetContent side="left" className="w-64 p-0">
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <SidebarNav onNavigate={() => setMobileOpen(false)} />
          </SheetContent>
        </Sheet>
      ) : (
        <Button variant="outline" size="icon" className="md:hidden absolute left-3 top-3 z-40" aria-label="Open navigation" tabIndex={-1}>
          <Menu className="h-4 w-4" />
        </Button>
      )}

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-card/60 px-4 pl-14 backdrop-blur md:pl-4">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold leading-tight">{meta.title}</h1>
            <p className="truncate text-[11px] text-muted-foreground">{meta.sub}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="hidden h-8 w-40 justify-start gap-2 text-xs text-muted-foreground sm:flex"
              onClick={() => setPaletteOpen(true)}
              aria-label="Open command palette"
            >
              <Keyboard className="h-3.5 w-3.5" />
              Quick actions
              <kbd className="ml-auto rounded border bg-muted px-1 font-mono text-[10px]">⌘K</kbd>
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              aria-label="Toggle theme"
              onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
            >
              {mounted && resolvedTheme === 'dark'
                ? <Sun className="h-4 w-4 transition-transform hover:rotate-45" />
                : <Moon className="h-4 w-4 transition-transform hover:-rotate-12" />}
            </Button>
            {activeJobs > 0 && (
              <Badge variant="outline" className="gap-1.5 border-violet-500/30 bg-violet-500/10 text-violet-600">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet-500" />
                {activeJobs} job{activeJobs > 1 ? 's' : ''}
              </Badge>
            )}
            <EngineChip />
            <PerfMeter />
          </div>
        </header>

        <ScrollArea className="min-h-0 flex-1">
          <main className="mx-auto w-full max-w-6xl p-4 pb-8 md:p-6">
            <ViewRouter view={view} />
          </main>
        </ScrollArea>

        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
        <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />

        {/* Sticky status bar (footer) */}
        <footer className="flex h-9 shrink-0 items-center gap-3 overflow-x-auto border-t bg-card/70 px-4 text-[11px] text-muted-foreground backdrop-blur"
          style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        >
          <span className="flex items-center gap-1 font-medium text-foreground/80">
            <Cpu className="h-3 w-3" /> {tuned.tier.toUpperCase()} tier · score {tuned.score}
          </span>
          <span className="hidden sm:inline">OCR: {tuned.ocrPower}</span>
          <span className="hidden sm:inline">Threads: {tuned.ttsThreads} TTS / {tuned.ocrThreads} OCR</span>
          <span className="hidden md:inline">Chunk: {tuned.ttsChunkChars} chars</span>
          <span className="hidden md:inline">Cache: {tuned.cacheMB} MB</span>
          <span className="hidden items-center gap-1 md:flex">
            <Keyboard className="h-3 w-3" />
            <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">⌘K</kbd> commands
          </span>
          <button
            type="button"
            onClick={() => setShortcutsOpen(true)}
            className="hidden shrink-0 items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-accent hover:text-foreground md:inline-flex"
            title="Keyboard shortcuts"
          >
            <kbd className="rounded border bg-muted px-1 font-mono text-[10px]">?</kbd> shortcuts
          </button>
          <span className="ml-auto hidden shrink-0 lg:inline">Openmukti Audiobook Creator v2.1 · AutoBook inside</span>
        </footer>
      </div>
    </div>
  );
}

// Lazy view registry keeps the shell light.
import { DashboardView } from '@/components/views/dashboard-view';
import { AssetBinView } from '@/components/views/asset-bin-view';
import { QueueView } from '@/components/views/queue-view';
import { AutoBookView } from '@/components/views/autobook-view';
import { TtsStudioView } from '@/components/views/tts-studio-view';
import { DialogueView } from '@/components/views/dialogue-view';
import { FileStudioView } from '@/components/views/file-studio-view';
import { AudiobookView } from '@/components/views/audiobook-view';
import { VideoEditorView } from '@/components/views/video-editor-view';
import { OcrLabView } from '@/components/views/ocr-lab-view';
import { TranscribeView } from '@/components/views/transcribe-view';
import { VoiceLibraryView } from '@/components/views/voice-library-view';
import { SettingsView } from '@/components/views/settings-view';
import { FeaturesView } from '@/components/views/features-view';

function ViewRouter({ view }: { view: ViewId }) {
  // All views stay mounted (hidden when inactive) so in-progress work —
  // file lists, text inputs, timelines — survives navigation. Incoming
  // views animate in (tw-animate-css) since display:none resets animations.
  const views: [ViewId, React.ReactNode][] = [
    ['dashboard', <DashboardView key="dashboard" />],
    ['assets', <AssetBinView key="assets" />],
    ['queue', <QueueView key="queue" />],
    ['autobook', <AutoBookView key="autobook" />],
    ['tts', <TtsStudioView key="tts" />],
    ['dialogue', <DialogueView key="dialogue" />],
    ['files', <FileStudioView key="files" />],
    ['audiobook', <AudiobookView key="audiobook" />],
    ['video', <VideoEditorView key="video" />],
    ['ocr', <OcrLabView key="ocr" />],
    ['transcribe', <TranscribeView key="transcribe" />],
    ['voices', <VoiceLibraryView key="voices" />],
    ['settings', <SettingsView key="settings" />],
    ['features', <FeaturesView key="features" />],
  ];
  return (
    <>
      {views.map(([id, node]) => (
        <div
          key={id}
          className={
            view === id
              ? 'block animate-in fade-in-0 slide-in-from-bottom-3 duration-300'
              : 'hidden'
          }
          aria-hidden={view !== id}
        >
          {node}
        </div>
      ))}
    </>
  );
}

function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const setView = useAppStore((s) => s.setView);
  const { resolvedTheme, setTheme } = useTheme();
  const retune = useAppStore((s) => s.retune);
  const assets = useAppStore((s) => s.assets);
  const jobs = useAppStore((s) => s.jobs);
  const mounted = useMounted();

  const run = (fn: () => void) => {
    fn();
    onOpenChange(false);
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Type a command or search…" />
      <CommandEmpty>No results found.</CommandEmpty>
      <CommandGroup heading="Navigate">
        {NAV.map((n) => (
          <CommandItem key={n.id} onSelect={() => run(() => setView(n.id))}>
            <n.icon className="mr-2 h-4 w-4" />
            {n.label}
            <span className="ml-auto text-xs text-muted-foreground">{n.hint}</span>
          </CommandItem>
        ))}
      </CommandGroup>
      <CommandSeparator />
      <CommandGroup heading="Actions">
        <CommandItem onSelect={() => run(() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark'))}>
          {mounted && resolvedTheme === 'dark' ? <Sun className="mr-2 h-4 w-4" /> : <Moon className="mr-2 h-4 w-4" />}
          Switch to {mounted && resolvedTheme === 'dark' ? 'light' : 'dark'} mode
        </CommandItem>
        <CommandItem onSelect={() => run(retune)}>
          <Zap className="mr-2 h-4 w-4" />Re-run hardware auto-tune
        </CommandItem>
        <CommandItem onSelect={() => run(() => { navigator.clipboard.writeText(window.location.href); })}>
          <Monitor className="mr-2 h-4 w-4" />Copy app URL
        </CommandItem>
        <CommandItem onSelect={() => { onOpenChange(false); window.dispatchEvent(new CustomEvent('auravoice:shortcuts')); }}>
          <Keyboard className="mr-2 h-4 w-4" />Keyboard shortcuts
          <span className="ml-auto text-xs text-muted-foreground">?</span>
        </CommandItem>
      </CommandGroup>
      <CommandSeparator />
      <CommandGroup heading="Session">
        <div className="px-2 py-1.5 text-xs text-muted-foreground">
          {assets.length} asset{assets.length === 1 ? '' : 's'} · {jobs.length} job{jobs.length === 1 ? '' : 's'} this session · all local
        </div>
      </CommandGroup>
    </CommandDialog>
  );
}
