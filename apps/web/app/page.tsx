/**
 * Dashboard home: the campaigns list is the starting page.
 *
 * Serves: FR-30; issue #16 (replaces the #3 API-status page; the cap banner now says when the API
 * is down).
 * Used by: Next.js App Router, which serves this file at `/`.
 */
import { redirect } from 'next/navigation';

/**
 * Sends the founder to `/campaigns`.
 *
 * Does not return: redirect() ends the render.
 */
export default function HomePage(): never {
  redirect('/campaigns');
}
