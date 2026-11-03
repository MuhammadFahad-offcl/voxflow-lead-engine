/** @type {import('jest').Config} */
export default {
  projects: [
    {
      displayName: 'api',
      rootDir: '<rootDir>/apps/api',
      testEnvironment: 'node',
      testMatch: ['<rootDir>/src/**/*.spec.ts', '<rootDir>/test/**/*.spec.ts'],
      extensionsToTreatAsEsm: ['.ts'],
      // Source imports end in .js (NodeNext); Jest resolves them to the .ts file.
      moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
      transform: {
        '^.+\\.ts$': ['ts-jest', { useESM: true, tsconfig: '<rootDir>/tsconfig.spec.json' }],
      },
    },
  ],
  coverageDirectory: 'coverage',
};
