// Read-only refresh controller. One request at a time, no hidden-tab polling,
// bounded retries, and no storage of public data beyond the page's lifetime.
export function createCommunityRefresh({
  read, publish, visible = () => true,
  schedule = globalThis.setTimeout, cancel = globalThis.clearTimeout,
  intervalMs = 60_000, timeoutMs = 15_000, maxRetryMs = 300_000,
  now = Date.now, minIntervalMs = 15_000,
}) {
  let stopped = true, pending = false, timer = null, controller = null;
  let failures = 0, hasPayload = false;
  let generation = 0, lastStart = -Infinity;
  const clearTimer = () => { if (timer !== null) cancel(timer); timer = null; };
  const refresh = async () => {
    if (stopped || pending || !visible()) return;
    clearTimer();
    const cooldown = minIntervalMs - (now() - lastStart);
    if (cooldown > 0) { timer = schedule(refresh, cooldown); return; }
    lastStart = now();
    const requestGeneration = generation;
    pending = true;
    controller = new AbortController();
    let deadline;
    try {
      const payload = await Promise.race([
        read({ signal: controller.signal }),
        new Promise((_, reject) => { deadline = schedule(() => {
          controller?.abort();
          reject(new Error("Community refresh timed out."));
        }, timeoutMs); }),
      ]);
      if (!stopped && generation === requestGeneration) {
        // Authoritative empty/updating responses replace the old graph: a hard
        // invalidation must not leave withdrawn evidence on an open page.
        publish({ payload, failure: null });
        hasPayload = payload !== null;
        failures = 0;
      }
    } catch (failure) {
      if (!stopped && generation === requestGeneration) {
        failures = Math.min(failures + 1, 4);
        // Network/5xx failures do not erase the displayed publication. Policy
        // refusals are authoritative and must clear it even without a payload.
        if (!hasPayload || failure?.status === 403 || failure?.status === 410 || failure?.code === "PUBLICATION_DISABLED") {
          publish({ payload: null, failure });
          hasPayload = false;
        }
      }
    } finally {
      if (deadline !== undefined) cancel(deadline);
      controller = null;
      pending = false;
      if (!stopped && visible()) timer = schedule(refresh,
        generation !== requestGeneration ? 0 : Math.min(maxRetryMs, intervalMs * 2 ** failures));
    }
  };
  return {
    start() { if (!stopped) return; stopped = false; void refresh(); },
    stop() { stopped = true; generation += 1; clearTimer(); controller?.abort(); },
    visibilityChanged() {
      clearTimer();
      if (!stopped && visible() && !pending) void refresh();
    },
  };
}
