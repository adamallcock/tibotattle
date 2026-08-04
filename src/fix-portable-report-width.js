#!/usr/bin/env node

import { chmod, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  localLegacyReportPath,
} from "./local-legacy-report-storage.js";

const STYLE = `<style data-app-usagemonitor-width-fix>
@media screen{
html,body{width:100%!important;max-width:100%!important;overflow-x:hidden!important}
.portable-page-header,.analytics-top-bar{width:100%!important;max-width:100%!important;margin-right:0!important;margin-left:0!important}
#data-analytics-portable-reader,#data-analytics-portable-reader-root,.portable-fallback{max-width:100%!important;min-width:0!important}
}
</style>`;

export function applyPortableWidthFix(html) {
  if (typeof html !== "string" || !html.includes("</head>")) {
    throw new Error("Portable report must contain a closing head element");
  }
  const prior = /<style data-app-usagemonitor-width-fix>[\s\S]*?<\/style>/;
  if (prior.test(html)) return html.replace(prior, STYLE);
  const legacy = /<style>\s*@media screen(?: and \(min-width:761px\))?\{\.portable-page-header,\.analytics-top-bar\{width:100%!important;margin-right:0!important;margin-left:0!important\}\}\s*<\/style>/;
  if (legacy.test(html)) return html.replace(legacy, STYLE);
  return html.replace("</head>", `${STYLE}\n</head>`);
}

async function main() {
  const target = process.argv[2]
    ? resolve(process.argv[2])
    : localLegacyReportPath(
      process.cwd(),
      "2026-07-24-codex-work-account-usage-report.html",
    );
  const html = await readFile(target, "utf8");
  await writeFile(target, applyPortableWidthFix(html), "utf8");
  await chmod(target, 0o600);
  console.log(`Portable width fix applied to ${target}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
