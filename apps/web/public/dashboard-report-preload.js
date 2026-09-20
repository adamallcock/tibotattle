// Separate reports share the dashboard's startup lifecycle without delaying
// its first paint. Each report owns its bounded cache, requests and cancellation.
export function createDashboardReportPreloader({
  reports,
  windowRef = window,
  documentRef = document,
}) {
  let enabled = false, destroyed = false, timer = null;
  function queue() {
    if (!enabled || destroyed || timer !== null || documentRef.visibilityState === "hidden") return;
    timer = windowRef.setTimeout(() => {
      timer = null;
      if (destroyed || documentRef.visibilityState === "hidden") return;
      for (const report of reports) {
        // One unavailable report must not block its sibling or primary content.
        void Promise.resolve().then(() => {
          if (!destroyed && documentRef.visibilityState !== "hidden") return report.preload();
        }).catch(() => {});
      }
    }, 250);
  }
  function visibilityChanged() {
    if (documentRef.visibilityState === "hidden") {
      windowRef.clearTimeout(timer);
      timer = null;
    } else queue();
  }
  documentRef.addEventListener("visibilitychange", visibilityChanged);
  return {
    schedule() { enabled = true; queue(); },
    destroy() {
      destroyed = true;
      windowRef.clearTimeout(timer);
      timer = null;
      documentRef.removeEventListener("visibilitychange", visibilityChanged);
    },
  };
}
