import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // `obsidian` is an ambient API the app injects — esbuild marks it external and it does
      // not exist as an importable module at test time. The alias supplies the handful of
      // runtime values the engine actually uses; the *types* still come from the real
      // `obsidian` package via tsc, so a mock that drifts from the API still fails typecheck.
      obsidian: fileURLToPath(new URL('./src/test/obsidian.ts', import.meta.url)),
    },
  },
});
