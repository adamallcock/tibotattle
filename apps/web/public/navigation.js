const PAGE_BY_TARGET = new Map([
  ["overview", "overview"],
  ["weekly", "weekly"],
  ["accounting", "method"],
  ["method", "method"],
  ["timeline", "trends"],
  ["trends", "trends"],
  ["community", "community"],
  ["history", "community"],
  ["backend", "community"],
  ["data", "community"],
]);

function targetFromHash(windowRef) {
  return decodeURIComponent(windowRef.location.hash.slice(1));
}

/**
 * Keeps the dashboard's major areas as real pages.  The old scroll-spy made
 * every section appear to be a destination, which was awkward in a desktop
 * app and could leave people lost halfway down a long technical report.
 */
export function mountDashboardNavigation({ documentRef, windowRef }) {
  const links = [...documentRef.querySelectorAll("[data-nav]")];
  const pages = [...documentRef.querySelectorAll("[data-dashboard-page]")];
  let activePage = null;

  function focusPageHeading(page) {
    const heading = pages
      .find((element) => element.dataset.dashboardPage === page)
      ?.querySelector?.("h1, h2");
    if (!heading) return;
    heading.setAttribute?.("tabindex", "-1");
    heading.focus?.({ preventScroll: true });
  }

  function setPage(page, { focusHeading = false } = {}) {
    if (!pages.some((element) => element.dataset.dashboardPage === page)) {
      return false;
    }
    activePage = page;
    for (const element of pages) {
      const inactive = element.dataset.dashboardPage !== page;
      element.classList.toggle("dashboard-page-inactive", inactive);
      element.inert = inactive;
      if (inactive) element.setAttribute("aria-hidden", "true");
      else element.removeAttribute("aria-hidden");
    }
    for (const link of links) {
      const active = link.dataset.nav === page;
      link.classList.toggle("active", active);
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    if (focusHeading) focusPageHeading(page);
    return true;
  }

  function syncNavigationFromHash() {
    const target = targetFromHash(windowRef);
    if (["history", "backend"].includes(target)) {
      const disclosure = documentRef.querySelector(
        "#community-contribution-disclosure",
      );
      if (disclosure) disclosure.open = true;
    }
    const hadActivePage = activePage !== null;
    const page = PAGE_BY_TARGET.get(target) ?? activePage ?? "overview";
    if (setPage(page, { focusHeading: hadActivePage }) && hadActivePage) {
      windowRef.scrollTo?.({ top: 0, behavior: "instant" });
    }
  }

  function navigate(event) {
    const link = event.currentTarget;
    const page = link.dataset.nav;
    if (!setPage(page, { focusHeading: true })) return;
    event.preventDefault();
    const hash = link.getAttribute("href") ?? `#${page}`;
    if (windowRef.location.hash !== hash) {
      windowRef.history?.pushState?.({}, "", hash);
    }
    windowRef.scrollTo?.({ top: 0, behavior: "instant" });
  }

  for (const link of links) link.addEventListener("click", navigate);
  windowRef.addEventListener("hashchange", syncNavigationFromHash);
  windowRef.addEventListener("popstate", syncNavigationFromHash);
  syncNavigationFromHash();

  return () => {
    for (const link of links) link.removeEventListener("click", navigate);
    windowRef.removeEventListener("hashchange", syncNavigationFromHash);
    windowRef.removeEventListener("popstate", syncNavigationFromHash);
  };
}
