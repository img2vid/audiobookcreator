'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { ReactNode } from 'react';

export function SectionPanel({
  title,
  description,
  actions,
  children,
  className,
  contentClassName,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <Card className={cn('relative gap-4', className)}>
      <div className="panel-hairline absolute inset-x-6 top-0" aria-hidden />
      <CardHeader className="flex flex-row items-start justify-between space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-base">{title}</CardTitle>
          {description && <CardDescription className="text-xs">{description}</CardDescription>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </CardHeader>
      <CardContent className={contentClassName}>{children}</CardContent>
    </Card>
  );
}
