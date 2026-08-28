// Display-layer branding is TiboTattle; stable machine identifiers deliberately
// stay on the neutral usagemonitor names so a future rename never breaks bundle
// identity, URL-scheme registrations, or existing local state.
const configuredProductBrand = {
  displayName: "TiboTattle",
  bundleName: "TiboTattle.app",
  executableName: "TiboTattle",
  bundleIdentifier: "com.usagemonitor.local",
  appOpenScheme: "usagemonitor",
  appOpenHost: "open",
  appOpenURL: "usagemonitor://open",
  stateDirectoryName: "Usage Monitor",
  // Stable Keychain attributes are an installed-data compatibility contract.
  // Do not rename either value: existing installs already own these items.
  keychainNamespace: "app-usagemonitor",
  keychainAccount: "installation",
  monitoredAppDisplayName: "Codex",
  monitoredAppBundleIdentifier: "com.openai.codex",
};

// Preview builds must never be able to replace or migrate stable application
// state. Keep every macOS registration and storage boundary distinct while
// retaining the same monitored Codex application identity.
const configuredPreviewProductBrand = {
  ...configuredProductBrand,
  displayName: "TiboTattle Preview",
  bundleName: "TiboTattle Preview.app",
  bundleIdentifier: "com.usagemonitor.local.preview",
  appOpenScheme: "usagemonitor-preview",
  appOpenURL: "usagemonitor-preview://open",
  stateDirectoryName: "Usage Monitor Preview",
  keychainNamespace: "app-usagemonitor.preview",
  keychainAccount: "preview-installation",
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

function validateProductBrand(productBrand) {
  requireText("displayName", productBrand.displayName, /^[^/:]{1,80}$/u);
  requireText("bundleName", productBrand.bundleName, /^[^/:]{1,80}\.app$/u);
  requireText(
    "executableName",
    productBrand.executableName,
    /^[A-Za-z][A-Za-z0-9._-]{0,79}$/u,
  );
  requireText(
    "bundleIdentifier",
    productBrand.bundleIdentifier,
    /^(?:[A-Za-z0-9-]+\.)+[A-Za-z0-9-]+$/u,
  );
  requireText(
    "appOpenScheme",
    productBrand.appOpenScheme,
    /^[a-z][a-z0-9+.-]{0,31}$/u,
  );
  requireText(
    "appOpenHost",
    productBrand.appOpenHost,
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u,
  );
  validateStateDirectoryName(productBrand.stateDirectoryName);
  requireText(
    "keychainNamespace",
    productBrand.keychainNamespace,
    /^[a-z][a-z0-9.-]{0,79}$/u,
  );
  requireText(
    "keychainAccount",
    productBrand.keychainAccount,
    /^[a-z][a-z0-9.-]{0,79}$/u,
  );
  requireText(
    "monitoredAppDisplayName",
    productBrand.monitoredAppDisplayName,
    /^[^/:]{1,80}$/u,
  );
  requireText(
    "monitoredAppBundleIdentifier",
    productBrand.monitoredAppBundleIdentifier,
    /^(?:[A-Za-z0-9-]+\.)+[A-Za-z0-9-]+$/u,
  );

  const expectedAppOpenURL =
    `${productBrand.appOpenScheme}://${productBrand.appOpenHost}`;
  if (productBrand.appOpenURL !== expectedAppOpenURL) {
    throw new Error(
      "Invalid product-brand value: appOpenURL must match appOpenScheme and appOpenHost",
    );
  }
  return productBrand;
}

validateProductBrand(configuredProductBrand);
validateProductBrand(configuredPreviewProductBrand);

export const PRODUCT_BRAND = Object.freeze({
  ...configuredProductBrand,
});

export const PREVIEW_PRODUCT_BRAND = Object.freeze({
  ...configuredPreviewProductBrand,
});
