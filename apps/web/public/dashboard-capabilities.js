// Presentation permissions are explicit host choices. Companion health and
// desktop DOM markers describe availability; neither authorizes collection.
const READ_ONLY = Object.freeze({
  collection: false,
  settings: false,
  accountlessSharing: false,
});

export function dashboardCapabilities(windowRef = globalThis.window) {
  const bridge = windowRef?.tibotattleDesktop;
  const capabilities = bridge?.dashboardCapabilities;
  if (bridge?.version !== "v1" || capabilities === null
      || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    return READ_ONLY;
  }
  return Object.freeze({
    collection: Object.hasOwn(capabilities, "collection") && capabilities.collection === true,
    settings: Object.hasOwn(capabilities, "settings") && capabilities.settings === true,
    accountlessSharing: Object.hasOwn(capabilities, "accountlessSharing") && capabilities.accountlessSharing === true,
  });
}
