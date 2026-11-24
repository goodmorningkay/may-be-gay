import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./infra/testing/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    env: { NATIVE_GUARDIAN_BIN: process.env.NATIVE_GUARDIAN_BIN || fileURLToPath(new URL("./.native/may-be-guardian", import.meta.url)) },
    include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"],
    clearMocks: true,
    restoreMocks: true,
  },
});
