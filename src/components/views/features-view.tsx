'use client';

import { useMemo, useState } from 'react';
import { FEATURES, FEATURE_CATEGORIES, searchFeatures } from '@/lib/data/features';
import { SectionPanel } from '@/components/widgets/section-panel';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { formatNumber } from '@/lib/utils/format';
import { Braces, CheckCircle2, Cog, Search, SlidersHorizontal } from 'lucide-react';

const STATUS_META = {
  active: { label: 'ready', icon: CheckCircle2, tone: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600' },
  config: { label: 'setting', icon: SlidersHorizontal, tone: 'border-amber-500/30 bg-amber-500/10 text-amber-600' },
  engine: { label: 'engine', icon: Cog, tone: 'border-violet-500/30 bg-violet-500/10 text-violet-600' },
} as const;

function categoryButtonClass(active: boolean) {
  return cn(
    'flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-full border px-3 text-xs transition-colors',
    'hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
    active
      ? 'border-primary bg-primary text-primary-foreground'
      : 'border-border bg-transparent text-muted-foreground hover:text-foreground'
  );
}

export function FeaturesView() {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('all');

  const results = useMemo(() => searchFeatures(query, category), [query, category]);
  const counts = useMemo(() => {
    const active = FEATURES.filter((f) => f.status === 'active').length;
    const config = FEATURES.filter((f) => f.status === 'config').length;
    return { total: FEATURES.length, active, config };
  }, []);

  const categories = useMemo(
    () => [
      { id: 'all', label: 'All', count: FEATURES.length },
      ...FEATURE_CATEGORIES.map((c) => ({ id: c.id, label: c.label, count: c.count })),
    ],
    [],
  );

  return (
    <div className="min-w-0 space-y-4">
      <SectionPanel
        title="Feature Explorer"
        description={`The complete capability registry: ${formatNumber(counts.total)} features — ${counts.active} ready out of the box, ${counts.config} available as settings.`}
        actions={
          <div className="relative w-full sm:w-52">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search features…" className="w-full pl-8" aria-label="Search features" />
          </div>
        }
      >
        {/* Use a real scroll row rather than Radix ToggleGroup: the shared ToggleGroupItem uses flex-1/shrink-0 styling that squeezes long labels into overlapping columns. */}
        <div
          className="feature-category-scroll -mx-1 flex gap-2 overflow-x-auto px-1 pb-2"
          role="group"
          aria-label="Filter features by category"
        >
          {categories.map((c) => (
            <button
              key={c.id}
              type="button"
              aria-pressed={category === c.id}
              onClick={() => setCategory(c.id)}
              className={categoryButtonClass(category === c.id)}
            >
              <span>{c.label}</span>
              <span className={cn(
                'rounded-full px-1.5 py-0.5 text-[10px] leading-none tabular-nums',
                category === c.id ? 'bg-primary-foreground/15 text-primary-foreground' : 'bg-muted text-muted-foreground',
              )}>
                {c.count}
              </span>
            </button>
          ))}
        </div>
      </SectionPanel>

      <SectionPanel title={`${results.length} feature${results.length === 1 ? '' : 's'}`} description={query ? `Matching “${query}”` : 'Scroll or filter by category above.'}>
        <ScrollArea className="max-h-[42rem] pr-3">
          <div className="grid min-w-0 gap-2 md:grid-cols-2">
            {results.map((f) => {
              const meta = STATUS_META[f.status];
              return (
                <div key={f.id} className="group min-w-0 rounded-lg border p-3 transition-colors hover:bg-muted/30">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{f.name}</div>
                      <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70">{f.category}</div>
                    </div>
                    <Badge variant="outline" className={cn('shrink-0 gap-1 text-[10px]', meta.tone)}>
                      <meta.icon className="h-3 w-3" />{meta.label}
                    </Badge>
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{f.description}</p>
                </div>
              );
            })}
          </div>
          {results.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
              <Braces className="h-7 w-7 text-muted-foreground/40" />
              <div className="text-sm text-muted-foreground">No features match that search.</div>
            </div>
          )}
        </ScrollArea>
      </SectionPanel>
    </div>
  );
}