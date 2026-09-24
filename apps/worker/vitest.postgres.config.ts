import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["postgres-test/v12-domain-roundtrip.spec.mjs"],
    fileParallelism: false,
  },
});
