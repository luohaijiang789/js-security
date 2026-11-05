import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    // Real HTTP/Chromium acceptance includes process startup and durable disk I/O.
    // Product request deadlines and fault-injection assertions remain independent.
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
