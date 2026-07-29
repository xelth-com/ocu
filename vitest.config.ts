import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Keep the Fastify request logger quiet during tests.
    env: { LOG_LEVEL: "silent" },
  },
});
