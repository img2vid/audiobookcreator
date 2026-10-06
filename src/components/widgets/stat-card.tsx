'use client';

import { Card, CardContent } from '@/components/ui/card';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export function StatCard({
  title,
  value,
  sub,
  icon: Icon,
  tone = 'default',
  className,
}: {
  title: string;
  value: string | number;
  sub?: string;
  icon: LucideIcon;
  tone?: 'default' | 'emerald' | 'amber' | 'violet' | 'rose';
  className?: string;
}) {
  const tones: Record<string, string> = {
    default: 'bg-primary/10 text-primary',
    emerald: 'bg-emerald-500/10 text-emerald-600',
    amber: 'bg-amber-500/10 text-amber-600',
    violet: 'bg-violet-500/10 text-violet-600',
    rose: 'bg-rose-500/10 text-rose-600',
  };
  return (
    <Card className={cn('py-4', className)}>
      <CardContent className="flex items-center gap-3 px-4">
        <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg', tones[tone])}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-2xl font-semibold tabular-nums leading-tight">{value}</div>
          <div className="truncate text-xs text-muted-foreground">{title}</div>
          {sub && <div className="truncate text-[11px] text-muted-foreground/70">{sub}</div>}
        </div>
      </CardContent>
    </Card>
  );
}
