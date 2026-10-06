'use client';

import { useEffect } from 'react';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

export interface ShortcutRow {
  keys: string[];
  label: string;
  scope: string;
}

export const SHORTCUTS: ShortcutRow[] = [
  // global
  { scope: 'Global', keys: ['⌘', 'K'], label: 'Open command palette' },
  { scope: 'Global', keys: ['?'], label: 'Show this shortcuts panel' },
  { scope: 'Global', keys: ['Alt', '1…9,0'], label: 'Jump to workspace view by number' },
  { scope: 'Global', keys: ['G', 'T'], label: 'Go to TTS Studio (then: W Dialogue · F Files · A Audiobook · V Video · O OCR · R Transcribe · D Dashboard · B Asset Bin · Q Queue · L Voice Library · S Settings · X Feature Explorer)' },
  { scope: 'Global', keys: ['Esc'], label: 'Close dialogs & overlays' },
  // tts studio
  { scope: 'TTS Studio', keys: ['⌘', '⏎'], label: 'Render current text to audio' },
  { scope: 'TTS Studio', keys: ['Space'], label: 'Play / pause rendered output (when not typing)' },
  { scope: 'TTS Studio', keys: ['←', '→'], label: 'Seek rendered output by 2 s' },
  // audiobook
  { scope: 'Audiobook', keys: ['G', 'A'], label: 'Open Audiobook Studio' },
  // queue
  { scope: 'Queue', keys: ['G', 'Q'], label: 'Open Activity & Queue' },
  // video editor
  { scope: 'Video Editor', keys: ['⌘', 'Z'], label: 'Undo project edit (clips, cues, music bed)' },
  { scope: 'Video Editor', keys: ['⇧', '⌘', 'Z'], label: 'Redo project edit' },
];

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border bg-muted px-1 font-mono text-[10px] font-medium text-foreground/80">
      {children}
    </kbd>
  );
}

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  // group rows by scope, preserving order
  const scopes = SHORTCUTS.reduce<Record<string, ShortcutRow[]>>((acc, r) => {
    (acc[r.scope] ??= []).push(r);
    return acc;
  }, {});

  // '?' toggles the panel (unless the user is typing)
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const el = document.activeElement;
        const typing = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el as HTMLElement)?.isContentEditable;
        if (typing) return;
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    const openViaEvent = () => onOpenChange(true);
    document.addEventListener('keydown', down);
    window.addEventListener('auravoice:shortcuts', openViaEvent);
    return () => {
      document.removeEventListener('keydown', down);
      window.removeEventListener('auravoice:shortcuts', openViaEvent);
    };
  }, [open, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Work at the speed of thought — every action stays on this machine.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {Object.entries(scopes).map(([scope, rows]) => (
            <div key={scope}>
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">{scope}</div>
              <div className="space-y-1">
                {rows.map((r, i) => (
                  <div key={i} className={cn('flex items-center justify-between gap-3 rounded-md px-2 py-1.5', i % 2 === 0 && 'bg-muted/40')}>
                    <span className="min-w-0 flex-1 text-xs leading-snug">{r.label}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      {r.keys.map((k, j) => <Kbd key={j}>{k}</Kbd>)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
