import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    globals: false,
    fileParallelism: false,
    testTimeout: 30000,
    setupFiles: ["./src/setup-vitest.ts"],
  },
});
