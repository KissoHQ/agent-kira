import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The test database of the business core, then the agent of the tests, which uses it.
    globalSetup: ["@request-agent/core/testing/global-setup", "./test/global-setup.ts"],
    // Test files share one database that is emptied before each test, and one agent, so they must
    // not run in parallel.
    fileParallelism: false,
  },
});
