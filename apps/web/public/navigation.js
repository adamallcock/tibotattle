export function mountDashboardNavigation({
  documentRef,
  windowRef,
  IntersectionObserverRef,
}) {
  function setActiveNavigation(id) {
    for (const link of documentRef.querySelectorAll("[data-nav]")) {
      const active = link.dataset.nav === id;
      link.classList.toggle("active", active);
      if (active) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    }
  }

  const visibleRatios = new Map();
  const observer = new IntersectionObserverRef((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        visibleRatios.set(entry.target, entry.intersectionRatio);
      } else {
        visibleRatios.delete(entry.target);
      }
    }
    const visible = [...visibleRatios.entries()]
      .sort((left, right) => right[1] - left[1])[0];
    if (!visible) return;
    setActiveNavigation(visible[0].id);
  }, {
    rootMargin: "-25% 0px -65% 0px",
    threshold: [0, .2, .7],
  });
  for (
    const section of documentRef.querySelectorAll(
      ".dashboard-section, [data-nav-target]",
    )
  ) {
    observer.observe(section);
  }

  function syncNavigationFromHash() {
    const id = windowRef.location.hash.slice(1);
    if (!id) return;
    if (["community", "history", "backend"].includes(id)) {
      documentRef.querySelector("#community-contribution-disclosure").open = true;
    }
    setActiveNavigation(id);
  }

  windowRef.addEventListener("hashchange", syncNavigationFromHash);
  syncNavigationFromHash();

  return () => {
    observer.disconnect();
    visibleRatios.clear();
    windowRef.removeEventListener("hashchange", syncNavigationFromHash);
  };
}
