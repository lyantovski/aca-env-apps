import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["server/**/*.test.ts"], testTimeout: 15000, fileParallelism: false },
});
