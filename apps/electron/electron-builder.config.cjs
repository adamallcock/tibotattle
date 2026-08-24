const path = require("node:path");

const repositoryRoot = path.resolve(__dirname, "../..");
const macDevelopmentIcon = path.join(
  repositoryRoot,
  "apps/macos/Assets/AppIcon.icns",
);
const requestedTarget = process.env.TIBOTATTLE_ELECTRON_TARGET ?? "darwin";
if (!["darwin", "macos", "win32", "windows", "win"].includes(requestedTarget)) {
  throw new Error("TIBOTATTLE_ELECTRON_TARGET must be darwin or win32");
}
const windowsTarget = ["win32", "windows", "win"].includes(requestedTarget);
const appDirectory = path.join(
  repositoryRoot,
  windowsTarget
    ? ".release-build/electron-dev/windows-x64/app"
    : ".release-build/electron-dev/mac-arm64/app",
);
const artifactDirectory = path.join(
  repositoryRoot,
  windowsTarget
    ? ".release-build/electron-dev/windows-x64/artifacts"
    : ".release-build/electron-dev/artifacts",
);

/**
 * Development-only Electron configuration. `build-electron-app.mjs` creates
 * this app directory first; electron-builder is intentionally a later,
 * explicit `--mac dir --arm64` or `--win dir --x64` step. Set
 * TIBOTATTLE_ELECTRON_TARGET=win32 when packaging the Windows staging tree.
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
    : ["node_modules/@github/keytar/prebuilds/darwin-arm64/keytar.node"],
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
  mac: {
    target: [{ target: "dir", arch: ["arm64"] }],
    icon: macDevelopmentIcon,
    identity: null,
    hardenedRuntime: false,
    gatekeeperAssess: false,
    notarize: false,
    // electron-builder writes this exact URL type to the packaged app's
    // Info.plist. The runtime accepts only the canonical `usagemonitor://open`
    // target; no OAuth or arbitrary URL is registered here.
    protocols: [{
      name: "com.usagemonitor.local.open",
      schemes: ["usagemonitor"],
      role: "Viewer",
    }],
  },
  win: {
    target: [{ target: "dir", arch: ["x64"] }],
    signAndEditExecutable: false,
    signExecutable: false,
  },
};
