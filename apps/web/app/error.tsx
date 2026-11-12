'use client';
/**
 * The dashboard's error page: shown inside the layout when a page fails, most often because the
 * API is not running. Says what to do and offers a retry.
 *
 * Serves: FR-30, NFR-3 (a failure is shown, not a blank page); issue #16.
 * Used by: Next.js App Router, which renders it for an error thrown by any page below `app/`.
 */
/**
 * Renders the error message.
 *
 * Does not show the error's message: on the server side Next.js replaces it with a digest anyway.
 * @param props - From Next.js.
 * @param props.reset - Renders the page again.
 * @returns The message and a retry button.
 */
export default function ErrorPage({ reset }: Readonly<{ reset: () => void }>) {
  return (
    <main className="mx-auto max-w-6xl px-6 py-8" role="alert">
      <h1 className="text-2xl font-semibold">This page could not load</h1>
      <p className="mt-3">
        Most often the API is not running. Start everything with <code>pnpm dev</code>, then try
        again.
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-4 rounded bg-slate-900 px-4 py-2 text-white"
      >
        Try again
      </button>
    </main>
  );
}
