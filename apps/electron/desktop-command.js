export const DESKTOP_COMMAND_CHANNEL = "tibotattle:desktop-command:v1";

export const DESKTOP_COMMAND_NAMES = Object.freeze([
  "refresh",
  "language",
  "appearance",
  "sidebar",
  "hostedSignInReturn",
  "shareCardDownloadCompleted",
  "shareCardDownloadFailed",
]);

const LANGUAGES = Object.freeze(["system", "en", "zh-Hans", "es"]);
const APPEARANCES = Object.freeze(["system", "light", "dark"]);

function plainExactObject(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/**
 * Validate the entire main-to-renderer command vocabulary. These commands can
 * only update the dashboard's own presentation; they confer no main-process
 * capability and accept no paths, URLs, selectors, or executable strings.
 */
export function validateDesktopCommand(value) {
  if (value?.command === "refresh" && plainExactObject(value, ["command"])) {
    return Object.freeze({ command: "refresh" });
  }
  if (value?.command === "language"
      && plainExactObject(value, ["command", "value"])
      && LANGUAGES.includes(value.value)) {
    return Object.freeze({ command: "language", value: value.value });
  }
  if (value?.command === "sidebar"
      && plainExactObject(value, ["command", "collapsed"])
      && typeof value.collapsed === "boolean") {
    return Object.freeze({ command: "sidebar", collapsed: value.collapsed });
  }
  if (value?.command === "appearance"
      && plainExactObject(value, ["command", "preference", "resolvedTheme"])
      && APPEARANCES.includes(value.preference)
      && (value.resolvedTheme === "light" || value.resolvedTheme === "dark")) {
    return Object.freeze({
      command: "appearance",
      preference: value.preference,
      resolvedTheme: value.resolvedTheme,
    });
  }
  if (value?.command === "hostedSignInReturn"
      && plainExactObject(value, ["command"])) {
    return Object.freeze({ command: "hostedSignInReturn" });
  }
  if (value?.command === "shareCardDownloadCompleted"
      && plainExactObject(value, ["command"])) {
    return Object.freeze({ command: "shareCardDownloadCompleted" });
  }
  if (value?.command === "shareCardDownloadFailed"
      && plainExactObject(value, ["command"])) {
    return Object.freeze({ command: "shareCardDownloadFailed" });
  }
  throw new TypeError("desktop command is invalid");
}

export function createDesktopCommand(command, value) {
  if (command === "language") {
    if (arguments.length !== 2) throw new TypeError("desktop command is invalid");
    return validateDesktopCommand({ command, value });
  }
  if (command === "sidebar") {
    if (arguments.length !== 2 || typeof value !== "boolean") {
      throw new TypeError("desktop command is invalid");
    }
    return validateDesktopCommand({ command, collapsed: value });
  }
  if (command === "appearance") {
    if (arguments.length !== 3) throw new TypeError("desktop command is invalid");
    return validateDesktopCommand({
      command,
      preference: value,
      resolvedTheme: arguments[2],
    });
  }
  if (arguments.length !== 1) throw new TypeError("desktop command is invalid");
  return validateDesktopCommand({ command });
}
