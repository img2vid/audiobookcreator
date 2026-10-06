'use client';

import { Card, CardContent } from '@/components/ui/card';
import type { LucideIcon } from 'lucide-react';
import { Cog } from 'lucide-react';

export function ViewPlaceholder({ icon: Icon, title, hint }: { icon: LucideIcon; title: string; hint: string }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
          <Icon className="h-7 w-7 text-primary" />
        </div>
        <div className="text-lg font-semibold">{title}</div>
        <p className="max-w-md text-sm text-muted-foreground">{hint}</p>
        <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground/70">
          <Cog className="h-3.5 w-3.5 animate-spin" style={{ animationDuration: '3s' }} />
          Module warming up…
        </div>
      </CardContent>
    </Card>
  );
}
