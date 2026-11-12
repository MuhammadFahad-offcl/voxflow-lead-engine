/**
 * Root layout of the dashboard: the document shell around every page.
 *
 * Serves: FR-30 (its pages render inside this shell, with the navigation), FR-33 (the cap banner),
 * ADR-0001 (issue #3, monorepo scaffold); issue #16.
 * Used by: Next.js App Router, which wraps every page in apps/web/app with this file.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { CapBanner } from './cap-banner';
import './globals.css';

/** Browser tab title for every dashboard page. Next.js reads this export by name. */
export const metadata: Metadata = {
  title: 'VoxFlow Lead Engine',
};

/**
 * Wraps every dashboard page in the shared document shell: navigation, then the cap banner.
 * @param props - Props passed in by Next.js.
 * @param props.children - The page being rendered.
 * @returns The `html` element for the page.
 */
export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body className="bg-slate-50 text-slate-900 antialiased">
        <nav className="border-b bg-white px-6 py-3">
          <Link href="/campaigns" className="mr-6 font-semibold">
            VoxFlow Lead Engine
          </Link>
          <Link href="/campaigns/new" className="text-sm text-slate-700 underline">
            New campaign
          </Link>
        </nav>
        <CapBanner />
        {children}
      </body>
    </html>
  );
}
