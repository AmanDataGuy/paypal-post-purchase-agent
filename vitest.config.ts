/**
 * # vitest.config.ts - test settings
 *
 * - Each DB test boots an embedded Postgres (PGlite) and migrates it, which takes seconds under parallel load.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { testTimeout: 60_000, hookTimeout: 60_000, maxWorkers: 4 },
});
