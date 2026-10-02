import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["postgres-test/community-allowance-rich-days.spec.mjs"],
    fileParallelism: false,
  },
});
