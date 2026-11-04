/**
 * PostCSS config: runs Tailwind CSS for the dashboard's styles.
 *
 * Serves: FR-30 (issue #3, monorepo scaffold).
 * Used by: Next.js, which loads this file when it builds apps/web.
 */

export default {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};
