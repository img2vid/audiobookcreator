'use client';

import { useMemo, useState } from 'react';
import { useAppStore } from '@/lib/stores/app-store';
import { CPU_BRANDS, GPU_BRANDS, RAM_OPTIONS, STORAGE_OPTIONS, OS_OPTIONS } from '@/lib/engines/specs-db';
import { getSelectedCpu, getSelectedGpu } from '@/lib/engines/autotune';
import { SectionPanel } from '@/components/widgets/section-panel';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  BadgeCheck, CircuitBoard, Cpu, Gauge, HardDrive, Info, MemoryStick,
  Monitor, RotateCcw, Sparkles, Zap,
} from 'lucide-react';

const TIER_TONE: Record<string, string> = {
  low: 'bg-rose-500/10 text-rose-600 border-rose-500/30',
  mid: 'bg-amber-500/10 text-amber-600 border-amber-500/30',
  high: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30',
  ultra: 'bg-violet-500/10 text-violet-600 border-violet-500/30',
};

function FieldTip({ text }: { text: string }) {
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Info className="h-3.5 w-3.5 text-muted-foreground/70" />
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-64 text-xs">{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function SettingsView() {
  const pcProfile = useAppStore((s) => s.pcProfile);
  const setPcProfile = useAppStore((s) => s.setPcProfile);
  const resetPcProfile = useAppStore((s) => s.resetPcProfile);
  const settings = useAppStore((s) => s.settings);
  const setSetting = useAppStore((s) => s.setSetting);
  const tuned = useAppStore((s) => s.tuned);

  const cpuBrand = useMemo(() => CPU_BRANDS.find((b) => b.id === pcProfile.cpuBrand), [pcProfile.cpuBrand]);
  const cpuGen = useMemo(() => cpuBrand?.generations.find((g) => g.id === pcProfile.cpuGeneration), [cpuBrand, pcProfile.cpuGeneration]);
  const cpuModel = useMemo(() => getSelectedCpu(pcProfile), [pcProfile]);
  const gpuBrand = useMemo(() => GPU_BRANDS.find((b) => b.id === pcProfile.gpuBrand), [pcProfile.gpuBrand]);
  const gpuGen = useMemo(() => gpuBrand?.generations.find((g) => g.id === pcProfile.gpuGeneration), [gpuBrand, pcProfile.gpuGeneration]);
  const gpuModel = useMemo(() => getSelectedGpu(pcProfile), [pcProfile]);
  const isCustomCpu = pcProfile.cpuBrand === 'custom';
  const isCustomGpu = pcProfile.gpuBrand === 'custom';

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <div className="space-y-4">
        {/* CPU */}
        <SectionPanel
          title="Processor (CPU)"
          description="Select brand, then generation, then exact model. Choose Custom to enter specifications manually."
          actions={<Badge variant="outline" className="gap-1 border-emerald-500/30 bg-emerald-500/10 text-emerald-600"><Cpu className="h-3 w-3" />CPU</Badge>}
        >
          <div className="pc-profiler-select grid min-w-0 gap-4 sm:grid-cols-3">
            <div className="min-w-0 space-y-1.5">
              <Label className="flex items-center gap-1.5 text-xs">Brand <FieldTip text="Selecting a brand reveals its generations." /></Label>
              <Select value={pcProfile.cpuBrand} onValueChange={(v) => setPcProfile({ cpuBrand: v, cpuGeneration: '', cpuModel: '' })}>
                <SelectTrigger aria-label="CPU brand" className="h-9 w-full min-w-0 overflow-hidden"><SelectValue className="min-w-0 truncate" placeholder="Select brand" /></SelectTrigger>
                <SelectContent>
                  {CPU_BRANDS.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="min-w-0 space-y-1.5">
              <Label className="flex items-center gap-1.5 text-xs">Generation <FieldTip text="Selecting a generation reveals its models." /></Label>
              <Select
                value={pcProfile.cpuGeneration || undefined}
                onValueChange={(v) => setPcProfile({ cpuGeneration: v, cpuModel: '' })}
                disabled={!cpuBrand || cpuBrand.generations.length === 0}
              >
                <SelectTrigger aria-label="CPU generation" className="h-9 w-full min-w-0 overflow-hidden"><SelectValue className="min-w-0 truncate" placeholder={cpuBrand?.generations.length ? 'Select generation' : '—'} /></SelectTrigger>
                <SelectContent className="max-h-72 w-[var(--radix-select-trigger-width)] max-w-[min(28rem,calc(100vw-2rem))]">
                  {cpuBrand?.generations.map((g) => (
                    <SelectItem key={g.id} value={g.id} className="whitespace-normal break-words">{g.name} ({g.years})</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="min-w-0 space-y-1.5">
              <Label className="flex items-center gap-1.5 text-xs">Model <FieldTip text="Exact model drives core count, clocks and the auto-tune." /></Label>
              <Select
                value={pcProfile.cpuModel || undefined}
                onValueChange={(v) => setPcProfile({ cpuModel: v })}
                disabled={!cpuGen || isCustomCpu}
              >
                <SelectTrigger aria-label="CPU model" className="h-9 w-full min-w-0 overflow-hidden"><SelectValue className="min-w-0 truncate" placeholder={cpuGen ? 'Select model' : '—'} /></SelectTrigger>
                <SelectContent className="max-h-72 w-[var(--radix-select-trigger-width)] max-w-[min(28rem,calc(100vw-2rem))]">
                  {cpuGen?.models.map((m) => (
                    <SelectItem key={m.id} value={m.id} className="whitespace-normal break-words">{m.name} · {m.cores}C/{m.threads}T</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {isCustomCpu && (
            <div className="mt-4 grid gap-4 rounded-lg border bg-muted/30 p-4 sm:grid-cols-3">
              <div className="space-y-2">
                <Label className="text-xs flex items-center gap-1.5"><Gauge className="h-3.5 w-3.5" />Clock speed: {pcProfile.customCpu.clockGhz.toFixed(1)} GHz</Label>
                <Slider value={[pcProfile.customCpu.clockGhz]} min={0.8} max={6.5} step={0.1}
                  onValueChange={([v]) => setPcProfile({ customCpu: { ...pcProfile.customCpu, clockGhz: v } })} />
              </div>
              <div className="space-y-2">
                <Label className="text-xs">Cores: {pcProfile.customCpu.cores}</Label>
                <Slider value={[pcProfile.customCpu.cores]} min={1} max={128} step={1}
                  onValueChange={([v]) => setPcProfile({ customCpu: { ...pcProfile.customCpu, cores: v, threads: Math.max(v, pcProfile.customCpu.threads) } })} />
              </div>
              <div className="space-y-2">
                <Label className="text-xs">Threads: {pcProfile.customCpu.threads}</Label>
                <Slider value={[pcProfile.customCpu.threads]} min={1} max={256} step={1}
                  onValueChange={([v]) => setPcProfile({ customCpu: { ...pcProfile.customCpu, threads: v } })} />
              </div>
            </div>
          )}

          {cpuModel && (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <BadgeCheck className="h-4 w-4 text-emerald-600" />
              Selected: <span className="font-medium text-foreground">{cpuModel.name}</span>
              · {cpuModel.cores} cores / {cpuModel.threads} threads
              · {cpuModel.baseGhz} GHz{cpuModel.boostGhz ? ` (boost ${cpuModel.boostGhz} GHz)` : ''}
              {cpuModel.tdpW ? ` · ${cpuModel.tdpW} W TDP` : ''}
            </div>
          )}
        </SectionPanel>

        {/* GPU */}
        <SectionPanel
          title="Graphics (GPU acceleration)"
          description="Optional. Enabling GPU acceleration lets auto-tune raise quality targets and offload-friendly presets."
          actions={
            <div className="flex items-center gap-2">
              <Label htmlFor="gpu-toggle" className="text-xs text-muted-foreground">Enabled</Label>
              <Switch id="gpu-toggle" checked={pcProfile.gpuEnabled} onCheckedChange={(v) => setPcProfile({ gpuEnabled: v })} />
            </div>
          }
        >
          {pcProfile.gpuEnabled ? (
            <div className="space-y-4">
              <div className="pc-profiler-select grid min-w-0 gap-4 sm:grid-cols-3">
                <div className="min-w-0 space-y-1.5">
                  <Label className="text-xs">Brand</Label>
                  <Select value={pcProfile.gpuBrand} onValueChange={(v) => setPcProfile({ gpuBrand: v, gpuGeneration: '', gpuModel: '' })}>
                    <SelectTrigger aria-label="GPU brand" className="h-9 w-full min-w-0 overflow-hidden"><SelectValue className="min-w-0 truncate" placeholder="Select brand" /></SelectTrigger>
                    <SelectContent>
                      {GPU_BRANDS.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="min-w-0 space-y-1.5">
                  <Label className="text-xs">Series / Generation</Label>
                  <Select
                    value={pcProfile.gpuGeneration || undefined}
                    onValueChange={(v) => setPcProfile({ gpuGeneration: v, gpuModel: '' })}
                    disabled={!gpuBrand || gpuBrand.generations.length === 0}
                  >
                    <SelectTrigger aria-label="GPU generation" className="h-9 w-full min-w-0 overflow-hidden"><SelectValue className="min-w-0 truncate" placeholder={gpuBrand?.generations.length ? 'Select series' : '—'} /></SelectTrigger>
                    <SelectContent className="max-h-72 w-[var(--radix-select-trigger-width)] max-w-[min(28rem,calc(100vw-2rem))]">
                      {gpuBrand?.generations.map((g) => (
                        <SelectItem key={g.id} value={g.id} className="whitespace-normal break-words">{g.name} ({g.years})</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="min-w-0 space-y-1.5">
                  <Label className="text-xs">Model</Label>
                  <Select
                    value={pcProfile.gpuModel || undefined}
                    onValueChange={(v) => setPcProfile({ gpuModel: v })}
                    disabled={!gpuGen || isCustomGpu}
                  >
                    <SelectTrigger aria-label="GPU model" className="h-9 w-full min-w-0 overflow-hidden"><SelectValue className="min-w-0 truncate" placeholder={gpuGen ? 'Select model' : '—'} /></SelectTrigger>
                    <SelectContent className="max-h-72 w-[var(--radix-select-trigger-width)] max-w-[min(28rem,calc(100vw-2rem))]">
                      {gpuGen?.models.map((m) => (
                        <SelectItem key={m.id} value={m.id} className="whitespace-normal break-words">{m.name} · {m.vramGB}GB</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {isCustomGpu && (
                <div className="grid gap-4 rounded-lg border bg-muted/30 p-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label className="text-xs">VRAM: {pcProfile.customGpu.vramGB} GB</Label>
                    <Slider value={[pcProfile.customGpu.vramGB]} min={1} max={48} step={1}
                      onValueChange={([v]) => setPcProfile({ customGpu: { ...pcProfile.customGpu, vramGB: v } })} />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs">Compute: {pcProfile.customGpu.teraflops} TFLOPS</Label>
                    <Slider value={[pcProfile.customGpu.teraflops]} min={0.5} max={110} step={0.5}
                      onValueChange={([v]) => setPcProfile({ customGpu: { ...pcProfile.customGpu, teraflops: v } })} />
                  </div>
                </div>
              )}

              {gpuModel && (
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <BadgeCheck className="h-4 w-4 text-emerald-600" />
                  Selected: <span className="font-medium text-foreground">{gpuModel.name}</span>
                  · {gpuModel.vramGB} GB VRAM · {gpuModel.teraflops} TFLOPS
                  {gpuModel.tensorCores ? ` · ${gpuModel.tensorCores} tensor cores` : ''}
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              <CircuitBoard className="h-4 w-4" />
              GPU acceleration is off — the suite runs fully on CPU, which is perfectly fine for TTS and OCR.
            </div>
          )}
        </SectionPanel>

        {/* RAM + storage + OS */}
        <SectionPanel title="Memory, Storage & OS" description="RAM size adjusts cache sizes and OCR budgets.">
          <div className="grid gap-5 sm:grid-cols-3">
            <div className="space-y-2">
              <Label className="flex items-center gap-1.5 text-xs"><MemoryStick className="h-3.5 w-3.5" />RAM: {pcProfile.ramGB} GB</Label>
              <Select value={String(pcProfile.ramGB)} onValueChange={(v) => setPcProfile({ ramGB: Number(v) })}>
                <SelectTrigger aria-label="RAM size"><SelectValue /></SelectTrigger>
                <SelectContent className="max-h-72">
                  {RAM_OPTIONS.map((r) => <SelectItem key={r} value={String(r)}>{r} GB</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1.5 text-xs"><HardDrive className="h-3.5 w-3.5" />Storage</Label>
              <Select value={pcProfile.storage} onValueChange={(v) => setPcProfile({ storage: v as typeof pcProfile.storage })}>
                <SelectTrigger aria-label="Storage type"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {STORAGE_OPTIONS.map((s) => <SelectItem key={s.id} value={s.id}>{s.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1.5 text-xs"><Monitor className="h-3.5 w-3.5" />Operating system</Label>
              <Select value={pcProfile.os} onValueChange={(v) => setPcProfile({ os: v as typeof pcProfile.os })}>
                <SelectTrigger aria-label="Operating system"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {OS_OPTIONS.map((s) => <SelectItem key={s.id} value={s.id}>{s.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
        </SectionPanel>

        {/* AI Assistance */}
        <SectionPanel title="AI assistance" description="Every module can use the local model. All processing stays in this browser.">
          <div className="flex items-center justify-between">
            <Label htmlFor="ai-assist">Enable AI assistance everywhere</Label>
            <Switch id="ai-assist" checked={settings.aiAssist} onCheckedChange={(v) => setSetting('aiAssist', v as never)} />
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Label htmlFor="ai-download">Allow AI model downloads</Label>
              <FieldTip text="If the selected model is not bundled with the app, it is downloaded once from its Hugging Face repository and cached in this browser (~120 MB – 2.4 GB). Turn this off to guarantee zero AI network traffic — AI then runs only from bundled model files, otherwise AutoBook uses its deterministic engine." />
            </div>
            <Switch id="ai-download" disabled={!settings.aiAssist} checked={settings.aiAllowRemoteDownload} onCheckedChange={(v) => setSetting('aiAllowRemoteDownload', v as never)} />
          </div>
          <Separator />
          <div className="flex items-center gap-3">
            <Label>AI depth</Label>
            <Select value={settings.aiDepth} onValueChange={(v) => setSetting('aiDepth', v as never)}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="light">Light</SelectItem>
                <SelectItem value="standard">Standard</SelectItem>
                <SelectItem value="deep">Deep</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Separator />
          <div className="grid gap-3" style={{ opacity: settings.aiAssist ? 1 : 0.5 }}>
            {([
              ['aiAssistOcr', 'OCR correction', 'Post-corrects scans: fixes substitution errors, restores punctuation, strips page furniture.'],
              ['aiAssistTranscript', 'Transcript cleanup & chaptering', 'Punctuates raw transcripts and splits them into titled chapters.'],
              ['aiAssistTts', 'Speech direction', 'Normalizes text into a speakable director\'s script before rendering.'],
              ['aiAssistFiles', 'Document intelligence', 'Summaries, key points and keywords for ingested documents.'],
              ['aiAssistAssets', 'Asset auto-tagging', 'Tags and describes assets in the bin automatically.'],
              ['aiAssistVideo', 'Video planning & captions', 'Storyboards from briefs and writes subtitle captions.'],
              ['aiAssistDialogue', 'Dialogue direction', 'Scores each dialogue line with a delivery emotion.'],
              ['aiAssistVoices', 'Voice design', 'Derives synthesizer parameters from a prose description.'],
            ] as const).map(([key, label, tip]) => (
              <div key={key} className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  <Label htmlFor={key}>{label}</Label>
                  <FieldTip text={tip} />
                </div>
                <Switch id={key} disabled={!settings.aiAssist} checked={Boolean(settings[key])} onCheckedChange={(v) => setSetting(key, v as never)} />
              </div>
            ))}
          </div>
        </SectionPanel>

        {/* App settings */}
        <SectionPanel title="Engine & App Settings" description="Toggles that shape how every module behaves.">
          <div className="grid gap-4 md:grid-cols-2">
            {([
              ['gpuAcceleration', 'GPU acceleration', 'Mark GPU offload as allowed for tuned presets.'],
              ['fallbackMode', 'Force fallback TTS (non-AI)', 'Always use the built-in formant engine — even if AI voices are available.'],
              ['autoFallback', 'Auto-fallback on AI failure', 'If the AI engine errors mid-job, continue with the built-in engine automatically.'],
              ['autoTune', 'Auto-tune from PC specs', 'Recompute all engine settings whenever the hardware profile changes.'],
              ['notifications', 'Job notifications', 'Show a toast when background jobs finish.'],
              ['longSessionGuard', 'Long-session guard', 'Extra-conservative chunking for 10+ hour conversion sessions.'],
              ['highContrast', 'High contrast', 'Boost borders and text contrast.'],
              ['reducedMotion', 'Reduce motion', 'Minimize non-essential animations.'],
            ] as const).map(([key, label, desc]) => (
              <div key={key} className="flex items-start justify-between gap-3 rounded-lg border p-3">
                <div className="min-w-0">
                  <Label htmlFor={`set-${key}`} className="text-sm">{label}</Label>
                  <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>
                </div>
                <Switch
                  id={`set-${key}`}
                  checked={settings[key] as boolean}
                  onCheckedChange={(v) => setSetting(key, v as never)}
                  className="mt-0.5"
                />
              </div>
            ))}
            <div className="rounded-lg border p-3 md:col-span-2">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <Label className="text-sm">OCR power</Label>
                  <p className="mt-0.5 text-xs text-muted-foreground">Auto derives the power from your hardware; or pin a level manually.</p>
                </div>
                <Select value={settings.ocrPowerOverride} onValueChange={(v) => setSetting('ocrPowerOverride', v as never)}>
                  <SelectTrigger className="w-36" aria-label="OCR power override"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto (from specs)</SelectItem>
                    <SelectItem value="lite">Lite</SelectItem>
                    <SelectItem value="standard">Standard</SelectItem>
                    <SelectItem value="heavy">Heavy</SelectItem>
                    <SelectItem value="ultra">Ultra</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        </SectionPanel>
      </div>

      {/* Tuned summary */}
      <div className="space-y-4">
        <Card>
          <CardHeader className="flex flex-row items-start justify-between space-y-0">
            <div>
              <CardTitle className="flex items-center gap-2 text-base"><Sparkles className="h-4 w-4 text-violet-500" />Auto-tuned settings</CardTitle>
              <CardDescription className="text-xs">Derived live from your exact PC specifications.</CardDescription>
            </div>
            <div className="flex flex-col items-end gap-1.5">
              <Badge variant="outline" className={TIER_TONE[tuned.tier]}>{tuned.tier.toUpperCase()} tier</Badge>
              <Badge variant="outline" className="tabular-nums">score {tuned.score}/100</Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-gradient-to-r from-emerald-500 via-amber-500 to-violet-500 transition-all"
                style={{ width: `${tuned.score}%` }}
              />
            </div>
            <ScrollArea className="max-h-56">
              <div className="grid grid-cols-2 gap-2 text-xs">
                {([
                  ['OCR power', tuned.ocrPower],
                  ['OCR max pixels', `${(tuned.ocrMaxPixels / 1e6).toFixed(1)} MP`],
                  ['OCR threads', tuned.ocrThreads],
                  ['TTS threads', tuned.ttsThreads],
                  ['Batch size', tuned.ttsBatchSize],
                  ['Chunk size', `${tuned.ttsChunkChars} chars`],
                  ['Synthesis quality', tuned.synthesisQuality],
                  ['Cache', `${tuned.cacheMB} MB`],
                  ['I/O buffer', `${tuned.ioBufferKB} KB`],
                  ['Queue concurrency', tuned.queueConcurrency],
                  ['Video export', tuned.videoExportPreset],
                  ['GPU offload', tuned.gpuOffload ? 'allowed' : 'off'],
                ] as const).map(([k, v]) => (
                  <div key={k} className="rounded-md border bg-muted/30 px-2 py-1.5">
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{k}</div>
                    <div className="font-medium capitalize">{String(v)}</div>
                  </div>
                ))}
              </div>
            </ScrollArea>
            <Separator />
            <div className="space-y-1.5">
              <div className="text-xs font-medium">Why these settings?</div>
              <ul className="space-y-1 text-xs text-muted-foreground">
                {tuned.notes.map((n, i) => (
                  <li key={i} className="flex gap-1.5"><Zap className="mt-0.5 h-3 w-3 shrink-0 text-amber-500" />{n}</li>
                ))}
              </ul>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex items-center justify-between p-4">
            <div className="text-xs text-muted-foreground">Settings persist locally on this machine only.</div>
            <Button variant="outline" size="sm" onClick={resetPcProfile}>
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />Reset profile
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
