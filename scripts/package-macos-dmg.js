#!/usr/bin/env node
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PREVIEW_PRODUCT_BRAND,
  PRODUCT_BRAND,
} from "../config/product-brand.js";
import { RELEASE_MANIFEST } from "../config/release-manifest.js";
import { packageMacOSDMG } from "./macos-release-core.js";

const SCRIPT_FILE = fileURLToPath(import.meta.url);

export function parseArguments(argv) {
  let appPath = null;
  let output = null;
  let replace = false;
  let distribution = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--app" && appPath === null && index + 1 < argv.length) {
      appPath = resolve(argv[++index]);
    } else if (argument === "--output"
        && output === null
        && index + 1 < argv.length) {
      output = resolve(argv[++index]);
    } else if (argument === "--replace" && !replace) {
      replace = true;
    } else if ((argument === "--development" || argument === "--preview")
        && distribution === null) {
      distribution = argument.slice(2);
    } else {
      throw new Error(`Unknown or repeated argument: ${argument}`);
    }
  }
  if (!appPath) {
    throw new Error("--app is required");
  }
  if (distribution === null) {
    throw new Error(
      "one explicit non-release mode is required: --development or --preview",
    );
  }
  const productBrand = distribution === "preview"
    ? PREVIEW_PRODUCT_BRAND
    : PRODUCT_BRAND;
  const defaultFileName = `${productBrand.displayName}-${RELEASE_MANIFEST.version}`
    + `-macOS-arm64-${distribution}.dmg`;
  return {
    appPath,
    output: output ?? resolve(
      join(
        ".release-build",
        "macos",
        defaultFileName,
      ),
    ),
    replace,
    distribution,
  };
}

export async function main(argv) {
  const result = await packageMacOSDMG(parseArguments(argv));
  console.log(`TiboTattle ${result.distribution} DMG: built (non-release artifact)`);
  console.log(`Output: ${result.output}`);
  console.log(`SHA-256: ${result.sha256}`);
  console.log(`Bytes: ${result.bytes}`);
  console.log("Release status: ad hoc only; not Developer ID signed, notarized, or update-ready");
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_FILE) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`package-macos-dmg: ${error.message}`);
    process.exitCode = 1;
  });
}
