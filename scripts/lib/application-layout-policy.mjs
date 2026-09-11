const APPLICATION_DEFINITIONS = [
  {
    name: "local",
    root: "apps/local",
    allowedPackages: [
      "accounting",
      "quota-analysis",
      "telemetry-contract",
    ],
  },
  {
    name: "local-review",
    root: "local-review",
    allowedPackages: [],
  },
  {
    name: "macos",
    root: "apps/macos",
    allowedPackages: [],
  },
  {
    name: "web",
    root: "apps/web",
    allowedPackages: [],
  },
  {
    name: "worker",
    root: "apps/worker",
    allowedPackages: [
      "accounting",
      "quota-analysis",
      "telemetry-contract",
    ],
  },
];
const NON_APPLICATION_CONTAINERS = new Set([
  "assets",
  "benchmark",
  "containers",
  "docs",
  "native",
  "packages",
  "schemas",
  "scripts",
  "shared",
  "src",
  "test",
  "tests",
  "tools",
]);

function validateApplicationDefinitions(definitions) {
  const names = new Set();
  const roots = new Set();
  for (const { allowedPackages, name, root } of definitions) {
    const parts = root.split("/");
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)
        || parts.at(-1) !== name
        || parts.some((part) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(part))) {
      throw new Error(`Invalid architecture application identity: ${name}`);
    }
    if ((parts[0] === "apps" && parts.length !== 2)
        || NON_APPLICATION_CONTAINERS.has(parts[0])) {
      throw new Error(`Architecture application root collides with repository layout: ${root}`);
    }
    if (names.has(name) || roots.has(root)) {
      throw new Error(`Duplicate architecture application identity: ${name}`);
    }
    if (new Set(allowedPackages).size !== allowedPackages.length) {
      throw new Error(`Duplicate package permission for application: ${name}`);
    }
    names.add(name);
    roots.add(root);
  }
  for (const root of roots) {
    for (const other of roots) {
      if (root !== other && (root.startsWith(`${other}/`) || other.startsWith(`${root}/`))) {
        throw new Error(`Nested architecture application roots: ${root}, ${other}`);
      }
    }
  }
  return definitions;
}

export const ARCHITECTURE_APPLICATIONS = Object.freeze(
  validateApplicationDefinitions(APPLICATION_DEFINITIONS).map((definition) =>
    Object.freeze({
      ...definition,
      allowedPackages: Object.freeze([...definition.allowedPackages]),
    })),
);

export const ARCHITECTURE_APPLICATION_ROOTS = Object.freeze(
  ARCHITECTURE_APPLICATIONS.map(({ root }) => root).sort(),
);
