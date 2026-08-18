const path = require("node:path");

const repositoryRoot = path.resolve(__dirname, "../..");

/**
 * Development-only Electron configuration. `build-electron-app.mjs` creates
 * this app directory first; electron-builder is intentionally a later,
 * explicit `--mac dir --arm64` step.
 */
module.exports = {
  appId: "com.adamallcock.tibotattle.electron.dev",
  productName: "TiboTattle Dev",
  directories: {
    app: path.join(repositoryRoot, ".release-build/electron-dev/mac-arm64/app"),
    output: path.join(repositoryRoot, ".release-build/electron-dev/artifacts"),
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
  asar: true,
  asarUnpack: ["**/*.node"],
  extraMetadata: {
    main: "apps/electron/main.js",
    name: "tibotattle-electron-dev",
    productName: "TiboTattle Dev",
  },
  forceCodeSigning: false,
  npmRebuild: false,
  buildDependenciesFromSource: false,
  nodeGypRebuild: false,
  publish: "never",
  mac: {
    target: [{ target: "dir", arch: ["arm64"] }],
    identity: null,
    hardenedRuntime: false,
    gatekeeperAssess: false,
    notarize: false,
  },
};
