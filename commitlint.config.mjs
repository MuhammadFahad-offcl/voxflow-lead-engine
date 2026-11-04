/**
 * Commit message rules: Conventional Commits with free-form scopes.
 *
 * Serves: NFR-8, docs/engineering-standards.md §2.
 * Used by: .husky/commit-msg.
 */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'subject-max-length': [2, 'always', 72],
  },
};
