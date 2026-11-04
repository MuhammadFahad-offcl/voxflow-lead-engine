/**
 * Root layout of the dashboard: the document shell around every page.
 *
 * Serves: ADR-0001, NFR-8 (issue #3, monorepo scaffold). The FR-30 pages will render inside it.
 * Used by: Next.js App Router, which wraps every page in apps/web/app with this file.
 */
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

/** Browser tab title for every dashboard page. Next.js reads this export by name. */
export const metadata: Metadata = {
  title: 'VoxFlow Lead Engine',
};

/**
 * Wraps every dashboard page in the shared document shell.
 *
 * Does not fetch data or add navigation: each page owns its own content.
 * @param props - Props passed in by Next.js.
 * @param props.children - The page being rendered.
 * @returns The `html` element for the page.
 */
export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body className="bg-slate-50 text-slate-900 antialiased">{children}</body>
    </html>
  );
}
