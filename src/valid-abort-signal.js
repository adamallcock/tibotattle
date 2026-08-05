export function validAbortSignal(signal) {
  return signal === null
    || (typeof signal === "object"
      && typeof signal.aborted === "boolean"
      && typeof signal.addEventListener === "function");
}
