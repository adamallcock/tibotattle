import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ENVELOPE_PRIVATE_JWK: "",
          ENVELOPE_PUBLIC_JWK: "",
          TEST_MIGRATIONS: migrations,
        },
      },
    }),
  ],
  test: {
    fileParallelism: false,
  },
});
