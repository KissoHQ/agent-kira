import { defineConfig } from "vitest/config";

// The measure of the agent with the real model (pnpm eval:agent), kept apart from the tests.
export default defineConfig({
  test: {
    include: ["eval/**/*.eval.ts"],
    // The measure takes from minutes to hours, depending on the machine that runs Ollama.
    testTimeout: 24 * 60 * 60 * 1000,
  },
});
