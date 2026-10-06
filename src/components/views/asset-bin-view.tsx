'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useAppStore } from '@/lib/stores/app-store';
import { SectionPanel } from '@/components/widgets/section-panel';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { formatBytes, formatDuration, formatNumber, timeAgo } from '@/lib/utils/format';
import {
  Copy, Database, Download, FileAudio, FileImage, FileText, FileVideo, Film,
  History, ListChecks, Music, Play, ScanText, Sparkles, Trash2, Type,
} from 'lucide-react';
import type { AssetItem, AssetKind } from '@/lib/types';
import { aiTagAsset } from '@/lib/engines/ai-services';

const KIND_META: Record<AssetKind, { icon: typeof FileText; tone: string; label: string }> = {
  audio: { icon: FileAudio, tone: 'bg-violet-500/10 text-violet-600 border-violet-500/30', label: 'Audio' },
  image: { icon: FileImage, tone: 'bg-rose-500/10 text-rose-600 border-rose-500/30', label: 'Image' },
  video: { icon: FileVideo, tone: 'bg-fuchsia-500/10 text-fuchsia-600 border-fuchsia-500/30', label: 'Video' },
  text: { icon: FileText, tone: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30', label: 'Text' },
  data: { icon: Database, tone: 'bg-amber-500/10 text-amber-600 border-amber-500/30', label: 'Data' },
};

type SortId = 'newest' | 'oldest' | 'name-az' | 'size-desc' | 'duration-desc';

/** Stable comparators (Array#sort is stable) — reorder only, no layout shift. */
const SORTERS: Record<SortId, (a: AssetItem, b: AssetItem) => number> = {
  newest: (a, b) => b.createdAt - a.createdAt,
  oldest: (a, b) => a.createdAt - b.createdAt,
  'name-az': (a, b) => a.name.localeCompare(b.name),
  'size-desc': (a, b) => (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0),
  'duration-desc': (a, b) => (b.durationSec ?? -1) - (a.durationSec ?? -1),
};

/** Rendering cap for the text preview dialog (counts always reflect the full text). */
const TEXT_PREVIEW_LIMIT = 20_000;

const WAVE_COLUMNS = 32;

/**
 * Static 32-column min/max waveform thumbnail drawn once on mount from a live
 * AudioBuffer (runtime-only). Restored assets have no buffer → the card simply
 * skips it; blobs are never decoded here. Stroked in the current text color so
 * it adapts to both themes.
 */
function MiniWaveform({ buffer }: { buffer: AudioBuffer }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 160;
    const h = canvas.clientHeight || 24;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const data = buffer.getChannelData(0);
    const per = Math.floor(data.length / WAVE_COLUMNS) || 1;
    // Stride caps per-column work so hour-long buffers stay a one-shot few ms.
    const stride = Math.max(1, Math.floor(per / 512));
    ctx.strokeStyle = window.getComputedStyle(canvas).color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let c = 0; c < WAVE_COLUMNS; c++) {
      const start = c * per;
      const end = Math.min(data.length, start + per);
      let min = 1;
      let max = -1;
      for (let i = start; i < end; i += stride) {
        const v = data[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (min > max) { min = 0; max = 0; }
      const x = ((c + 0.5) / WAVE_COLUMNS) * w;
      const top = ((1 - max) / 2) * h;
      const bottom = ((1 - min) / 2) * h;
      ctx.moveTo(x, top);
      ctx.lineTo(x, Math.max(top + 1, bottom));
    }
    ctx.stroke();
  }, [buffer]);

  return (
    <canvas
      ref={ref}
      aria-hidden
      className="asset-wave-thumb mt-2 h-6 w-full rounded-md border bg-muted/30 text-muted-foreground/70"
    />
  );
}

function countWords(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

export function AssetBinView() {
  const { toast } = useToast();
  const assets = useAppStore((s) => s.assets);
  const assetsRestored = useAppStore((s) => s.assetsRestored);
  const restoreAssets = useAppStore((s) => s.restoreAssets);
  const removeAsset = useAppStore((s) => s.removeAsset);
  const updateAsset = useAppStore((s) => s.updateAsset);
  const clearAssets = useAppStore((s) => s.clearAssets);
  const setPendingText = useAppStore((s) => s.setPendingText);
  const setPendingSoundtrackAssetId = useAppStore((s) => s.setPendingSoundtrackAssetId);
  const setView = useAppStore((s) => s.setView);
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<string>('all');
  const [sortBy, setSortBy] = useState<SortId>('newest');
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [textPreviewId, setTextPreviewId] = useState<string | null>(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  // pull persisted assets out of IndexedDB once per session
  useEffect(() => {
    void restoreAssets();
  }, [restoreAssets]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return assets.filter((a) => {
      if (kindFilter !== 'all' && a.kind !== kindFilter) return false;
      if (q && !a.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [assets, query, kindFilter]);

  const sorted = useMemo(() => [...filtered].sort(SORTERS[sortBy]), [filtered, sortBy]);

  const totals = useMemo(() => {
    const bytes = assets.reduce((a, x) => a + (x.sizeBytes ?? 0), 0);
    const audioSec = assets.filter((a) => a.kind === 'audio').reduce((a, x) => a + (x.durationSec ?? 0), 0);
    return { count: assets.length, bytes, audioSec };
  }, [assets]);

  const restoredCount = useMemo(() => assets.filter((a) => (a.meta as { restored?: boolean } | undefined)?.restored).length, [assets]);

  const clearAll = () => {
    clearAssets();
    toast({ title: 'Asset bin cleared', description: 'Blob URLs revoked, memory released, on-device copies removed.' });
  };

  const sendToVideo = (assetId: string, kind: AssetKind) => {
    if (kind === 'audio') {
      setPendingSoundtrackAssetId(assetId);
      toast({ title: 'Soundtrack queued', description: 'Opened Video Editor — soundtrack applied.' });
    } else {
      toast({ title: 'Available in Video Editor', description: 'Add an Image clip and pick this asset.' });
    }
    setView('video');
  };

  // ----- multi-select batch mode -----
  const exitSelectMode = () => {
    setSelectMode(false);
    setSelected(new Set());
  };
  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const allShownSelected = filtered.length > 0 && filtered.every((a) => selected.has(a.id));
  const toggleSelectAll = () => {
    setSelected(allShownSelected ? new Set() : new Set(filtered.map((a) => a.id)));
  };
  const deleteSelected = () => {
    const ids = Array.from(selected);
    ids.forEach((id) => removeAsset(id));
    toast({ title: `Deleted ${ids.length} asset${ids.length === 1 ? '' : 's'}`, description: 'Removed from the bin and on-device storage.' });
    exitSelectMode();
  };

  // ----- text preview dialog -----
  const textAsset = textPreviewId ? assets.find((a) => a.id === textPreviewId) ?? null : null;
  const textPreviewText = textAsset?.text ?? '';
  const textTruncated = textPreviewText.length > TEXT_PREVIEW_LIMIT;
  const copyPreviewText = () => {
    void navigator.clipboard.writeText(textPreviewText);
    toast({ title: 'Text copied' });
  };
  const sendPreviewToTts = () => {
    if (!textAsset) return;
    setPendingText(textAsset.text ?? null, `Asset "${textAsset.name}"`);
    setView('tts');
    setTextPreviewId(null);
  };

  const previewAsset = assets.find((a) => a.id === previewId) ?? null;

  return (
    <div className="space-y-4">
      <SectionPanel
        title="Asset Bin"
        description="Every render, conversion, OCR result and export lands here — mirrored to on-device storage so it survives reloads."
        actions={
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="tabular-nums">{totals.count} items · {formatBytes(totals.bytes)}</Badge>
            {restoredCount > 0 && (
              <Badge variant="outline" className="tabular-nums border-emerald-500/30 bg-emerald-500/10 text-emerald-600">
                <History className="mr-1 h-3 w-3" />{restoredCount} restored
              </Badge>
            )}
            {totals.audioSec > 0 && (
              <Badge variant="outline" className="tabular-nums border-violet-500/30 bg-violet-500/10 text-violet-600">
                <Music className="mr-1 h-3 w-3" />{formatDuration(totals.audioSec)} audio
              </Badge>
            )}
            {assets.length > 0 && (
              <Button size="sm" variant="ghost" onClick={clearAll}>
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />Clear all
              </Button>
            )}
          </div>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search assets…" className="w-52" aria-label="Search assets" />
          </div>
          <Select value={kindFilter} onValueChange={setKindFilter}>
            <SelectTrigger className="w-36" aria-label="Filter by kind"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All kinds</SelectItem>
              <SelectItem value="audio">Audio</SelectItem>
              <SelectItem value="image">Image</SelectItem>
              <SelectItem value="video">Video</SelectItem>
              <SelectItem value="text">Text</SelectItem>
              <SelectItem value="data">Data</SelectItem>
            </SelectContent>
          </Select>
          <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortId)}>
            <SelectTrigger className="w-32" aria-label="Sort assets"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Newest</SelectItem>
              <SelectItem value="oldest">Oldest</SelectItem>
              <SelectItem value="name-az">Name A–Z</SelectItem>
              <SelectItem value="size-desc">Size ↓</SelectItem>
              <SelectItem value="duration-desc">Duration ↓</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground">{filtered.length} shown</span>
          {assets.length > 0 && (
            <Button
              size="sm"
              variant={selectMode ? 'secondary' : 'outline'}
              className="ml-auto h-7 px-2 text-xs"
              aria-pressed={selectMode}
              onClick={() => { if (selectMode) exitSelectMode(); else setSelectMode(true); }}
            >
              <ListChecks className="mr-1 h-3 w-3" />Select
            </Button>
          )}
        </div>

        <AnimatePresence initial={false}>
          {selectMode && (
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.16, ease: 'easeOut' }}
              className="batch-bar sticky top-2 z-10 mt-3 flex flex-wrap items-center gap-1.5 rounded-lg border bg-background/95 p-2 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/75"
            >
              <Button
                size="sm"
                variant="outline"
                className="h-7 max-sm:h-11 max-sm:px-3 px-2 text-xs"
                onClick={toggleSelectAll}
                aria-label={allShownSelected ? 'Deselect all shown assets' : `Select all ${filtered.length} shown assets`}
              >
                <ListChecks className="mr-1 h-3 w-3" />
                {allShownSelected ? 'Deselect all' : `Select all ${filtered.length}`}
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 max-sm:h-11 max-sm:px-3 px-2 text-xs text-rose-600 hover:bg-rose-500/10 hover:text-rose-600 dark:hover:text-rose-500"
                    disabled={selected.size === 0}
                  >
                    <Trash2 className="mr-1 h-3 w-3" />Delete {selected.size}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete {selected.size} asset{selected.size === 1 ? '' : 's'}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      This permanently removes the selected assets from the bin — blob URLs, memory buffers and on-device copies. This cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel className="h-8 max-sm:h-11 sm:px-3">Keep assets</AlertDialogCancel>
                    <AlertDialogAction
                      className="h-8 max-sm:h-11 bg-rose-600 text-white hover:bg-rose-700 sm:px-3"
                      onClick={deleteSelected}
                    >
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
              <Button size="sm" variant="ghost" className="h-7 max-sm:h-11 max-sm:px-3 px-2 text-xs" onClick={exitSelectMode}>
                Cancel
              </Button>
              <span className="ml-auto pr-1 text-[11px] tabular-nums text-muted-foreground">{selected.size} selected</span>
            </motion.div>
          )}
        </AnimatePresence>

        {filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed py-12 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
              <Database className="h-6 w-6 text-primary" />
            </div>
            <div className="text-sm font-medium">{assets.length === 0 ? 'The bin is empty' : 'No assets match your filters'}</div>
            <div className="max-w-sm text-xs text-muted-foreground">
              Render audio in TTS Studio, convert files in File Studio, run OCR, or export a video —
              results appear here with one-click download and reuse.
            </div>
          </div>
        ) : (
          <ScrollArea className="mt-3 max-h-[38rem] pr-3">
            <div className="grid gap-2 md:grid-cols-2">
              {sorted.map((a) => {
                const meta = KIND_META[a.kind] ?? KIND_META.data;
                const Icon = meta.icon;
                const isSelected = selected.has(a.id);
                return (
                  <div
                    key={a.id}
                    className={cn(
                      'group rounded-lg border p-3 transition-colors hover:bg-muted/30',
                      selectMode && 'cursor-pointer',
                      isSelected && 'border-violet-500/50 bg-violet-500/5',
                    )}
                    onClick={selectMode ? () => toggleSelect(a.id) : undefined}
                  >
                    <div className="flex items-start gap-3">
                      {selectMode && (
                        <span className="mt-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                          <Checkbox
                            checked={isSelected}
                            onCheckedChange={() => toggleSelect(a.id)}
                            aria-label={`Select ${a.name}`}
                          />
                        </span>
                      )}
                      <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border', meta.tone)}>
                        <Icon className="h-5 w-5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-sm font-medium">{a.name}</span>
                          {(a.meta as { restored?: boolean } | undefined)?.restored && (
                            <span title="Restored from on-device storage after reload">
                              <History className="h-3 w-3 shrink-0 text-emerald-500" />
                            </span>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                          <span>{formatBytes(a.sizeBytes ?? 0)}</span>
                          {a.durationSec != null && <span>· {formatDuration(a.durationSec)}</span>}
                          {a.width != null && <span>· {a.width}×{a.height}</span>}
                          <span>· {timeAgo(a.createdAt)}</span>
                        </div>
                      </div>
                    </div>

                    {a.kind === 'audio' && a.buffer && <MiniWaveform buffer={a.buffer} />}
                    {a.kind === 'audio' && a.blobUrl && (
                      <audio
                        src={a.blobUrl}
                        controls
                        className={cn('mt-2 h-8 w-full', selectMode && 'pointer-events-none opacity-60')}
                        preload="none"
                        aria-label={`Play ${a.name}`}
                        tabIndex={selectMode ? -1 : undefined}
                      />
                    )}
                    {a.kind === 'image' && a.blobUrl && (
                       
                      <img src={a.blobUrl} alt={a.name} className="mt-2 h-20 rounded-md border object-cover" />
                    )}
                    {a.kind === 'text' && a.text && (
                      <p
                        className={cn(
                          'mt-2 line-clamp-2 rounded-md border bg-muted/30 p-2 text-[11px] leading-relaxed text-muted-foreground',
                          !selectMode && 'cursor-pointer transition-colors hover:border-violet-500/40 hover:bg-muted/60',
                        )}
                        {...(selectMode ? {} : {
                          role: 'button',
                          tabIndex: 0,
                          'aria-label': `Preview text of ${a.name}`,
                          onClick: () => setTextPreviewId(a.id),
                          onKeyDown: (e: ReactKeyboardEvent<HTMLParagraphElement>) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              setTextPreviewId(a.id);
                            }
                          },
                        })}
                      >
                        {a.text}
                      </p>
                    )}

                    <div className="mt-2.5 flex flex-wrap items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                      <Dialog open={previewId === a.id} onOpenChange={(o) => setPreviewId(o ? a.id : null)}>
                        <DialogTrigger asChild>
                          <Button size="sm" variant="outline" className="h-7 px-2 text-xs">
                            <Play className="mr-1 h-3 w-3" />Inspect
                          </Button>
                        </DialogTrigger>
                        <DialogContent className="max-w-lg">
                          <DialogHeader>
                            <DialogTitle className="truncate pr-6">{previewAsset?.name}</DialogTitle>
                            <DialogDescription>
                              {previewAsset && `${KIND_META[previewAsset.kind].label} · ${formatBytes(previewAsset.sizeBytes ?? 0)}${previewAsset.durationSec ? ` · ${formatDuration(previewAsset.durationSec)}` : ''}`}
                            </DialogDescription>
                          </DialogHeader>
                          {previewAsset?.kind === 'audio' && previewAsset.blobUrl && (
                            <audio src={previewAsset.blobUrl} controls className="w-full" />
                          )}
                          {previewAsset?.kind === 'image' && previewAsset.blobUrl && (
                             
                            <img src={previewAsset.blobUrl} alt={previewAsset.name} className="max-h-80 w-full rounded-md border object-contain" />
                          )}
                          {previewAsset?.kind === 'video' && previewAsset.blobUrl && (
                            <video src={previewAsset.blobUrl} controls className="max-h-80 w-full rounded-md border" />
                          )}
                          {previewAsset?.text && (
                            <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs leading-relaxed">{previewAsset.text.slice(0, 4000)}</pre>
                          )}
                          {previewAsset?.meta && (
                            <div className="flex flex-wrap gap-1.5">
                              {Object.entries(previewAsset.meta).slice(0, 10).map(([k, v]) => (
                                <Badge key={k} variant="secondary" className="text-[10px] font-normal">{k}: {String(v).slice(0, 40)}</Badge>
                              ))}
                            </div>
                          )}
                        </DialogContent>
                      </Dialog>

                      {a.blobUrl && (
                        <Button size="sm" variant="outline" className="h-7 px-2 text-xs" asChild>
                          <a href={a.blobUrl} download={a.name}><Download className="mr-1 h-3 w-3" />Save</a>
                        </Button>
                      )}
                      {a.kind === 'audio' && (
                        <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => sendToVideo(a.id, 'audio')}>
                          <Film className="mr-1 h-3 w-3" />Soundtrack
                        </Button>
                      )}
                      {a.text && (
                        <Button size="sm" variant="outline" className="h-7 px-2 text-xs"
                          onClick={() => { setPendingText(a.text ?? null, `Asset "${a.name}"`); setView('tts'); }}>
                          <Type className="mr-1 h-3 w-3" />Speak
                        </Button>
                      )}
                      {a.text && (
                        <Button size="sm" variant="outline" className="h-7 px-2 text-xs"
                          onClick={() => { void navigator.clipboard.writeText(a.text ?? ''); toast({ title: 'Text copied' }); }}>
                          <ScanText className="mr-1 h-3 w-3" />Copy text
                        </Button>
                      )}
                      <Button size="sm" variant="outline" className="h-7 px-2 text-xs"
                        onClick={async () => {
                          const tags = await aiTagAsset(a);
                          if (tags.ok && tags.value) {
                            updateAsset(a.id, { meta: { ...a.meta, aiTags: tags.value.tags, aiDescription: tags.value.description } });
                            toast({ title: 'AI tagged', description: tags.value.tags.join(', ') });
                          } else {
                            toast({ title: 'AI tagging failed', description: tags.error ?? 'Try again.', variant: 'destructive' });
                          }
                        }}>
                        <Sparkles className="mr-1 h-3 w-3" />AI tag
                      </Button>
                      <Button size="icon" variant="ghost" className="ml-auto h-7 w-7" aria-label={`Delete ${a.name}`}
                        onClick={() => removeAsset(a.id)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </SectionPanel>

      <Dialog open={textPreviewId !== null} onOpenChange={(o) => { if (!o) setTextPreviewId(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="truncate pr-6">{textAsset?.name ?? 'Text preview'}</DialogTitle>
            <DialogDescription>
              {textPreviewText
                ? `${formatNumber(countWords(textPreviewText))} words · ${formatNumber(textPreviewText.length)} characters`
                : 'Empty text asset'}
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 text-xs leading-relaxed">
            {textPreviewText.slice(0, TEXT_PREVIEW_LIMIT)}
            {textTruncated ? '…' : ''}
          </pre>
          {textTruncated && (
            <p className="text-[10px] text-muted-foreground">
              Preview limited to the first {formatNumber(TEXT_PREVIEW_LIMIT)} characters — counts cover the full text.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" className="h-8 max-sm:h-11 max-sm:flex-1" onClick={copyPreviewText}>
              <Copy className="mr-1.5 h-3.5 w-3.5" />Copy
            </Button>
            <Button size="sm" className="h-8 max-sm:h-11 max-sm:flex-1" onClick={sendPreviewToTts}>
              <Type className="mr-1.5 h-3.5 w-3.5" />Send to TTS Studio
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
