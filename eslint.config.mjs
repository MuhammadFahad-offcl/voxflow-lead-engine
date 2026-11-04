import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import jsdoc from 'eslint-plugin-jsdoc';
import sonarjs from 'eslint-plugin-sonarjs';
import tseslint from 'typescript-eslint';

// The plugin's defaults plus the signatures that have no function body.
const signatureContexts = [
  'ArrowFunctionExpression',
  'FunctionDeclaration',
  'FunctionExpression',
  'TSAbstractMethodDefinition',
  'TSDeclareFunction',
  'TSMethodSignature',
];

export default defineConfig(
  globalIgnores([
    '**/dist/',
    '**/.next/',
    '**/coverage/',
    'apps/web/next-env.d.ts',
    // Linted once Prisma is installed in #5.
    'prisma.config.ts',
  ]),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  sonarjs.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-console': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/ban-ts-comment': 'error',
      // HazelJS modules are empty classes configured by @HazelModule.
      '@typescript-eslint/no-extraneous-class': ['error', { allowWithDecorator: true }],
    },
  },
  {
    // Code comment standard: docs/engineering-standards.md §1.
    files: ['**/*.{ts,tsx}'],
    extends: [jsdoc.configs['flat/recommended-tsdoc-error']],
    rules: {
      'jsdoc/require-jsdoc': [
        'error',
        {
          publicOnly: true,
          require: {
            ArrowFunctionExpression: true,
            ClassDeclaration: true,
            ClassExpression: true,
            FunctionDeclaration: true,
            FunctionExpression: true,
            MethodDefinition: true,
          },
          contexts: [
            // A default-exported function, class or name is checked at its declaration.
            'ExportDefaultDeclaration[declaration.type!=/^(ClassDeclaration|FunctionDeclaration|Identifier)$/]',
            'TSDeclareFunction',
            'TSEnumDeclaration',
            'TSInterfaceDeclaration',
            'TSMethodSignature',
            'TSTypeAliasDeclaration',
            'VariableDeclaration',
          ],
        },
      ],
      // Without this an empty block would satisfy require-jsdoc.
      'jsdoc/require-description': ['error', { contexts: ['any'] }],
      'jsdoc/require-param': ['error', { contexts: signatureContexts }],
      'jsdoc/require-param-description': ['error', { contexts: signatureContexts }],
      'jsdoc/require-param-name': ['error', { contexts: signatureContexts }],
      'jsdoc/require-returns': ['error', { contexts: signatureContexts }],
      'jsdoc/require-returns-description': ['error', { contexts: signatureContexts }],
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
