export const DESKTOP_COMMAND_CHANNEL = "tibotattle:desktop-command:v1";

export const DESKTOP_COMMAND_NAMES = Object.freeze([
  "refresh",
  "language",
  "hostedSignInReturn",
  "shareCardDownloadCompleted",
  "shareCardDownloadFailed",
]);

const LANGUAGES = Object.freeze(["system", "en", "zh-Hans", "es"]);

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
  if (arguments.length !== 1) throw new TypeError("desktop command is invalid");
  return validateDesktopCommand({ command });
}
