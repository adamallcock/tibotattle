const path = require("node:path");

const repositoryRoot = path.resolve(__dirname, "../..");
const macDevelopmentIcon = path.join(
  repositoryRoot,
  "apps/macos/Assets/AppIcon.icns",
);
const requestedTarget = process.env.TIBOTATTLE_ELECTRON_TARGET ?? "darwin-arm64";
const targetAliases = {
  darwin: "darwin-arm64",
  macos: "darwin-arm64",
  macOS: "darwin-arm64",
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  windows: "win32-x64",
  win: "win32-x64",
  win32: "win32-x64",
  "win32-x64": "win32-x64",
  linux: "linux-x64",
  "linux-x64": "linux-x64",
};
const target = Object.hasOwn(targetAliases, requestedTarget) ? targetAliases[requestedTarget] : null;
if (!target) {
  throw new Error(
    "TIBOTATTLE_ELECTRON_TARGET must be darwin-arm64, darwin-x64, win32-x64, or linux-x64",
  );
}
const targetSpecs = {
  "darwin-arm64": { platform: "darwin", architecture: "arm64" },
  "darwin-x64": { platform: "darwin", architecture: "x64" },
  "win32-x64": { platform: "win32", architecture: "x64" },
  "linux-x64": { platform: "linux", architecture: "x64" },
};
const targetSpec = targetSpecs[target];
const windowsTarget = target === "win32-x64";
const darwinTarget = targetSpec.platform === "darwin";
const linuxTarget = targetSpec.platform === "linux";
const appDirectory = path.join(
  repositoryRoot,
  ".release-build/electron-dev",
  target,
  "app",
);
const artifactDirectory = path.join(
  repositoryRoot,
  ".release-build/electron-dev",
  target,
  "artifacts",
);

/**
 * Development-only Electron configuration. `build-electron-app.mjs` creates
 * this app directory first; electron-builder is intentionally a later explicit
 * target step. Set TIBOTATTLE_ELECTRON_TARGET to one canonical target triple
 * before invoking electron-builder. This development config does not register
 * the production custom URL scheme, which keeps side-by-side test packages
 * from stealing native app callbacks.
 */
module.exports = {
  appId: "com.adamallcock.tibotattle.electron.dev",
  productName: "TiboTattle Dev",
  directories: {
    app: appDirectory,
    output: artifactDirectory,
  },
  // These patterns run against the exact staged app directory, never the
  // repository checkout. Keep the manually captured native/runtime closure.
  files: [
    {
      from: ".",
      to: ".",
      filter: [
        "package.json",
        "electron-runtime-manifest.json",
        "apps/electron/**",
        "apps/local/**",
        "apps/web/public/**",
        "config/**",
        "contracts/**",
        "native/windows-filesystem/build/Release/windows_filesystem.node",
        "native/windows-filesystem/build/Release/windows_filesystem.node.manifest.json",
        "schemas/**",
        "src/**",
        "generated/**",
      ],
    },
    {
      from: "node_modules",
      to: "node_modules",
      filter: ["**/*"],
    },
  ],
  // Smart unpacking would expand the entire @github/keytar package because
  // it contains a native prebuild. The reviewed artifact contract unpacks
  // only the exact target-specific native files listed below.
  asar: { smartUnpack: false },
  // Only the reviewed, target-specific native runtime is unpacked. The
  // Electron shell and JavaScript companion remain in app.asar.
  asarUnpack: windowsTarget
    ? [
      "node_modules/@github/keytar/prebuilds/win32-x64/keytar.node",
      "native/windows-filesystem/build/Release/windows_filesystem.node",
    ]
    : [
      `node_modules/@github/keytar/prebuilds/${targetSpec.platform === "darwin"
        ? `${targetSpec.platform}-${targetSpec.architecture}`
        : `linux-${targetSpec.architecture}`}/keytar.node`,
    ],
  extraMetadata: {
    main: "apps/electron/main.js",
    name: "app-usagemonitor",
    productName: "TiboTattle Dev",
  },
  forceCodeSigning: false,
  // The staged app deliberately has no lockfile. Returning false from the
  // hook keeps electron-builder from walking the checkout's workspace
  // metadata while npmRebuild still makes its production-dependency phase
  // select this exact staged app directory.
  beforeBuild: () => false,
  npmRebuild: true,
  buildDependenciesFromSource: false,
  nodeGypRebuild: false,
  publish: "never",
};

if (darwinTarget) {
  module.exports.mac = {
    target: [{ target: "dir", arch: [targetSpec.architecture] }],
    icon: macDevelopmentIcon,
    identity: null,
    hardenedRuntime: false,
    gatekeeperAssess: false,
    notarize: false,
  };
}

if (windowsTarget) {
  module.exports.win = {
    target: [{ target: "dir", arch: [targetSpec.architecture] }],
    signAndEditExecutable: false,
    signExecutable: false,
  };
}

if (linuxTarget) {
  module.exports.linux = {
    target: [{ target: "dir", arch: [targetSpec.architecture] }],
    category: "Utility",
    executableName: "tibotattle-dev",
    // Passing an explicit empty list prevents electron-builder 26's legacy
    // AppImage default from adding --no-sandbox to the desktop entry. The
    // packaged runtime still owns the separate refusal path if its launcher
    // supplies that switch because Chromium sandboxing is unavailable.
    executableArgs: [],
  };
}
