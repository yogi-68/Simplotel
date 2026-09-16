import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/e2e/**/*.test.ts'],
    globals: false,
    testTimeout: 30_000,
    // One file, sequential: it binds a real port.
    fileParallelism: false,
  },
});
