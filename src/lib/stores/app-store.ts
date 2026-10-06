'use client';

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type {
  ActivityEvent,
  ActivityKind,
  AssetItem,
  PCProfile,
  QueueJob,
  SubtitleCue,
  TranscriptChapter,
  TunedSettings,
  VideoProject,
  ViewId,
  VoiceProfileDef,
} from '@/lib/types';
import { uid } from '@/lib/utils/async';
import { autoTune } from '@/lib/engines/autotune';
import { registerCustomProfiles } from '@/lib/engines/formant';
import {
  putStoredAsset,
  deleteStoredAsset,
  clearStoredAssets,
  listStoredAssets,
  blobFromUrl,
  type StoredAssetRecord,
} from '@/lib/engines/asset-db';

export interface AppSettings {
  gpuAcceleration: boolean;
  fallbackMode: boolean; // force non-AI TTS
  autoFallback: boolean; // auto-switch if AI TTS fails
  autoTune: boolean; // auto-adjust from PC profile
  ocrPowerOverride: 'auto' | 'lite' | 'standard' | 'heavy' | 'ultra';
  preferredModelId: string;
  localAiModelId: string;
  preferredVoiceURI: string;
  outputFormat: string; // AudioFormatId
  sampleRate: number;
  channels: 1 | 2;
  notifications: boolean;
  longSessionGuard: boolean;
  telemetryLocal: boolean;
  highContrast: boolean;
  reducedMotion: boolean;
  // AI assistance settings
  aiAssist: boolean;
  aiDepth: 'light' | 'standard' | 'deep';
  aiAssistOcr: boolean;
  aiAssistTranscript: boolean;
  aiAssistTts: boolean;
  aiAssistFiles: boolean;
  aiAssistAssets: boolean;
  aiAssistVideo: boolean;
  aiAssistDialogue: boolean;
  aiAssistVoices: boolean;
}

export interface EngineStatus {
  ttsEngine: 'ai' | 'fallback' | 'error' | 'idle';
  lastError?: string;
  fallbackReason?: string;
  systemVoices: number;
}

interface AppState {
  // navigation
  view: ViewId;
  setView: (v: ViewId) => void;

  // persisted: hardware + settings
  pcProfile: PCProfile;
  setPcProfile: (patch: Partial<PCProfile>) => void;
  resetPcProfile: () => void;
  settings: AppSettings;
  setSetting: <K extends keyof AppSettings>(k: K, v: AppSettings[K]) => void;
  tuned: TunedSettings;
  retune: () => void;

  // runtime: asset bin (blobs mirrored to IndexedDB so the bin survives reloads)
  assets: AssetItem[];
  assetsRestored: boolean;
  restoreAssets: () => Promise<void>;
  addAsset: (a: AssetItem) => void;
  updateAsset: (id: string, patch: Partial<AssetItem>) => void;
  removeAsset: (id: string) => void;
  clearAssets: () => void;

  // runtime: job mirror
  jobs: QueueJob[];
  syncJob: (job: QueueJob) => void;
  removeJob: (id: string) => void;
  /**
   * Manually reorder the QUEUED section of the jobs array (drag & drop /
   * Alt+Arrow in the Queue view). The array is NEWEST-FIRST; this moves only
   * the dragged queued row and re-inserts it immediately before (placeBefore)
   * or after the target queued row, leaving every other row (running, paused,
   * done…) in its existing position. No-op unless BOTH ids exist and both
   * rows have status 'queued' — pump() picks the array-tail queued job as the
   * next natural run, so this directly rewrites the run order.
   */
  reorderQueuedJobs: (dragId: string, targetId: string, placeBefore: boolean) => void;

  // engine status
  engine: EngineStatus;
  setEngine: (patch: Partial<EngineStatus>) => void;

  // cross-module text handoff (OCR → TTS, File → TTS)
  pendingText: string | null;
  pendingTextMeta: string | null;
  setPendingText: (text: string | null, meta?: string) => void;

  // cross-module asset handoff (Asset Bin → Video Editor soundtrack)
  pendingSoundtrackAssetId: string | null;
  setPendingSoundtrackAssetId: (id: string | null) => void;

  // cross-module cue handoff (OCR Lab → Video Editor subtitle track)
  pendingSubtitleCues: SubtitleCue[] | null;
  setPendingSubtitleCues: (cues: SubtitleCue[] | null) => void;

  // cross-module chapter handoff (Transcribe Studio → Audiobook Studio)
  pendingTranscriptChapters: TranscriptChapter[] | null;
  setPendingTranscriptChapters: (chapters: TranscriptChapter[] | null) => void;

  // cross-module project handoff (AutoBook → Video Editor)
  pendingVideoProject: VideoProject | null;
  setPendingVideoProject: (p: VideoProject | null) => void;

  // persisted: user-created formant voice profiles (mirrored into the formant engine)
  customProfiles: VoiceProfileDef[];
  addCustomProfile: (p: VoiceProfileDef) => void;
  updateCustomProfile: (id: string, patch: Partial<VoiceProfileDef>) => void;
  removeCustomProfile: (id: string) => void;

  // persisted: activity log (feeds the Dashboard "Weekly activity" chart)
  /** NEWEST-FIRST event log, capped at 500. Default [] — SSR-safe. */
  activityEvents: ActivityEvent[];
  /** Prepend an activity event; dedupes identical kind+label within 1500 ms. */
  logActivity: (kind: ActivityKind, label: string) => void;
}

export const DEFAULT_PC_PROFILE: PCProfile = {
  cpuBrand: 'intel',
  cpuGeneration: '',
  cpuModel: '',
  customCpu: { clockGhz: 3.4, cores: 8, threads: 16 },
  gpuEnabled: false,
  gpuBrand: 'nvidia',
  gpuGeneration: '',
  gpuModel: '',
  customGpu: { vramGB: 8, teraflops: 15 },
  ramGB: 16,
  storage: 'nvme',
  os: 'windows',
};

export const DEFAULT_SETTINGS: AppSettings = {
  gpuAcceleration: false,
  fallbackMode: false,
  autoFallback: true,
  autoTune: true,
  ocrPowerOverride: 'auto',
  preferredModelId: '',
  localAiModelId: 'smollm2-135m-instruct',
  preferredVoiceURI: '',
  outputFormat: 'wav-16',
  sampleRate: 44100,
  channels: 1,
  notifications: true,
  longSessionGuard: true,
  telemetryLocal: true,
  highContrast: false,
  reducedMotion: false,
  aiAssist: true,
  aiDepth: 'light',
  aiAssistOcr: true,
  aiAssistTranscript: true,
  aiAssistTts: true,
  aiAssistFiles: true,
  aiAssistAssets: true,
  aiAssistVideo: true,
  aiAssistDialogue: true,
  aiAssistVoices: true,
};

const FALLBACK_TUNED: TunedSettings = {
  score: 50,
  tier: 'mid',
  ocrPower: 'standard',
  ocrMaxPixels: 2_000_000,
  ocrThreads: 4,
  ttsThreads: 4,
  ttsBatchSize: 4,
  ttsChunkChars: 2000,
  synthesisQuality: 'balanced',
  cacheMB: 256,
  ioBufferKB: 512,
  queueConcurrency: 2,
  videoExportPreset: 'balanced',
  gpuOffload: false,
  notes: ['Default profile — configure your PC in Settings for auto-tuning.'],
};

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      view: 'dashboard',
      setView: (v) => set({ view: v }),

      pcProfile: DEFAULT_PC_PROFILE,
      setPcProfile: (patch) => {
        set((s) => ({ pcProfile: { ...s.pcProfile, ...patch } }));
        if (get().settings.autoTune) get().retune();
      },
      resetPcProfile: () => {
        set({ pcProfile: DEFAULT_PC_PROFILE });
        if (get().settings.autoTune) get().retune();
      },

      settings: DEFAULT_SETTINGS,
      setSetting: (k, v) => {
        set((s) => ({ settings: { ...s.settings, [k]: v } }));
        if (k === 'autoTune' && v === true) get().retune();
        if (k === 'ocrPowerOverride') get().retune();
      },

      tuned: FALLBACK_TUNED,
      retune: () => {
        try {
          const tuned = autoTune(get().pcProfile, get().settings);
          set({ tuned });
        } catch {
          // specs-db not ready yet — keep fallback
        }
      },

      assets: [],
      assetsRestored: false,
      restoreAssets: async () => {
        if (get().assetsRestored) return;
        try {
          const rows = await listStoredAssets();
          const restored: AssetItem[] = rows.map((r) => ({
            id: r.id,
            name: r.name,
            kind: r.kind,
            createdAt: r.createdAt,
            mimeType: r.mimeType,
            sizeBytes: r.sizeBytes,
            durationSec: r.durationSec,
            text: r.text,
            width: r.width,
            height: r.height,
            meta: { ...(r.meta ?? {}), restored: true },
            blobUrl: r.blob ? URL.createObjectURL(r.blob) : undefined,
          }));
          set((s) => {
            const known = new Set(s.assets.map((a) => a.id));
            return {
              assets: [...s.assets, ...restored.filter((r) => !known.has(r.id))]
                .sort((a, b) => b.createdAt - a.createdAt)
                .slice(0, 200),
              assetsRestored: true,
            };
          });
        } catch {
          set({ assetsRestored: true });
        }
      },
      addAsset: (a) => {
        set((s) => ({ assets: [a, ...s.assets].slice(0, 200) }));
        get().logActivity('asset-added', a.name);
        // mirror to IndexedDB (best-effort, never blocks the UI)
        void (async () => {
          try {
            const rec: StoredAssetRecord = {
              id: a.id,
              name: a.name,
              kind: a.kind,
              createdAt: a.createdAt,
              mimeType: a.mimeType,
              sizeBytes: a.sizeBytes,
              durationSec: a.durationSec,
              text: a.text,
              width: a.width,
              height: a.height,
              meta: a.meta,
            };
            if (a.blobUrl) rec.blob = await blobFromUrl(a.blobUrl);
            await putStoredAsset(rec);
          } catch { /* best-effort */ }
        })();
      },
      updateAsset: (id, patch) =>
        set((s) => ({
          assets: s.assets.map((a) => (a.id === id ? { ...a, ...patch } : a)),
        })),
      removeAsset: (id) => {
        const victim = get().assets.find((a) => a.id === id);
        set((s) => {
          const v = s.assets.find((a) => a.id === id);
          if (v?.blobUrl) URL.revokeObjectURL(v.blobUrl);
          return { assets: s.assets.filter((a) => a.id !== id) };
        });
        if (victim) get().logActivity('asset-removed', victim.name);
        void deleteStoredAsset(id);
      },
      clearAssets: () => {
        set((s) => {
          for (const a of s.assets) if (a.blobUrl) URL.revokeObjectURL(a.blobUrl);
          return { assets: [] };
        });
        void clearStoredAssets();
      },

      jobs: [],
      syncJob: (job) =>
        set((s) => {
          const idx = s.jobs.findIndex((j) => j.id === job.id);
          if (idx === -1) return { jobs: [job, ...s.jobs].slice(0, 300) };
          const jobs = [...s.jobs];
          jobs[idx] = job;
          return { jobs };
        }),
      removeJob: (id) => set((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) })),
      reorderQueuedJobs: (dragId, targetId, placeBefore) =>
        set((s) => {
          const dragIdx = s.jobs.findIndex((j) => j.id === dragId);
          const targetIdx = s.jobs.findIndex((j) => j.id === targetId);
          if (dragIdx === -1 || targetIdx === -1 || dragIdx === targetIdx) return s;
          // Only queued rows may be reordered — running/paused/finished rows keep their position.
          if (s.jobs[dragIdx].status !== 'queued' || s.jobs[targetIdx].status !== 'queued') return s;
          const jobs = [...s.jobs];
          jobs.splice(dragIdx, 1);
          let insertAt = jobs.findIndex((j) => j.id === targetId);
          if (!placeBefore) insertAt += 1;
          jobs.splice(insertAt, 0, s.jobs[dragIdx]);
          return { jobs };
        }),

      engine: { ttsEngine: 'idle', systemVoices: 0 },
      setEngine: (patch) => set((s) => ({ engine: { ...s.engine, ...patch } })),

      pendingText: null,
      pendingTextMeta: null,
      setPendingText: (text, meta) => set({ pendingText: text, pendingTextMeta: meta ?? null }),

      pendingSoundtrackAssetId: null,
      setPendingSoundtrackAssetId: (id) => set({ pendingSoundtrackAssetId: id }),

      pendingSubtitleCues: null,
      setPendingSubtitleCues: (cues) => set({ pendingSubtitleCues: cues }),

      pendingTranscriptChapters: null,
      setPendingTranscriptChapters: (chapters) => set({ pendingTranscriptChapters: chapters }),

      pendingVideoProject: null,
      setPendingVideoProject: (p) => set({ pendingVideoProject: p }),

      customProfiles: [],
      addCustomProfile: (p) =>
        set((s) => (s.customProfiles.some((c) => c.id === p.id) ? s : { customProfiles: [...s.customProfiles, p] })),
      updateCustomProfile: (id, patch) =>
        set((s) => ({
          customProfiles: s.customProfiles.map((c) => (c.id === id ? { ...c, ...patch } : c)),
        })),
      removeCustomProfile: (id) =>
        set((s) => ({ customProfiles: s.customProfiles.filter((c) => c.id !== id) })),

      activityEvents: [],
      logActivity: (kind, label) =>
        set((s) => {
          const now = Date.now();
          // Spam guard: identical kind+label within 1.5 s is dropped.
          if (s.activityEvents.some((e) => e.kind === kind && e.label === label && now - e.at < 1500)) return s;
          const event: ActivityEvent = { id: uid('act'), at: now, kind, label };
          return { activityEvents: [event, ...s.activityEvents].slice(0, 500) };
        }),
    }),
    {
      name: 'openmukti-studio-v1',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        pcProfile: s.pcProfile,
        settings: s.settings,
        tuned: s.tuned,
        customProfiles: s.customProfiles,
        activityEvents: s.activityEvents,
      }),
    },
  ),
);

// Mirror the persisted custom-profile set into the formant engine's registry so
// synthesis (and the queue worker) resolves custom voice ids even before any view
// mounts — including right after a reload with queued renders. Identity guard keeps
// this cheap: the array is replaced immutably, so re-registering only happens when
// the set actually changed (persist rehydrate, add/update/remove). Pure JS — SSR-safe.
let lastRegisteredProfiles: VoiceProfileDef[] | null = null;
useAppStore.subscribe((s) => {
  if (s.customProfiles !== lastRegisteredProfiles) {
    lastRegisteredProfiles = s.customProfiles;
    registerCustomProfiles(s.customProfiles);
  }
});
