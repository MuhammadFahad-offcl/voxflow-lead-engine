'use client';
/**
 * Re-renders the campaign page from the server every 10 seconds while work is in flight, keeping
 * open rows and half-typed filters (a full reload would lose both).
 *
 * Serves: US-14 ("watch it progress"), FR-30; issue #16.
 * Used by: apps/web/app/campaigns/[id]/page.tsx.
 */
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

const EVERY_MS = 10_000;

/**
 * Starts the refresh timer while `active`, and stops it when the page moves on or work ends.
 * @param props - Whether to refresh.
 * @param props.active - True while the campaign runs or a lead on the page waits for the worker.
 * @returns Nothing visible.
 */
export function AutoRefresh({ active }: Readonly<{ active: boolean }>) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => {
      router.refresh();
    }, EVERY_MS);
    return () => {
      clearInterval(timer);
    };
  }, [active, router]);
  return null;
}
