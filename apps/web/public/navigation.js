const PAGE_BY_TARGET = new Map([
  ["overview", "overview"],
  ["weekly", "weekly"],
  ["accounting", "weekly"],
  ["coverage", "weekly"],
  ["timeline", "trends"],
  ["community", "community"],
  ["history", "data"],
  ["backend", "data"],
  ["data", "data"],
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

  function setPage(page) {
    if (!pages.some((element) => element.dataset.dashboardPage === page)) {
      return false;
    }
    activePage = page;
    for (const element of pages) {
      element.hidden = element.dataset.dashboardPage !== page;
    }
    for (const link of links) {
      const active = link.dataset.nav === page;
      link.classList.toggle("active", active);
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    return true;
  }

  function syncNavigationFromHash() {
    const target = targetFromHash(windowRef);
    if (["community", "history", "backend"].includes(target)) {
      const disclosure = documentRef.querySelector(
        "#community-contribution-disclosure",
      );
      if (disclosure) disclosure.open = true;
    }
    setPage(PAGE_BY_TARGET.get(target) ?? activePage ?? "overview");
  }

  function navigate(event) {
    const link = event.currentTarget;
    const page = link.dataset.nav;
    if (!setPage(page)) return;
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
