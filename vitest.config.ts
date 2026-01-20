import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: './src/__tests__/global-setup.ts',
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    // Suppress console.log/warn/error output during tests
    silent: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      exclude: ['node_modules', 'src/__tests__'],
    },
  },
});
