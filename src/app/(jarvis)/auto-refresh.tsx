'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

// Re-runs the server component every minute while the tab is visible; Argo pushes every 5 min.
export function AutoRefresh({ everyMs = 60_000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') router.refresh();
    }, everyMs);
    return () => clearInterval(id);
  }, [router, everyMs]);
  return null;
}
