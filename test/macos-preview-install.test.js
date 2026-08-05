import assert from "node:assert/strict";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MACOS_PREVIEW_INSTALL_CODES,
  installMacOSPreviewApp,
  macOSUserApplicationsTarget,
  parseMacOSPreviewInstallArguments,
  requiresMacOSSystemInstallConfirmation,
} from "../scripts/install-macos-preview-app.js";
import { PRODUCT_BRAND } from "../config/product-brand.js";

const PREVIEW_CHANNEL = "preview_distribution";

async function makeFixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "tibotattle-preview-install-")),
  );
  const applications = join(root, "Applications");
  const source = join(root, "build", PRODUCT_BRAND.bundleName);
  const target = join(applications, PRODUCT_BRAND.bundleName);
  await mkdir(join(source, "Contents", "Resources"), { recursive: true });
  await mkdir(join(
    source,
    "Contents",
    "Frameworks",
    "Sparkle.framework",
    "Versions",
    "B",
  ), { recursive: true });
  await writeFile(
    join(
      source,
      "Contents",
      "Frameworks",
      "Sparkle.framework",
      "Versions",
      "B",
      "Autoupdate",
    ),
    "fixture-autoupdate\n",
  );
  await symlink(
    "B",
    join(
      source,
      "Contents",
      "Frameworks",
      "Sparkle.framework",
      "Versions",
      "Current",
    ),
  );
  await symlink(
    "Versions/Current/Autoupdate",
    join(
      source,
      "Contents",
      "Frameworks",
      "Sparkle.framework",
      "Autoupdate",
    ),
  );
  await mkdir(applications, { recursive: true });
  await writeFile(
    join(source, "Contents", "Resources", "fixture.txt"),
    "preview-source\n",
  );
  return {
    applications,
    root,
    source,
    target,
  };
}

async function removeFixture(fixture) {
  await rm(fixture.root, { recursive: true, force: true });
}

function fixtureValidator() {
  return async (path) => {
    const metadata = await lstat(path);
    assert.equal(metadata.isDirectory(), true);
    return {
      appPath: path,
      channel: PREVIEW_CHANNEL,
    };
  };
}

function fixtureOptions(fixture, overrides = {}) {
  return {
    allowedTargetPaths: [fixture.target],
    clock: () => new Date("2026-08-03T19:04:05.006Z"),
    replace: true,
    sourcePath: fixture.source,
    targetPath: fixture.target,
    validator: fixtureValidator(),
    ...overrides,
  };
}

test("preview CLI requires the explicit replacement opt-in", () => {
  assert.throws(
    () => parseMacOSPreviewInstallArguments([
      "--app",
      "/tmp/TiboTattle.app",
      "--target",
      "/Applications/TiboTattle.app",
    ]),
    {
      code: MACOS_PREVIEW_INSTALL_CODES.REPLACE_REQUIRED,
      message: /--replace/u,
    },
  );
});

test("preview CLI requires an unmistakable confirmation before targeting system Applications", () => {
  assert.throws(
    () => parseMacOSPreviewInstallArguments([
      "--app",
      "/tmp/TiboTattle.app",
      "--target",
      "/Applications/TiboTattle.app",
      "--replace",
    ]),
    {
      code: MACOS_PREVIEW_INSTALL_CODES.SYSTEM_INSTALL_CONFIRMATION_REQUIRED,
      message: /--confirm-system-install/u,
    },
  );
  const parsed = parseMacOSPreviewInstallArguments([
    "--app",
    "/tmp/TiboTattle.app",
    "--target",
    "/Applications/TiboTattle.app",
    "--replace",
    "--confirm-system-install",
  ]);
  assert.equal(parsed.confirmSystemInstall, true);
  assert.equal(parsed.targetPath, "/Applications/TiboTattle.app");
  assert.equal(requiresMacOSSystemInstallConfirmation(parsed.targetPath), true);
});

test("the preview installation command includes the required system confirmation", async () => {
  const packageDefinition = JSON.parse(await readFile(
    new URL("../package.json", import.meta.url),
    "utf8",
  ));
  assert.match(
    packageDefinition.scripts["product:macos:preview:install"],
    /--confirm-system-install/u,
  );
});

test("programmatic system installation refuses before it inspects a source", async () => {
  await assert.rejects(
    () => installMacOSPreviewApp({
      allowedTargetPaths: ["/Applications/TiboTattle.app"],
      replace: true,
      sourcePath: "/tmp/TiboTattle.app",
      targetPath: "/Applications/TiboTattle.app",
      validator: fixtureValidator(),
    }),
    {
      code: MACOS_PREVIEW_INSTALL_CODES.SYSTEM_INSTALL_CONFIRMATION_REQUIRED,
      message: /--confirm-system-install/u,
    },
  );
});

test("preview CLI rejects a source with a non-canonical app name", () => {
  assert.throws(
    () => parseMacOSPreviewInstallArguments([
      "--app",
      "/tmp/NotTiboTattle.app",
      "--target",
      "/Applications/TiboTattle.app",
      "--replace",
    ]),
    {
      code: MACOS_PREVIEW_INSTALL_CODES.SOURCE_NAME_INVALID,
      message: new RegExp(PRODUCT_BRAND.bundleName, "u"),
    },
  );
});

test("preview CLI rejects arbitrary destructive targets but exposes safe user Applications", () => {
  assert.throws(
    () => parseMacOSPreviewInstallArguments([
      "--app",
      "/tmp/TiboTattle.app",
      "--target",
      "/tmp/TiboTattle.app",
      "--replace",
    ]),
    {
      code: MACOS_PREVIEW_INSTALL_CODES.TARGET_UNSAFE,
    },
  );
  const parsed = parseMacOSPreviewInstallArguments([
    "--app",
    "/tmp/TiboTattle.app",
    "--user-applications",
    "--replace",
  ], { homeDirectory: "/Users/example" });
  assert.equal(
    parsed.targetPath,
    macOSUserApplicationsTarget("/Users/example"),
  );
});

test("installer stages and activates a preview when the target is absent", async () => {
  const fixture = await makeFixture();
  try {
    const result = await installMacOSPreviewApp(fixtureOptions(fixture));
    assert.equal(result.backupPath, null);
    assert.equal(
      await readFile(join(fixture.target, "Contents", "Resources", "fixture.txt"), "utf8"),
      "preview-source\n",
    );
    assert.deepEqual(
      (await readdir(fixture.applications)).filter((name) =>
        name.startsWith(`.${PRODUCT_BRAND.bundleName}.preview-stage-`)),
      [],
    );
    assert.equal(await readFile(
      join(fixture.source, "Contents", "Resources", "fixture.txt"),
      "utf8",
    ), "preview-source\n");
    assert.equal(
      await readlink(join(
        fixture.target,
        "Contents",
        "Frameworks",
        "Sparkle.framework",
        "Autoupdate",
      )),
      "Versions/Current/Autoupdate",
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("installer moves an existing target to an app-specific timestamped backup", async () => {
  const fixture = await makeFixture();
  try {
    await cp(fixture.source, fixture.target, { recursive: true });
    await writeFile(
      join(fixture.target, "Contents", "Resources", "fixture.txt"),
      "previous-installed-app\n",
    );
    const result = await installMacOSPreviewApp(fixtureOptions(fixture));
    assert.match(
      result.backupPath,
      new RegExp(`${PRODUCT_BRAND.bundleName}\\.backup-2026-08-03T19-04-05-006Z$`, "u"),
    );
    assert.equal(
      await readFile(join(result.backupPath, "Contents", "Resources", "fixture.txt"), "utf8"),
      "previous-installed-app\n",
    );
    assert.equal(
      await readFile(join(fixture.target, "Contents", "Resources", "fixture.txt"), "utf8"),
      "preview-source\n",
    );
    assert.equal((await lstat(result.backupPath)).isSymbolicLink(), false);
  } finally {
    await removeFixture(fixture);
  }
});

test("installer rejects an existing target symlink without touching its referent", async () => {
  const fixture = await makeFixture();
  const realTarget = join(fixture.root, "real-target", PRODUCT_BRAND.bundleName);
  try {
    await mkdir(join(realTarget, "Contents", "Resources"), { recursive: true });
    await writeFile(
      join(realTarget, "Contents", "Resources", "fixture.txt"),
      "untouched\n",
    );
    await rm(fixture.target, { recursive: true, force: true });
    await symlink(realTarget, fixture.target, "dir");
    await assert.rejects(
      installMacOSPreviewApp(fixtureOptions(fixture)),
      { code: MACOS_PREVIEW_INSTALL_CODES.TARGET_SYMLINK },
    );
    assert.equal(await readlink(fixture.target), realTarget);
    assert.equal(
      await readFile(join(realTarget, "Contents", "Resources", "fixture.txt"), "utf8"),
      "untouched\n",
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("installer rejects a symlink collision at the generated backup path", async () => {
  const fixture = await makeFixture();
  const backup = join(
    fixture.applications,
    `${PRODUCT_BRAND.bundleName}.backup-2026-08-03T19-04-05-006Z`,
  );
  try {
    await cp(fixture.source, fixture.target, { recursive: true });
    await writeFile(
      join(fixture.target, "Contents", "Resources", "fixture.txt"),
      "previous-installed-app\n",
    );
    await symlink(fixture.root, backup, "dir");
    await assert.rejects(
      installMacOSPreviewApp(fixtureOptions(fixture)),
      { code: MACOS_PREVIEW_INSTALL_CODES.BACKUP_SYMLINK },
    );
    assert.equal(
      await readFile(join(fixture.target, "Contents", "Resources", "fixture.txt"), "utf8"),
      "previous-installed-app\n",
    );
    assert.equal(await readlink(backup), fixture.root);
  } finally {
    await removeFixture(fixture);
  }
});

test("installer restores the previous app when activation fails", async () => {
  const fixture = await makeFixture();
  try {
    await cp(fixture.source, fixture.target, { recursive: true });
    await writeFile(
      join(fixture.target, "Contents", "Resources", "fixture.txt"),
      "previous-installed-app\n",
    );
    const failingFileSystem = {
      cp,
      lstat,
      mkdir,
      mkdtemp,
      realpath: async (path) => path,
      rename: async (from, to) => {
        if (to === fixture.target
            && from.includes(`.${PRODUCT_BRAND.bundleName}.preview-stage-`)) {
          const error = new Error("injected activation failure");
          error.code = "EIO";
          throw error;
        }
        return rename(from, to);
      },
      rm,
    };
    await assert.rejects(
      installMacOSPreviewApp(fixtureOptions(fixture, {
        fileSystem: failingFileSystem,
      })),
      {
        code: MACOS_PREVIEW_INSTALL_CODES.ACTIVATION_FAILED,
        message: /Could not activate/u,
      },
    );
    assert.equal(
      await readFile(join(fixture.target, "Contents", "Resources", "fixture.txt"), "utf8"),
      "previous-installed-app\n",
    );
    const backups = await readdir(fixture.applications);
    assert.deepEqual(
      backups.filter((name) => name.includes(".backup-")),
      [],
    );
  } finally {
    await removeFixture(fixture);
  }
});
