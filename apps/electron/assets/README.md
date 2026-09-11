# Electron Windows artwork

`tibotattle.ico` is a format conversion of the existing approved
[`tibotattle-icon.png`](../../web/public/tibotattle-icon.png), matching the macOS
icon and Linux/web artwork. No artwork was redrawn. Rights and permission are
recorded in [the application icon provenance](../../macos/Assets/AppIcon.provenance.txt).

The Windows release configuration explicitly selects this file for the executable
and the default NSIS installer/uninstaller icons. The ICO contains 32-bit PNG
frames at 16, 24, 32, 48, 64, 128 and 256 pixels.

Generate it from the repository root after the locked dependency installation:

```sh
node --input-type=module <<'JS'
import { createRequire } from "node:module";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
const appBuilderRequire = createRequire(builderRequire.resolve("app-builder-lib/package.json"));
const outDir = await mkdtemp(join(tmpdir(), "tibotattle-windows-icon-"));
try {
  const result = await appBuilderRequire("./out/util/iconConverter").convertIcon({
    sources: [resolve("apps/web/public/tibotattle-icon.png")],
    fallbackSources: [], roots: [process.cwd()], format: "ico", outDir,
  });
  if (result.isFallback || result.icons.length !== 1) throw new Error("Icon conversion failed");
  await copyFile(result.icons[0].file, "apps/electron/assets/tibotattle.ico");
} finally {
  await rm(outDir, { recursive: true });
}
JS
```

This reuses electron-builder 26.15.7's icon converter and its checksum-pinned
`icons@1.2.1` tool bundle; no separate image dependency is introduced. The
converter may download that public tool bundle when its cache is empty.

Generated source SHA-256: `482c5876243f8e24485add7e61d6dd20312f81109c9e5e4c9229cfd12c56c879`.
Generated ICO SHA-256: `08bd419ed2fb1e645fcd61b3dc17a63b688f0e826aa79fa9fcd69ada6469623f`.

Run the focused Windows release-config tests after regeneration. The tracked ICO
avoids requiring icon conversion or a new artwork download during signing.
