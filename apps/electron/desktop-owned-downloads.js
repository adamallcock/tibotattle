import { randomUUID as defaultRandomUUID } from "node:crypto";
import {
  lstatSync as defaultLstatSync,
} from "node:fs";
import { lstat as defaultLstat, realpath as defaultRealpath } from "node:fs/promises";
import * as defaultPath from "node:path";

import { createDesktopCommand } from "./desktop-command.js";

/**
 * Main-process-only ownership boundary for Electron downloads.
 *
 * A renderer can request the fixed "reveal latest download" action, but it
 * never supplies an identifier or path.  The main process registers a known
 * kind, MIME, and safe filename, receives a generated opaque UUID and an
 * internal destination, and marks that entry completed only after the browser
 * reports the file finished.  Reveal revalidates the registered destination
 * beneath the canonical root immediately before calling the injected reveal
 * port.
 */

export const DESKTOP_OWNED_DOWNLOAD_KINDS = Object.freeze(["share_card"]);
export const DESKTOP_OWNED_DOWNLOAD_MIME_TYPES = Object.freeze(["image/png"]);
export const DESKTOP_OWNED_DOWNLOAD_MAX_FILENAME_BYTES = 120;
export const DESKTOP_OWNED_DOWNLOAD_MAX_ENTRIES = 16;
export const DESKTOP_OWNED_DOWNLOAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export const DESKTOP_SHARE_CARD_FILENAME_PATTERN =
  /^tibotattle-results-TT-[0-9A-HJKMNP-TV-Z]{6}\.png$/u;

const DOWNLOAD_TYPES = Object.freeze({
  share_card: Object.freeze({
    mime: "image/png",
    extension: ".png",
  }),
});
const DOWNLOAD_KIND_SET = new Set(DESKTOP_OWNED_DOWNLOAD_KINDS);
const MIME_SET = new Set(DESKTOP_OWNED_DOWNLOAD_MIME_TYPES);
const RESERVED_DEVICE_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);
const UUID_GENERATION_ATTEMPTS = 8;
const ALLOWED_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,118}[A-Za-z0-9]$/u;

function hasExactKeys(value, keys) {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function assertPlainRecord(value, label) {
  if (value === null
      || typeof value !== "object"
      || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

function invalidDownload(message = "owned download is invalid") {
  return new TypeError(message);
}

function assertExactOptions(options) {
  assertPlainRecord(options, "owned download options");
  const allowed = new Set([
    "rootPath",
    "fs",
    "path",
    "reveal",
    "randomUUID",
    "maxEntries",
  ]);
  if (Reflect.ownKeys(options).some((key) => !allowed.has(key))) {
    throw invalidDownload("owned download options have unexpected fields");
  }
}

function assertDependencies({ rootPath, fs, path, reveal, randomUUID, maxEntries }) {
  if (typeof rootPath !== "string"
      || rootPath.length === 0
      || typeof path?.resolve !== "function"
      || typeof path?.join !== "function"
      || typeof path?.relative !== "function"
      || typeof path?.isAbsolute !== "function"
      || typeof fs?.lstat !== "function"
      || typeof fs?.realpath !== "function"
      || typeof reveal !== "function"
      || typeof randomUUID !== "function"
      || !Number.isSafeInteger(maxEntries)
      || maxEntries < 1
      || maxEntries > DESKTOP_OWNED_DOWNLOAD_MAX_ENTRIES) {
    throw invalidDownload("owned download dependencies are invalid");
  }
  let resolvedRoot;
  try {
    resolvedRoot = path.resolve(rootPath);
  } catch {
    throw invalidDownload("owned download root is invalid");
  }
  if (typeof resolvedRoot !== "string"
      || resolvedRoot.length === 0
      || !path.isAbsolute(resolvedRoot)) {
    throw invalidDownload("owned download root is invalid");
  }
  return resolvedRoot;
}

function assertSynchronousDependencies(fs) {
  if (typeof fs?.lstatSync !== "function") {
    throw invalidDownload("owned download synchronous reservation is unavailable");
  }
  return fs;
}

function assertSafeFilename(value, kind) {
  if (typeof value !== "string"
      || value.length === 0
      || new TextEncoder().encode(value).byteLength
        > DESKTOP_OWNED_DOWNLOAD_MAX_FILENAME_BYTES
      || !ALLOWED_FILENAME_PATTERN.test(value)
      || value.includes("..")) {
    throw invalidDownload("owned download filename is invalid");
  }
  const definition = DOWNLOAD_TYPES[kind];
  if (!definition || !value.toLowerCase().endsWith(definition.extension)) {
    throw invalidDownload("owned download filename does not match its kind");
  }
  const stem = value.slice(0, value.lastIndexOf(".")).toUpperCase();
  if (RESERVED_DEVICE_NAMES.has(stem)) {
    throw invalidDownload("owned download filename is invalid");
  }
  return value;
}

function assertRegistration(value) {
  assertPlainRecord(value, "owned download registration");
  if (!hasExactKeys(value, ["kind", "mime", "filename"])) {
    throw invalidDownload("owned download registration has unexpected fields");
  }
  if (typeof value.kind !== "string" || !DOWNLOAD_KIND_SET.has(value.kind)) {
    throw invalidDownload("owned download kind is invalid");
  }
  if (typeof value.mime !== "string" || !MIME_SET.has(value.mime)) {
    throw invalidDownload("owned download MIME is invalid");
  }
  const definition = DOWNLOAD_TYPES[value.kind];
  if (value.mime !== definition.mime) {
    throw invalidDownload("owned download MIME does not match its kind");
  }
  assertSafeFilename(value.filename, value.kind);
  return Object.freeze({
    kind: value.kind,
    mime: value.mime,
    filename: value.filename,
  });
}

function assertOpaqueId(value) {
  if (typeof value !== "string" || !DESKTOP_OWNED_DOWNLOAD_ID_PATTERN.test(value)) {
    throw invalidDownload("owned download identifier is invalid");
  }
  return value;
}

function isContained(path, root, candidate) {
  let relative;
  try {
    relative = path.relative(root, candidate);
  } catch {
    return false;
  }
  return relative.length > 0
    && !path.isAbsolute(relative)
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !relative.startsWith("../")
    && !relative.startsWith("..\\");
}

function samePath(path, left, right) {
  if (left === right) return true;
  let leftToRight;
  let rightToLeft;
  try {
    leftToRight = path.relative(left, right);
    rightToLeft = path.relative(right, left);
  } catch {
    return false;
  }
  return leftToRight === "" && rightToLeft === "";
}

function regularUnlinkedFile(stats) {
  if (stats === null || typeof stats !== "object") return false;
  try {
    return typeof stats.isFile === "function"
      && typeof stats.isSymbolicLink === "function"
      && stats.isFile() === true
      && stats.isSymbolicLink() === false
      && stats.nlink === 1;
  } catch {
    return false;
  }
}

function ownedDirectory(stats) {
  if (stats === null || typeof stats !== "object") return false;
  try {
    return typeof stats.isDirectory === "function"
      && typeof stats.isSymbolicLink === "function"
      && stats.isDirectory() === true
      && stats.isSymbolicLink() === false;
  } catch {
    return false;
  }
}

function publicEntry(entry) {
  return Object.freeze({
    id: entry.id,
    kind: entry.kind,
    mime: entry.mime,
    filename: entry.filename,
    state: entry.state,
  });
}

function pathForEntry(path, root, entry) {
  let destination;
  try {
    destination = path.join(root, `${entry.id}-${entry.filename}`);
  } catch {
    throw invalidDownload("owned download destination is invalid");
  }
  if (typeof destination !== "string"
      || !path.isAbsolute(destination)
      || !isContained(path, root, destination)) {
    throw invalidDownload("owned download destination is invalid");
  }
  return destination;
}

async function canonicalOwnedRoot({ fs, path, resolvedRoot }) {
  let initial;
  try {
    initial = await fs.lstat(resolvedRoot);
  } catch {
    throw invalidDownload("owned download root is unavailable");
  }
  if (!ownedDirectory(initial)) {
    throw invalidDownload("owned download root is unavailable");
  }
  let canonical;
  try {
    canonical = await fs.realpath(resolvedRoot);
  } catch {
    throw invalidDownload("owned download root is unavailable");
  }
  if (typeof canonical !== "string"
      || canonical.length === 0
      || !path.isAbsolute(canonical)) {
    throw invalidDownload("owned download root is unavailable");
  }
  let canonicalStats;
  try {
    canonicalStats = await fs.lstat(canonical);
  } catch {
    throw invalidDownload("owned download root is unavailable");
  }
  if (!ownedDirectory(canonicalStats)) {
    throw invalidDownload("owned download root is unavailable");
  }
  return canonical;
}

async function assertDestinationAvailable(fs, destination) {
  try {
    await fs.lstat(destination);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw invalidDownload("owned download destination is unavailable");
  }
  throw invalidDownload("owned download destination is unavailable");
}

function assertDestinationAvailableSync(fs, destination) {
  assertSynchronousDependencies(fs);
  try {
    fs.lstatSync(destination);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw invalidDownload("owned download destination is unavailable");
  }
  throw invalidDownload("owned download destination is unavailable");
}

/**
 * Create a main-process-owned download registry after canonicalizing its root.
 * The returned promise rejects with generic fixed errors and never includes
 * the supplied root or any other sensitive path in an error message.
 */
export async function createDesktopOwnedDownloadRegistry(options = {}) {
  assertExactOptions(options);
  const fs = options.fs ?? {
    lstat: defaultLstat,
    realpath: defaultRealpath,
    lstatSync: defaultLstatSync,
  };
  const path = options.path ?? defaultPath;
  const reveal = options.reveal;
  const randomUUID = options.randomUUID ?? defaultRandomUUID;
  const maxEntries = options.maxEntries ?? DESKTOP_OWNED_DOWNLOAD_MAX_ENTRIES;
  const resolvedRoot = assertDependencies({
    rootPath: options.rootPath,
    fs,
    path,
    reveal,
    randomUUID,
    maxEntries,
  });
  const root = await canonicalOwnedRoot({ fs, path, resolvedRoot });
  const entries = new Map();
  let latestCompletedId = null;
  let completionSequence = 0;
  let operation = Promise.resolve();

  function enqueue(run) {
    const next = operation.catch(() => {}).then(run);
    operation = next.catch(() => {});
    return next;
  }

  function removeOldestCompleted() {
    let oldest = null;
    for (const entry of entries.values()) {
      if (entry.state !== "completed") continue;
      if (oldest === null || entry.completedSequence < oldest.completedSequence) {
        oldest = entry;
      }
    }
    if (oldest === null) return false;
    entries.delete(oldest.id);
    if (latestCompletedId === oldest.id) latestCompletedId = null;
    return true;
  }

  function ensureCapacity() {
    while (entries.size >= maxEntries && removeOldestCompleted()) {}
    if (entries.size >= maxEntries) {
      throw invalidDownload("owned download registry is full");
    }
  }

  function generateId() {
    for (let attempt = 0; attempt < UUID_GENERATION_ATTEMPTS; attempt += 1) {
      let candidate;
      try {
        candidate = randomUUID();
      } catch {
        throw invalidDownload("owned download identifier is unavailable");
      }
      if (typeof candidate !== "string"
          || !DESKTOP_OWNED_DOWNLOAD_ID_PATTERN.test(candidate)
          || entries.has(candidate)) {
        continue;
      }
      return candidate;
    }
    throw invalidDownload("owned download identifier is unavailable");
  }

  async function verifyFinal(entry) {
    let before;
    try {
      before = await fs.lstat(entry.destination);
    } catch {
      return null;
    }
    if (!regularUnlinkedFile(before)) return null;
    let canonical;
    try {
      canonical = await fs.realpath(entry.destination);
    } catch {
      return null;
    }
    if (typeof canonical !== "string"
        || !isContained(path, root, canonical)
        || !samePath(path, canonical, entry.destination)) {
      return null;
    }
    let after;
    try {
      after = await fs.lstat(entry.destination);
    } catch {
      return null;
    }
    if (!regularUnlinkedFile(after)) return null;
    let canonicalAfter;
    try {
      canonicalAfter = await fs.realpath(entry.destination);
    } catch {
      return null;
    }
    if (!samePath(path, canonicalAfter, canonical)) return null;
    return Object.freeze({
      canonicalPath: canonical,
      linkCount: 1,
    });
  }

  async function registerDownload(value) {
    return enqueue(async () => {
      const registration = assertRegistration(value);
      ensureCapacity();
      const id = generateId();
      const entry = {
        ...registration,
        id,
        state: "registered",
        destination: pathForEntry(path, root, { id, filename: registration.filename }),
        completedSequence: null,
      };
      await assertDestinationAvailable(fs, entry.destination);
      entries.set(id, entry);
      // The destination is an internal main-process value. Callers must not
      // put it in a renderer response or an IPC payload.
      return Object.freeze({
        id,
        kind: entry.kind,
        mime: entry.mime,
        filename: entry.filename,
        destination: entry.destination,
      });
    });
  }

  /**
   * Reserve a destination synchronously for Electron's will-download event.
   * Electron starts a download after the event listener returns, so an
   * asynchronous registration would allow the item to fall back to the OS
   * Downloads directory before setSavePath() runs.  This method is main
   * process-only and returns the destination solely to its caller.
   */
  function prepareDownload(value) {
    const registration = assertRegistration(value);
    ensureCapacity();
    const id = generateId();
    const entry = {
      ...registration,
      id,
      state: "registered",
      destination: pathForEntry(path, root, { id, filename: registration.filename }),
      completedSequence: null,
    };
    assertDestinationAvailableSync(fs, entry.destination);
    entries.set(id, entry);
    return Object.freeze({
      id,
      kind: entry.kind,
      mime: entry.mime,
      filename: entry.filename,
      destination: entry.destination,
    });
  }

  async function completeDownload(id) {
    return enqueue(async () => {
      const entry = entries.get(assertOpaqueId(id));
      if (!entry || entry.state !== "registered") return false;
      const verified = await verifyFinal(entry);
      if (verified === null) {
        entries.delete(entry.id);
        return false;
      }
      entry.state = "completed";
      entry.completedSequence = ++completionSequence;
      latestCompletedId = entry.id;
      return true;
    });
  }

  async function failDownload(id) {
    return enqueue(async () => {
      const entry = entries.get(assertOpaqueId(id));
      if (!entry || entry.state !== "registered") return false;
      entries.delete(entry.id);
      return true;
    });
  }

  async function revealLatest(...argumentsList) {
    return enqueue(async () => {
      if (argumentsList.length !== 0) {
        throw invalidDownload("reveal does not accept arguments");
      }
      if (latestCompletedId === null) return "none";
      const entry = entries.get(latestCompletedId);
      if (!entry || entry.state !== "completed") {
        latestCompletedId = null;
        return "unavailable";
      }
      const verified = await verifyFinal(entry);
      if (verified === null) {
        entries.delete(entry.id);
        latestCompletedId = null;
        return "unavailable";
      }
      try {
        await reveal(verified.canonicalPath);
      } catch {
        return "unavailable";
      }
      return "revealed";
    });
  }

  function destinationFor(id) {
    const entry = entries.get(assertOpaqueId(id));
    if (!entry) return null;
    return entry.destination;
  }

  function inspect(id) {
    const entry = entries.get(assertOpaqueId(id));
    return entry ? publicEntry(entry) : null;
  }

  function clear() {
    entries.clear();
    latestCompletedId = null;
  }

  return Object.freeze({
    registerDownload,
    prepareDownload,
    completeDownload,
    failDownload,
    revealLatest,
    destinationFor,
    inspect,
    clear,
    get root() {
      return root;
    },
    get size() {
      return entries.size;
    },
    get maxEntries() {
      return maxEntries;
    },
  });
}

function validLoopbackBlobURL(value, origin) {
  if (typeof value !== "string" || typeof origin !== "string") return false;
  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    return false;
  }
  if (parsedOrigin.protocol !== "http:"
      || parsedOrigin.hostname !== "127.0.0.1"
      || parsedOrigin.username !== ""
      || parsedOrigin.password !== ""
      || parsedOrigin.pathname !== "/"
      || parsedOrigin.search !== ""
      || parsedOrigin.hash !== "") {
    return false;
  }
  let blob;
  try {
    blob = new URL(value);
  } catch {
    return false;
  }
  if (blob.protocol !== "blob:"
      || blob.origin !== parsedOrigin.origin
      || blob.search !== ""
      || blob.hash !== "") {
    return false;
  }
  const prefix = `${parsedOrigin.origin}/`;
  if (!blob.pathname.startsWith(prefix) || blob.pathname.length <= prefix.length) {
    return false;
  }
  // A blob URL's pathname contains the inner URL. Reparse it so a malformed
  // value cannot merely share a textual prefix with the trusted origin.
  try {
    const inner = new URL(blob.pathname);
    return inner.origin === parsedOrigin.origin
      && inner.username === ""
      && inner.password === ""
      && inner.search === ""
      && inner.hash === ""
      && inner.pathname.length > 1;
  } catch {
    return false;
  }
}

export function shareCardDownloadMetadata({ origin, url, mime, filename } = {}) {
  if (!validLoopbackBlobURL(url, origin)
      || mime !== "image/png"
      || typeof filename !== "string"
      || !DESKTOP_SHARE_CARD_FILENAME_PATTERN.test(filename)) {
    return null;
  }
  return Object.freeze({
    kind: "share_card",
    mime: "image/png",
    filename,
    url,
  });
}

function cancelRejectedDownload(event, item) {
  try {
    event?.preventDefault?.();
  } catch {
    // A malformed Electron test seam must not expose details or escape.
  }
  try {
    item?.cancel?.();
  } catch {
    // Cancellation is best effort; no registry entry is retained.
  }
}

/**
 * Install one removable, dashboard-only will-download handler. The handler
 * accepts exactly the share-card blob type and never forwards a path,
 * identifier, or save destination to renderer code.
 */
export function installDesktopOwnedDownloadHandler({
  session,
  dashboardWebContents,
  origin,
  registry,
  onState,
} = {}) {
  if (!session || typeof session.on !== "function" || typeof session.off !== "function") {
    throw new TypeError("download session is required");
  }
  if (!dashboardWebContents || typeof dashboardWebContents !== "object") {
    throw new TypeError("dashboard webContents is required");
  }
  if (typeof origin !== "string"
      || typeof registry?.prepareDownload !== "function"
      || typeof registry?.completeDownload !== "function"
      || typeof registry?.failDownload !== "function") {
    throw new TypeError("owned download handler dependencies are invalid");
  }
  if (onState !== undefined && typeof onState !== "function") {
    throw new TypeError("owned download state observer is invalid");
  }

  let active = true;
  const pending = new Map();
  const itemListeners = new Map();

  const notifyState = (command) => {
    if (!active || dashboardWebContents.isDestroyed?.() === true
        || typeof onState !== "function") {
      return;
    }
    try {
      onState(createDesktopCommand(command));
    } catch {
      // State delivery is presentation-only. A consumer failure must never
      // change the registry outcome or escape the Electron event boundary.
    }
  };

  const beginSettlement = (id) => {
    const pendingEntry = pending.get(id);
    if (pendingEntry === undefined || pendingEntry.settling) return false;
    pendingEntry.settling = true;
    const listenerEntry = itemListeners.get(id);
    if (listenerEntry !== undefined) {
      try {
        listenerEntry.item?.off?.("done", listenerEntry.listener);
      } catch {
        // Listener removal is best effort; settlement still owns the
        // registry outcome and must continue to its fixed state signal.
      }
      itemListeners.delete(id);
    }
    return true;
  };

  const settleFailure = async (id, { notify = true } = {}) => {
    if (!beginSettlement(id)) return;
    try {
      await registry.failDownload(id);
    } catch {
      // The registry has already failed closed. Preserve the fixed semantic
      // failure signal without exposing registry errors to Electron.
    } finally {
      pending.delete(id);
      if (notify) notifyState("shareCardDownloadFailed");
    }
  };

  const settleCompletion = async (id) => {
    if (!beginSettlement(id)) return;
    let completed = false;
    try {
      try {
        completed = await registry.completeDownload(id) === true;
      } catch {
        // A completion exception is still a failed accepted download. Attempt
        // cleanup before emitting the fixed failure state.
      }
      if (!completed) {
        // The current registry removes failed verification entries itself, but
        // retain the explicit failure chain for injected or future registries
        // that leave an accepted entry registered after returning false.
        try {
          await registry.failDownload(id);
        } catch {
          // Cleanup is best effort and must not create an unhandled rejection.
        }
      }
    } finally {
      pending.delete(id);
      notifyState(completed
        ? "shareCardDownloadCompleted"
        : "shareCardDownloadFailed");
    }
  };

  const handleDone = (id, item, initialURL, event, state) => {
    if (!pending.has(id)) return;
    let currentURL;
    let currentMime;
    let currentFilename;
    try {
      currentURL = item.getURL();
      currentMime = item.getMimeType();
      currentFilename = item.getFilename();
    } catch {
      void settleFailure(id).catch(() => {});
      return;
    }
    if (!active
        || dashboardWebContents.isDestroyed?.() === true
        || state !== "completed"
        || currentURL !== initialURL
        || shareCardDownloadMetadata({
          origin,
          url: currentURL,
          mime: currentMime,
          filename: currentFilename,
        }) === null) {
      void settleFailure(id).catch(() => {});
      return;
    }
    void settleCompletion(id).catch(() => {});
    void event;
  };

  const onWillDownload = (event, item, webContents) => {
    if (!active || webContents !== dashboardWebContents
        || dashboardWebContents.isDestroyed?.() === true
        || typeof item?.getURL !== "function"
        || typeof item?.getMimeType !== "function"
        || typeof item?.getFilename !== "function"
        || typeof item?.setSavePath !== "function"
        || typeof item?.on !== "function") {
      cancelRejectedDownload(event, item);
      return;
    }
    let initialURL;
    let initialMime;
    let initialFilename;
    try {
      initialURL = item.getURL();
      initialMime = item.getMimeType();
      initialFilename = item.getFilename();
    } catch {
      cancelRejectedDownload(event, item);
      return;
    }
    const metadata = shareCardDownloadMetadata({
      origin,
      url: initialURL,
      mime: initialMime,
      filename: initialFilename,
    });
    if (metadata === null) {
      cancelRejectedDownload(event, item);
      return;
    }
    if (pending.size > 0) {
      // The renderer exposes one share-card save attempt at a time. Keep the
      // first accepted Electron item correlated with its own registry entry;
      // a later event must not become a second attempt whose completion could
      // be mistaken for the first after the renderer has timed out.
      cancelRejectedDownload(event, item);
      notifyState("shareCardDownloadFailed");
      return;
    }
    let registration;
    try {
      registration = registry.prepareDownload({
        kind: metadata.kind,
        mime: metadata.mime,
        filename: metadata.filename,
      });
      const doneListener = (doneEvent, state) => {
        handleDone(registration.id, item, initialURL, doneEvent, state);
      };
      pending.set(registration.id, { settling: false });
      itemListeners.set(registration.id, { item, listener: doneListener });
      item.on("done", doneListener);
      item.setSavePath(registration.destination);
    } catch {
      if (registration?.id !== undefined) {
        void settleFailure(registration.id).catch(() => {});
      }
      cancelRejectedDownload(event, item);
    }
  };

  session.on("will-download", onWillDownload);
  return Object.freeze({
    remove() {
      if (!active) return;
      active = false;
      session.off("will-download", onWillDownload);
      for (const id of pending.keys()) {
        // The item is no longer trusted after the dashboard is torn down.
        // Forget the registry entry even if Electron never emits `done`.
        void settleFailure(id, { notify: false }).catch(() => {});
      }
      itemListeners.clear();
    },
  });
}
