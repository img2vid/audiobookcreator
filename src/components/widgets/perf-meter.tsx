'use client';

import { useEffect, useRef, useState } from 'react';
import { Activity } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

interface PerfSample {
  fps: number;
  heapMB?: number;
}

/** Real-time main-thread responsiveness meter (proves the no-freeze architecture). */
export function PerfMeter() {
  const [sample, setSample] = useState<PerfSample>({ fps: 60 });
  const frames = useRef(0);
  const last = useRef(performance.now());

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      frames.current++;
      const now = performance.now();
      if (now - last.current >= 1000) {
        const fps = Math.round((frames.current * 1000) / (now - last.current));
        frames.current = 0;
        last.current = now;
        const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
        setSample({ fps, heapMB: mem ? mem.usedJSHeapSize / 1048576 : undefined });
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const color = sample.fps >= 50 ? 'text-emerald-600' : sample.fps >= 30 ? 'text-amber-600' : 'text-rose-600';

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium tabular-nums">
            <Activity className={`h-3.5 w-3.5 ${color}`} />
            <span className={color}>{sample.fps} FPS</span>
            {sample.heapMB != null && (
              <span className="text-muted-foreground hidden sm:inline">· {sample.heapMB.toFixed(0)} MB</span>
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p className="text-xs">Main-thread responsiveness monitor. Chunked processing keeps this green even during hour-long conversions.</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
