'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '@/lib/stores/app-store';
import { groupVoicesByLang, listNeuralVoices, listSystemVoices, isSpeechSynthesisAvailable } from '@/lib/engines/speech';
import {
  VOICE_PROFILES,
  allVoiceProfiles,
  registerCustomProfiles,
  synthesizeSpeech,
  synthesizeSpeechWithProfile,
} from '@/lib/engines/formant';
import { pickOsVoiceForProfile } from '@/lib/engines/dispatch';
import { probeOsTtsBridge, synthesizeViaBridge } from '@/lib/engines/os-tts-bridge';
import { aiDesignVoiceProfile } from '@/lib/engines/ai-services';
import type { OsTtsEngineId, VoiceProfileDef } from '@/lib/types';
import { TTS_MODELS } from '@/lib/data/tts-models';
import { SectionPanel } from '@/components/widgets/section-panel';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import {
  AudioLines, Bot, Brain, CheckCircle2, Copy, Cpu, Library, Mic2, Pencil, Play, Plus, Radio,
  Search, Sparkles, Trash2, Volume2,
} from 'lucide-react';

const AUDITION_LINE = 'Hello! This is how this voice profile sounds with the speech engine selected on your machine.';

const GENDERS: VoiceProfileDef['gender'][] = ['female', 'male', 'neutral'];

const CUSTOM_LANGS: [string, string][] = [
  ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'],
  ['pt', 'Portuguese'], ['hi', 'Hindi'], ['ar', 'Arabic'], ['zh', 'Chinese'], ['ja', 'Japanese'],
  ['ko', 'Korean'], ['ru', 'Russian'],
];

interface VoiceDraft {
  name: string;
  gender: VoiceProfileDef['gender'];
  basePitchHz: number;
  timbre: number;
  breath: number;
  lang: string;
  description: string;
}

const EMPTY_DRAFT: VoiceDraft = { name: '', gender: 'neutral', basePitchHz: 165, timbre: 1, breath: 0.18, lang: 'en', description: '' };

const clamp01 = (n: number) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
const uid4 = () => Math.random().toString(36).slice(2, 6);
const slugify = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'voice';

export function VoiceLibraryView() {
  const { toast } = useToast();
  const settings = useAppStore((s) => s.settings);
  const setSetting = useAppStore((s) => s.setSetting);
  const setEngine = useAppStore((s) => s.setEngine);
  const customProfiles = useAppStore((s) => s.customProfiles);
  const addCustomProfile = useAppStore((s) => s.addCustomProfile);
  const updateCustomProfile = useAppStore((s) => s.updateCustomProfile);
  const removeCustomProfile = useAppStore((s) => s.removeCustomProfile);

  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [query, setQuery] = useState('');
  const [previewing, setPreviewing] = useState<string | null>(null);

  // custom-voice creator card state
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<VoiceDraft>(EMPTY_DRAFT);
  const [customAuditioning, setCustomAuditioning] = useState<string | null>(null); // profile id or 'custom-preview'
  const [deleteTarget, setDeleteTarget] = useState<VoiceProfileDef | null>(null);
  const customAudioRef = useRef<{ ctx: AudioContext; src: AudioBufferSourceNode } | null>(null);

  useEffect(() => {
    const load = () => {
      void listSystemVoices().then((v) => {
        setVoices(v);
        setEngine({ systemVoices: v.length });
      });
    };
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, []);

  // Hydrate the formant engine's custom registry on mount and whenever the persisted
  // set changes (the app-store mirrors this too — idempotent, cheap, SSR-safe).
  useEffect(() => {
    registerCustomProfiles(customProfiles);
  }, [customProfiles]);

  const neural = useMemo(() => listNeuralVoicesSync(voices), [voices]);
  const grouped = useMemo(() => groupVoicesByLang(voices), [voices]);

  const filteredModels = useMemo(() => {
    const q = query.toLowerCase();
    return TTS_MODELS.filter((m) => !q || m.name.toLowerCase().includes(q) || m.family.toLowerCase().includes(q) || m.tags.some((t) => t.includes(q)));
  }, [query]);

  const filteredVoices = useMemo(() => {
    const q = query.toLowerCase();
    if (!q) return grouped;
    const map = new Map<string, SpeechSynthesisVoice[]>();
    for (const [lang, list] of grouped) {
      const f = list.filter((v) => v.name.toLowerCase().includes(q) || v.lang.toLowerCase().includes(q));
      if (f.length) map.set(lang, f);
    }
    return map;
  }, [grouped, query]);

  const filteredCustom = useMemo(() => {
    const q = query.toLowerCase();
    if (!q) return customProfiles;
    return customProfiles.filter((p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q));
  }, [customProfiles, query]);

  const previewSystemVoice = (v: SpeechSynthesisVoice) => {
    if (!isSpeechSynthesisAvailable()) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance('Hello from Openmukti Audiobook Creator. This voice runs entirely on your machine.');
    u.voice = v;
    u.rate = 1;
    window.speechSynthesis.speak(u);
    setPreviewing(v.voiceURI);
    u.onend = () => setPreviewing(null);
  };

  /** Audition through the ESTABLISHED OS engine when the bridge is running —
   *  the exact voice this profile maps to in renders — falling back to the
   *  built-in formant synth only when no OS engine is reachable. */
  const auditionBestEngine = async (
    text: string,
    profileId: string,
    gender: VoiceProfileDef['gender'] | undefined,
    formantRender: () => Promise<AudioBuffer>,
  ): Promise<{ buffer: AudioBuffer; viaBridge: boolean; label?: string }> => {
    try {
      const probe = await probeOsTtsBridge();
      if (probe.status.ok && probe.voices.length > 0) {
        const voice = pickOsVoiceForProfile(probe.voices, profileId, gender, 'en');
        if (voice) {
          const res = await synthesizeViaBridge({
            engine: voice.engine as OsTtsEngineId,
            voice: voice.name,
            text,
          });
          return { buffer: res.buffer, viaBridge: true, label: `${voice.engine} · ${voice.name}` };
        }
      }
    } catch {
      // bridge unreachable → formant fallback below
    }
    return { buffer: await formantRender(), viaBridge: false };
  };

  const previewProfile = async (profileId: string, name: string) => {
    try {
      setPreviewing(profileId);
      const gender = allVoiceProfiles().find((p) => p.id === profileId)?.gender;
      const audition = await auditionBestEngine(AUDITION_LINE, profileId, gender, () =>
        synthesizeSpeech(AUDITION_LINE, {
          profileId, rate: 1, pitch: 1, volume: 1, quality: 'balanced',
        }),
      );
      if (!audition.viaBridge) {
        toast({
          title: 'Previewed with the built-in synth',
          description: 'Start the OS bridge (npm run os-tts) to audition this profile with the real OS voice it maps to.',
        });
      }
      const ctx = new AudioContext();
      const src = ctx.createBufferSource();
      src.buffer = audition.buffer;
      src.connect(ctx.destination);
      src.onended = () => { setPreviewing(null); void ctx.close(); };
      src.start();
    } catch (e) {
      setPreviewing(null);
      toast({ title: 'Preview failed', description: String(e), variant: 'destructive' });
    }
    void name;
  };

  // ---------- custom voices ----------
  const openCreator = () => {
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
    setCreatorOpen(true);
  };

  const closeCreator = () => {
    setCreatorOpen(false);
    setEditingId(null);
    setDraft(EMPTY_DRAFT);
  };

  const startEdit = (p: VoiceProfileDef) => {
    setEditingId(p.id);
    setDraft({
      name: p.name, gender: p.gender, basePitchHz: p.basePitchHz, timbre: p.timbre,
      breath: p.breath, lang: p.lang, description: p.description,
    });
    setCreatorOpen(true);
  };

  const draftName = draft.name.trim();
  const nameMissing = creatorOpen && draftName.length === 0;
  const nameTaken = creatorOpen && draftName.length > 0 &&
    customProfiles.some((c) => c.name.trim().toLowerCase() === draftName.toLowerCase() && c.id !== editingId);

  const saveCreator = () => {
    const name = draftName;
    if (!name) return;
    const profile: VoiceProfileDef = {
      id: editingId ?? `custom-${slugify(name)}-${uid4()}`,
      name,
      gender: draft.gender,
      basePitchHz: Math.round(Math.min(260, Math.max(60, draft.basePitchHz))),
      timbre: clamp01(draft.timbre),
      breath: clamp01(draft.breath),
      lang: draft.lang,
      description: draft.description.trim() || `${name} — custom formant voice.`,
    };
    if (editingId) {
      updateCustomProfile(editingId, profile);
      toast({ title: `${name} updated`, description: 'The change applies everywhere the profile is used.' });
    } else {
      addCustomProfile(profile);
      toast({ title: `${name} saved`, description: 'Now selectable in TTS Studio’s built-in voice profile picker.' });
    }
    closeCreator();
  };

  const duplicateProfile = (p: VoiceProfileDef) => {
    const taken = new Set(customProfiles.map((c) => c.name.trim().toLowerCase()));
    let name = `${p.name} (copy)`;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${p.name} (copy ${n})`;
    addCustomProfile({ ...p, id: `custom-${slugify(name)}-${uid4()}`, name });
    toast({ title: `${name} created`, description: 'Tweak it with Edit to make it your own.' });
  };

  const confirmDelete = () => {
    if (!deleteTarget) return;
    const victim = deleteTarget;
    removeCustomProfile(victim.id);
    if (editingId === victim.id) closeCreator();
    setDeleteTarget(null);
    toast({
      title: `${victim.name} deleted`,
      description: 'Views that still selected it fall back to the default built-in profile.',
    });
  };

  const stopCustomAudition = () => {
    const cur = customAudioRef.current;
    if (cur) {
      customAudioRef.current = null;
      try { cur.src.stop(); } catch { /* already stopped */ }
      void cur.ctx.close();
    }
  };

  const auditionProfile = async (profile: VoiceProfileDef) => {
    try {
      stopCustomAudition();
      setCustomAuditioning(profile.id);
      const audition = await auditionBestEngine(AUDITION_LINE, profile.id, profile.gender, () =>
        synthesizeSpeechWithProfile(profile, AUDITION_LINE, {
          rate: 1, pitch: 1, volume: 1, quality: 'fast',
        }),
      );
      if (!audition.viaBridge) {
        toast({
          title: 'Previewed with the built-in synth',
          description: 'Start the OS bridge (npm run os-tts) to audition this profile with the real OS voice it maps to.',
        });
      }
      const ctx = new AudioContext();
      const src = ctx.createBufferSource();
      src.buffer = audition.buffer;
      src.connect(ctx.destination);
      customAudioRef.current = { ctx, src };
      src.onended = () => {
        if (customAudioRef.current?.src === src) customAudioRef.current = null;
        setCustomAuditioning(null);
        void ctx.close();
      };
      src.start();
    } catch (e) {
      setCustomAuditioning(null);
      toast({ title: 'Audition failed', description: String(e), variant: 'destructive' });
    }
  };

  /** Audition the creator card with the CURRENT slider values (unsaved draft). */
  const auditionDraft = () => {
    void auditionProfile({
      id: 'custom-preview',
      name: draftName || 'Untitled voice',
      gender: draft.gender,
      basePitchHz: Math.round(draft.basePitchHz),
      timbre: clamp01(draft.timbre),
      breath: clamp01(draft.breath),
      lang: draft.lang,
      description: draft.description.trim(),
    });
  };

  const editingName = editingId ? customProfiles.find((c) => c.id === editingId)?.name : null;

  return (
    <div className="space-y-4">
      <SectionPanel
        title="Voice & Model Library"
        description="Every local voice on this machine plus the bundled synthesis profiles — nothing requires a download or a network."
        actions={
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search voices, models, tags…" className="w-56 pl-8" aria-label="Search library" />
          </div>
        }
      >
        <Tabs defaultValue="models">
          <TabsList>
            <TabsTrigger value="models"><Brain className="mr-1.5 h-4 w-4" />Models ({filteredModels.length})</TabsTrigger>
            <TabsTrigger value="system"><Mic2 className="mr-1.5 h-4 w-4" />System voices ({voices.length})</TabsTrigger>
            <TabsTrigger value="profiles"><Bot className="mr-1.5 h-4 w-4" />Built-in profiles ({VOICE_PROFILES.length})</TabsTrigger>
          </TabsList>

          <TabsContent value="models">
            <ScrollArea className="max-h-[30rem] pr-3">
              <div className="grid gap-2.5 md:grid-cols-2">
                {filteredModels.map((m) => (
                  <div key={m.id} className={cn('rounded-lg border p-3.5', settings.preferredModelId === m.id && 'border-violet-500/50 bg-violet-500/5')}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 text-sm font-medium">
                          {m.engine === 'system-neural' ? <Sparkles className="h-4 w-4 text-emerald-600" /> : m.engine === 'system-classic' ? <Cpu className="h-4 w-4 text-amber-600" /> : <Radio className="h-4 w-4 text-violet-600" />}
                          {m.name}
                        </div>
                        <div className="text-xs text-muted-foreground">{m.family} · {m.lang} · quality {'★'.repeat(m.quality)}{'☆'.repeat(5 - m.quality)}</div>
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        {settings.preferredModelId === m.id ? (
                          <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600"><CheckCircle2 className="mr-1 h-3 w-3" />default</Badge>
                        ) : (
                          <Button size="sm" variant="outline" onClick={() => { setSetting('preferredModelId', m.id); toast({ title: `${m.name} set as default model` }); }}>Set default</Button>
                        )}
                      </div>
                    </div>
                    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{m.description}</p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <Badge variant="secondary" className="text-[10px]">{m.bundled ? 'bundled' : 'pro'}</Badge>
                      {m.sizeMB > 0 && <Badge variant="secondary" className="text-[10px]">{m.sizeMB} MB</Badge>}
                      {m.tags.map((t) => <Badge key={t} variant="secondary" className="text-[10px]">{t}</Badge>)}
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </TabsContent>

          <TabsContent value="system">
            {!isSpeechSynthesisAvailable() ? (
              <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                This browser does not expose the Speech Synthesis API. The built-in formant engine remains fully available.
              </div>
            ) : voices.length === 0 ? (
              <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                Scanning for system voices… if none appear, your OS may have no TTS voices installed.
              </div>
            ) : (
              <ScrollArea className="max-h-[30rem] pr-3">
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Sparkles className="h-3.5 w-3.5 text-emerald-600" />
                    {neural.length} neural-quality voice{neural.length === 1 ? '' : 's'} detected — these give the best AI results.
                  </div>
                  {Array.from(filteredVoices.entries()).map(([lang, list]) => (
                    <div key={lang}>
                      <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{lang} · {list.length}</div>
                      <div className="grid gap-1.5 md:grid-cols-2">
                        {list.map((v) => (
                          <div key={v.voiceURI} className={cn('flex items-center gap-2.5 rounded-lg border p-2.5', settings.preferredVoiceURI === v.voiceURI && 'border-violet-500/50 bg-violet-500/5')}>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5 truncate text-sm font-medium">
                                {v.name}
                                {/neural|natural|premium|enhanced|siri/i.test(v.name) && <Badge variant="secondary" className="h-4 px-1 text-[9px] text-emerald-600">neural</Badge>}
                              </div>
                              <div className="text-[11px] text-muted-foreground">{v.lang} · {v.localService ? 'local (offline-capable)' : 'network voice'}</div>
                            </div>
                            <Button size="icon" variant="ghost" className="h-8 w-8" aria-label={`Preview ${v.name}`} onClick={() => previewSystemVoice(v)}>
                              {previewing === v.voiceURI ? <Volume2 className="h-4 w-4 animate-pulse text-violet-600" /> : <Play className="h-3.5 w-3.5" />}
                            </Button>
                            <Button size="sm" variant={settings.preferredVoiceURI === v.voiceURI ? 'secondary' : 'outline'} className="h-8"
                              onClick={() => { setSetting('preferredVoiceURI', settings.preferredVoiceURI === v.voiceURI ? '' : v.voiceURI); }}>
                              {settings.preferredVoiceURI === v.voiceURI ? 'Pinned' : 'Pin'}
                            </Button>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </TabsContent>

          <TabsContent value="profiles">
            <ScrollArea className="max-h-[30rem] pr-3">
              <div className="grid gap-2.5 md:grid-cols-2">
                {VOICE_PROFILES.filter((p) => !query || p.name.toLowerCase().includes(query.toLowerCase()) || p.description.toLowerCase().includes(query.toLowerCase())).map((p) => (
                  <div key={p.id} className="flex items-start justify-between gap-3 rounded-lg border p-3.5">
                    <div className="min-w-0">
                      <div className="text-sm font-medium">{p.name}</div>
                      <div className="text-xs text-muted-foreground">{p.description}</div>
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        <Badge variant="secondary" className="text-[10px]">{p.gender}</Badge>
                        <Badge variant="secondary" className="text-[10px]">{p.basePitchHz} Hz base</Badge>
                        <Badge variant="secondary" className="text-[10px]">breath {(p.breath * 100).toFixed(0)}%</Badge>
                      </div>
                    </div>
                    <Button size="icon" variant="outline" className="h-8 w-8 shrink-0" aria-label={`Preview ${p.name}`}
                      onClick={() => void previewProfile(p.id, p.name)}>
                      {previewing === p.id ? <Volume2 className="h-4 w-4 animate-pulse text-violet-600" /> : <Play className="h-3.5 w-3.5" />}
                    </Button>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </SectionPanel>

      <SectionPanel
        title="Custom voices"
        description="Design your own formant voice — saved in this browser, fully offline, and selectable wherever the built-in profiles are."
        actions={
          <div className="flex items-center gap-1.5">
            <Badge variant="outline" className="border-violet-500/30 text-[10px] text-violet-600">{customProfiles.length} saved</Badge>
            {creatorOpen ? (
              <Button size="sm" variant="ghost" className="h-7" onClick={closeCreator}>Close</Button>
            ) : (
              <Button size="sm" variant="outline" className="h-7 border-violet-500/40 text-violet-600 hover:bg-violet-500/10 hover:text-violet-600" onClick={openCreator} aria-label="Create a custom voice">
                <Plus className="mr-1 h-3.5 w-3.5" />New voice
              </Button>
            )}
          </div>
        }
      >
        <div className="space-y-3">
          {creatorOpen && (
            <div className="rounded-lg border border-violet-500/40 bg-violet-500/5 p-4" aria-label="Custom voice creator">
              <div className="mb-3 flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 text-sm font-medium">
                  <AudioLines className="h-4 w-4 text-violet-600" />
                  {editingId && editingName ? `Editing “${editingName}”` : 'New custom voice'}
                </div>
                {editingId && <Badge variant="outline" className="border-violet-500/40 text-[10px] text-violet-600">editing existing</Badge>}
              </div>

              <div className="grid gap-2 md:grid-cols-[1fr_8rem_8rem]">
                <div className="space-y-1">
                  <Label className="text-xs" htmlFor="custom-voice-name">Name</Label>
                  <Input
                    id="custom-voice-name"
                    value={draft.name}
                    onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                    placeholder="e.g. Midnight Baritone"
                    className="h-7 text-xs"
                    aria-label="Custom voice name"
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Gender</Label>
                  <Select value={draft.gender} onValueChange={(v) => setDraft((d) => ({ ...d, gender: v as VoiceDraft['gender'] }))}>
                    <SelectTrigger className="h-7 text-xs" aria-label="Custom voice gender"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {GENDERS.map((g) => <SelectItem key={g} value={g} className="text-xs">{g}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Language</Label>
                  <Select value={draft.lang} onValueChange={(v) => setDraft((d) => ({ ...d, lang: v }))}>
                    <SelectTrigger className="h-7 text-xs" aria-label="Custom voice language"><SelectValue /></SelectTrigger>
                    <SelectContent className="max-h-64">
                      {CUSTOM_LANGS.map(([code, label]) => <SelectItem key={code} value={code} className="text-xs">{label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="mt-3 grid gap-3 md:grid-cols-3">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">Base pitch</Label>
                    <span className="text-[11px] tabular-nums text-muted-foreground">{Math.round(draft.basePitchHz)} Hz</span>
                  </div>
                  <Slider value={[draft.basePitchHz]} min={60} max={260} step={1}
                    onValueChange={([v]) => setDraft((d) => ({ ...d, basePitchHz: v }))} aria-label="Custom voice base pitch" />
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">Timbre</Label>
                    <span className="text-[11px] tabular-nums text-muted-foreground">{draft.timbre.toFixed(2)}</span>
                  </div>
                  <Slider value={[draft.timbre]} min={0} max={1} step={0.01}
                    onValueChange={([v]) => setDraft((d) => ({ ...d, timbre: v }))} aria-label="Custom voice timbre" />
                </div>
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">Breath</Label>
                    <span className="text-[11px] tabular-nums text-muted-foreground">{(draft.breath * 100).toFixed(0)}%</span>
                  </div>
                  <Slider value={[draft.breath]} min={0} max={1} step={0.01}
                    onValueChange={([v]) => setDraft((d) => ({ ...d, breath: v }))} aria-label="Custom voice breath" />
                </div>
              </div>

              <div className="mt-3 space-y-1">
                <Label className="text-xs" htmlFor="custom-voice-desc">Description</Label>
                <Input
                  id="custom-voice-desc"
                  value={draft.description}
                  onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                  placeholder="Describe the voice in prose — e.g. 'warm elderly male narrator with gravelly texture'"
                  className="h-7 text-xs"
                  aria-label="Custom voice description"
                  autoComplete="off"
                />
                <Button size="sm" variant="outline" className="h-7 mt-1" onClick={async () => {
                  if (!draft.description.trim()) return;
                  const design = await aiDesignVoiceProfile(draft.description);
                  const v = design.value;
                  if (design.ok && v) {
                    setDraft((d) => ({
                      ...d,
                      name: v.name ?? d.name,
                      gender: v.gender ?? d.gender,
                      basePitchHz: v.basePitchHz ?? d.basePitchHz,
                      timbre: v.timbre ?? d.timbre,
                      breath: v.breath ?? d.breath,
                      description: v.description ?? d.description,
                    }));
                    toast({ title: 'AI voice design ready', description: `${v.name} · ${v.gender} · ${v.basePitchHz}Hz` });
                  } else {
                    toast({ title: 'AI design failed', description: design.error ?? 'Try again.', variant: 'destructive' });
                  }
                }}>
                  <Sparkles className="mr-1.5 h-3.5 w-3.5" />Design with AI
                </Button>
              </div>

              {nameMissing && <p className="mt-2 text-[11px] text-rose-600" role="alert">Name is required before saving.</p>}
              {nameTaken && (
                <p className="mt-2 text-[11px] text-amber-600" role="alert">
                  Another custom voice is already named “{draftName}” — saving will keep both.
                </p>
              )}

              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <Button size="sm" variant="outline" className="h-7" onClick={auditionDraft}
                  disabled={customAuditioning === 'custom-preview'} aria-label="Audition current slider values">
                  {customAuditioning === 'custom-preview'
                    ? <Volume2 className="mr-1 h-3.5 w-3.5 animate-pulse text-violet-600" />
                    : <Play className="mr-1 h-3 w-3" />}
                  Audition
                </Button>
                <Button size="sm" className="h-7 bg-violet-600 text-white hover:bg-violet-700" onClick={saveCreator}
                  disabled={!draftName} aria-label={editingId ? 'Save custom voice changes' : 'Save custom voice'}>
                  <CheckCircle2 className="mr-1 h-3.5 w-3.5" />{editingId ? 'Save changes' : 'Save voice'}
                </Button>
                <span className="text-[11px] text-muted-foreground">Audition plays with the current sliders — no need to save first.</span>
              </div>
            </div>
          )}

          {customProfiles.length === 0 && !creatorOpen ? (
            <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              No custom voices yet — click <span className="font-medium text-foreground">New voice</span> to design one.
              Custom voices stay in this browser and work with the network unplugged.
            </div>
          ) : filteredCustom.length === 0 ? (
            <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              No custom voices match “{query}”.
            </div>
          ) : (
            <div className="grid gap-2.5 md:grid-cols-2">
              {filteredCustom.map((p) => (
                <div key={p.id} className={cn('rounded-lg border p-3.5', editingId === p.id && 'border-violet-500/50 bg-violet-500/5')}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 text-sm font-medium">
                        <AudioLines className="h-3.5 w-3.5 shrink-0 text-violet-600" />
                        <span className="truncate">{p.name}</span>
                        <Badge variant="outline" className="h-4 shrink-0 border-violet-500/40 px-1 text-[9px] uppercase tracking-wide text-violet-600">custom</Badge>
                      </div>
                      <div className="truncate text-xs text-muted-foreground">{p.description}</div>
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        <Badge variant="secondary" className="text-[10px]">{p.gender}</Badge>
                        <Badge variant="secondary" className="text-[10px]">{p.basePitchHz} Hz</Badge>
                        <Badge variant="secondary" className="text-[10px]">timbre {p.timbre.toFixed(2)}</Badge>
                        <Badge variant="secondary" className="text-[10px]">breath {(p.breath * 100).toFixed(0)}%</Badge>
                        <Badge variant="secondary" className="text-[10px] uppercase">{p.lang}</Badge>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`Audition ${p.name}`}
                            onClick={() => void auditionProfile(p)}>
                            {customAuditioning === p.id ? <Volume2 className="h-3.5 w-3.5 animate-pulse text-violet-600" /> : <Play className="h-3 w-3" />}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Preview with the current engine</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`Edit ${p.name}`} onClick={() => startEdit(p)}>
                            <Pencil className="h-3 w-3" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Edit</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`Duplicate ${p.name}`} onClick={() => duplicateProfile(p)}>
                            <Copy className="h-3 w-3" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Duplicate</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button size="icon" variant="ghost" className="h-7 w-7 text-rose-600 hover:text-rose-600" aria-label={`Delete ${p.name}`}
                            onClick={() => setDeleteTarget(p)}>
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Delete</TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </SectionPanel>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteTarget?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the custom voice from this browser. Audio already rendered with it is kept, and any view still
              pointing at it falls back to the default built-in profile. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 text-white hover:bg-rose-700 focus-visible:ring-rose-500"
              onClick={confirmDelete}
            >
              Delete voice
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <SectionPanel title="About local voices" description="Where each voice actually comes from.">
        <div className="grid gap-3 text-xs leading-relaxed text-muted-foreground md:grid-cols-3">
          <div className="rounded-lg border bg-muted/30 p-3">
            <div className="mb-1 flex items-center gap-1.5 font-medium text-foreground"><Library className="h-3.5 w-3.5" />OS speech engines</div>
            Every engine in the catalog is your machine&apos;s own speech stack — Windows SAPI 5 / Natural voices, macOS Apple Speech, Linux espeak-ng, plus optional Piper neural voices. The OS bridge (npm run os-tts) renders files with these exact voices. Nothing to download.
          </div>
          <div className="rounded-lg border bg-muted/30 p-3">
            <div className="mb-1 flex items-center gap-1.5 font-medium text-foreground"><Mic2 className="h-3.5 w-3.5" />Voice profiles</div>
            Profiles (built-in and custom) are persona definitions — gender, pitch, timbre. They map deterministically onto real OS voices, so multi-voice books keep a distinct system voice per character. Auditions use the same mapping.
          </div>
          <div className="rounded-lg border bg-muted/30 p-3">
            <div className="mb-1 flex items-center gap-1.5 font-medium text-foreground"><Brain className="h-3.5 w-3.5" />Built-in synth — fallback only</div>
            The AuraVoice formant synthesizer runs in-browser as an emergency engine when no OS engine is reachable. It is intentionally robotic — exports always prefer the established OS engines and say so when they fall back.
          </div>
        </div>
      </SectionPanel>
    </div>
  );
}

/** Synchronous neural filter over an already-loaded list. */
function listNeuralVoicesSync(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice[] {
  const neural = voices.filter((v) => /neural|natural|premium|enhanced|siri/i.test(v.name));
  return neural.length ? neural : voices.filter((v) => v.localService);
}
