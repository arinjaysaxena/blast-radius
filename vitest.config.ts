import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.{js,ts}'],
    exclude: ['test/e2e/**', 'node_modules/**'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
