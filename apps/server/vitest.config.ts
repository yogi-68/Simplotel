import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Unit + integration. The e2e suite boots a real listening server and runs
    // under its own config so `npm test` stays fast and port-free.
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    globals: false,
    restoreMocks: true,
  },
});
