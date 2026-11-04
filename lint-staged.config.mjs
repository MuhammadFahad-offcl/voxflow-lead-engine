/**
 * Formats and lints the staged files before each commit.
 *
 * Serves: NFR-8.
 * Used by: .husky/pre-commit.
 */
export default {
  // The two globs must not overlap: lint-staged runs them at the same time.
  // ESLint first: its autofixes can break formatting, and Prettier then has the last word.
  // --no-warn-ignored: a staged file on ESLint's ignore list would otherwise fail --max-warnings 0.
  '*.{ts,tsx,js,mjs,cjs}': ['eslint --fix --max-warnings 0 --no-warn-ignored', 'prettier --write'],
  '*.{json,md,yml,yaml,css}': 'prettier --write',
};
