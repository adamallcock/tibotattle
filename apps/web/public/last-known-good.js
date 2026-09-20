// Last-known-good payload cache for read-only public data views.
//
// What this is not: it never estimates, interpolates, carries a figure
// forward, smooths a gap, or manufactures continuity. Nothing in here can
// produce a number the service did not publish. It stores one payload that
// genuinely arrived, re-serves that payload verbatim, and reports how old it
// is so the view can say so out loud.
//
// Three states, never two. `resolve` answers `live`, `cached` or
// `unavailable`, and a cached answer always carries both the failure that
// caused it and the moment its payload was last confirmed. A caller cannot
// accidentally collapse a failure into a success, and a reader is never left
// unable to tell current figures from retained ones.
//
// Storage is `localStorage`, per origin and per viewer. `sessionStorage` is
// the wrong tier: it is cleared when the tab closes, so it could only help a
// reader whose fetch fails after an earlier success in the same tab — which
// is the case a refresh controller already covers by leaving the rendered
// payload alone. The case worth covering is the first fetch of a new visit
// failing, and that needs storage which outlives the tab. Every access is
// guarded: the property itself throws in some privacy modes, a read can come
// back absent or unparsable at any time, and a write can throw on quota. None
// of that may reach the page, so every path degrades to "no cache".
//
// Nothing stored here is shared, and nothing is read back by the service. It
// is the viewer's own copy of a public aggregate they were already shown.

export const LAST_KNOWN_GOOD_ENVELOPE_VERSION = "tibotattle-last-known-good-v1";

// One full published allowance window. The community allowance basis is a
// seven-day figure, so beyond seven days a retained estimate no longer
// overlaps any part of the window a reader is asking about, and the daily
// series has lost a week from its head. Past that bound "unavailable" is the
// more truthful answer than a labelled antique, so the entry is discarded
// rather than shown. This is a staleness bound on a viewer-local cache, not a
// retention or display window: no accumulated evidence is dropped anywhere,
// and the service republishes the full year on the next successful fetch.
export const LAST_KNOWN_GOOD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// A full 366-day community daily window with per-day API-equivalent spend and
// the 70-day allowance breakdown block projects to roughly 0.4 MB of JSON, so
// 1 MiB leaves about 2.5x headroom while staying well inside the ~5 MB per
// origin that browsers budget for localStorage. A payload over the bound is
// refused rather than truncated: half a series is not a smaller truth.
export const LAST_KNOWN_GOOD_MAX_BYTES = 1024 * 1024;

/**
 * Failures where the publisher itself answered and took the publication away,
 * as opposed to a transport or availability gap. A cached copy must never
 * stand in for one of these: re-showing a withdrawn publication would put
 * evidence back on the page after its owner removed it.
 *
 * This deliberately matches the invalidation rule in the community refresh
 * controller, which clears a displayed publication on exactly these failures.
 * The two are pinned together by a contract test rather than by an import, so
 * neither module has to depend on the other's transport or storage concerns.
 */
export function isAuthoritativeWithdrawal(failure) {
  return failure?.status === 403
    || failure?.status === 410
    || failure?.code === "PUBLICATION_DISABLED";
}

function browserLocalStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Reading the property itself throws when site data is blocked.
    return null;
  }
}

const textEncoder = typeof TextEncoder === "function" ? new TextEncoder() : null;

function measuredBytes(value) {
  return textEncoder ? textEncoder.encode(value).length : value.length;
}

/**
 * Creates a cache for one caller's payload.
 *
 * - `key` namespaces the entry; each view owns its own and they never share.
 * - `schemaVersion` is the reader's own contract identity. A cached payload
 *   written by a different deploy is refused rather than reinterpreted, so an
 *   older publication can never be rendered under today's meanings.
 * - `project` maps a fetched payload to the exact value worth storing. It is
 *   required, and returning `null` refuses the payload. Callers use it to
 *   store only what their own validator already accepted, so nothing reaches
 *   storage that the page would not have shown.
 * - `servesFailure` decides whether a cached payload may stand in for a given
 *   failure. The default refuses authoritative withdrawals.
 */
export function createLastKnownGoodStore({
  key,
  schemaVersion,
  project,
  storage = browserLocalStorage(),
  now = Date.now,
  maxAgeMs = LAST_KNOWN_GOOD_MAX_AGE_MS,
  maxBytes = LAST_KNOWN_GOOD_MAX_BYTES,
  servesFailure = (failure) => !isAuthoritativeWithdrawal(failure),
} = {}) {
  if (typeof key !== "string" || key.trim() === "") {
    throw new TypeError("A last-known-good store needs a non-empty key.");
  }
  if (typeof schemaVersion !== "string" || schemaVersion.trim() === "") {
    throw new TypeError("A last-known-good store needs a schema version.");
  }
  if (typeof project !== "function") {
    throw new TypeError("A last-known-good store needs a projection function.");
  }
  const storageKey = `tibotattle.last-known-good.${key}.v1`;

  // An absent store is not an error and not a success: it reports the same
  // "no cache" that a refused read or write does, so a caller never believes
  // a payload was retained when nothing was.
  const readEntry = () => {
    if (!storage) return null;
    try {
      const value = storage.getItem(storageKey);
      return typeof value === "string" ? value : null;
    } catch {
      return null;
    }
  };
  const writeEntry = (value) => {
    if (!storage) return false;
    try {
      storage.setItem(storageKey, value);
      return true;
    } catch {
      // Quota, blocked site data, or a storage object that refuses writes.
      return false;
    }
  };

  /** Removes the entry. Blocked storage simply has nothing to remove. */
  function forget() {
    if (!storage) return;
    try {
      storage.removeItem(storageKey);
    } catch {
      // Nothing to do: an unwritable store cannot be holding an entry either.
    }
  }

  /**
   * Stores one payload that genuinely arrived. Every refusal — an empty
   * answer, a projection that declined, an unserializable value, a payload
   * over the size bound, a write the browser rejected — also removes the
   * previous entry. That keeps one invariant a caller can rely on: the cache
   * never holds a payload older than the most recent successful fetch, so a
   * reader cannot later be shown retained figures that were already
   * superseded by figures this browser had in hand.
   */
  function remember(payload) {
    if (payload === null || payload === undefined) {
      forget();
      return false;
    }
    let projected = null;
    try {
      projected = project(payload);
    } catch {
      projected = null;
    }
    if (projected === null || projected === undefined) {
      forget();
      return false;
    }
    let serialized = null;
    try {
      serialized = JSON.stringify({
        envelopeVersion: LAST_KNOWN_GOOD_ENVELOPE_VERSION,
        schemaVersion,
        fetchedAt: new Date(now()).toISOString(),
        payload: projected,
      });
    } catch {
      serialized = null;
    }
    if (typeof serialized !== "string"
        || measuredBytes(serialized) > maxBytes
        || !writeEntry(serialized)) {
      forget();
      return false;
    }
    return true;
  }

  /**
   * Returns the retained payload with its provenance, or null.
   *
   * Entries that can never become valid again — corrupt text, another
   * deploy's envelope or schema, an undatable stamp, an age past the bound —
   * are removed as they are refused, which also reclaims their space. An
   * entry that is merely unusable right now, such as one stamped ahead of a
   * clock that has since moved backwards, is refused but kept: the viewer's
   * clock may be corrected, and deleting real evidence over it would not be.
   */
  function recall() {
    const stored = readEntry();
    if (stored === null) return null;
    let envelope = null;
    try {
      envelope = JSON.parse(stored);
    } catch {
      forget();
      return null;
    }
    if (envelope === null
        || typeof envelope !== "object"
        || Array.isArray(envelope)
        || envelope.envelopeVersion !== LAST_KNOWN_GOOD_ENVELOPE_VERSION
        || envelope.schemaVersion !== schemaVersion
        || typeof envelope.fetchedAt !== "string"
        || envelope.payload === null
        || envelope.payload === undefined) {
      forget();
      return null;
    }
    const fetchedMs = Date.parse(envelope.fetchedAt);
    const nowMs = now();
    if (!Number.isFinite(fetchedMs) || !Number.isFinite(nowMs)) {
      forget();
      return null;
    }
    const ageMs = nowMs - fetchedMs;
    if (ageMs > maxAgeMs) {
      forget();
      return null;
    }
    if (ageMs < 0) return null;
    return { payload: envelope.payload, fetchedAt: envelope.fetchedAt, ageMs };
  }

  /**
   * The three-state answer for one refresh outcome.
   *
   * `live` is what the service just said, including an authoritative empty
   * answer — which clears the cache, because a retained payload must not
   * survive the publication that produced it being taken away. `cached` is a
   * payload this browser holds, with the failure that made it necessary and
   * the age a view is obliged to state. `unavailable` is an honest nothing.
   */
  function resolve({ payload = null, failure = null } = {}) {
    if (failure === null || failure === undefined) {
      remember(payload);
      return { state: "live", payload, failure: null, fetchedAt: null, ageMs: null };
    }
    if (!servesFailure(failure)) {
      forget();
      return { state: "unavailable", payload: null, failure, fetchedAt: null, ageMs: null };
    }
    const cached = recall();
    if (cached === null) {
      return { state: "unavailable", payload: null, failure, fetchedAt: null, ageMs: null };
    }
    return {
      state: "cached",
      payload: cached.payload,
      failure,
      fetchedAt: cached.fetchedAt,
      ageMs: cached.ageMs,
    };
  }

  return { storageKey, remember, recall, forget, resolve };
}
