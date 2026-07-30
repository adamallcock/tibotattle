const configuredProductBrand = {
  displayName: "Usage Monitor",
  bundleName: "Usage Monitor.app",
  executableName: "UsageMonitor",
  bundleIdentifier: "com.usagemonitor.local",
  appOpenScheme: "usagemonitor",
  appOpenHost: "open",
  appOpenURL: "usagemonitor://open",
  stateDirectoryName: "Usage Monitor",
  monitoredAppDisplayName: "Codex",
  monitoredAppBundleIdentifier: "com.openai.codex",
};

export const SEMANTIC_OPEN_TARGET_PLACEHOLDER =
  "__USAGE_MONITOR_SEMANTIC_OPEN_TARGET__";

function requireText(name, value, pattern) {
  if (typeof value !== "string"
      || value.length === 0
      || value.includes("\0")
      || !pattern.test(value)) {
    throw new Error(`Invalid product-brand value: ${name}`);
  }
}

export function validateStateDirectoryName(value) {
  requireText(
    "stateDirectoryName",
    value,
    /^[^/:]{1,80}$/u,
  );
  if (value === "." || value === "..") {
    throw new Error("Invalid product-brand value: stateDirectoryName");
  }
  return value;
}

requireText(
  "displayName",
  configuredProductBrand.displayName,
  /^[^/:]{1,80}$/u,
);
requireText(
  "bundleName",
  configuredProductBrand.bundleName,
  /^[^/:]{1,80}\.app$/u,
);
requireText(
  "executableName",
  configuredProductBrand.executableName,
  /^[A-Za-z][A-Za-z0-9._-]{0,79}$/u,
);
requireText(
  "bundleIdentifier",
  configuredProductBrand.bundleIdentifier,
  /^(?:[A-Za-z0-9-]+\.)+[A-Za-z0-9-]+$/u,
);
requireText(
  "appOpenScheme",
  configuredProductBrand.appOpenScheme,
  /^[a-z][a-z0-9+.-]{0,31}$/u,
);
requireText(
  "appOpenHost",
  configuredProductBrand.appOpenHost,
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u,
);
validateStateDirectoryName(configuredProductBrand.stateDirectoryName);
requireText(
  "monitoredAppDisplayName",
  configuredProductBrand.monitoredAppDisplayName,
  /^[^/:]{1,80}$/u,
);
requireText(
  "monitoredAppBundleIdentifier",
  configuredProductBrand.monitoredAppBundleIdentifier,
  /^(?:[A-Za-z0-9-]+\.)+[A-Za-z0-9-]+$/u,
);

const expectedAppOpenURL =
  `${configuredProductBrand.appOpenScheme}://`
  + configuredProductBrand.appOpenHost;
if (configuredProductBrand.appOpenURL !== expectedAppOpenURL) {
  throw new Error(
    "Invalid product-brand value: appOpenURL must match appOpenScheme and appOpenHost",
  );
}

export const PRODUCT_BRAND = Object.freeze({
  ...configuredProductBrand,
});
