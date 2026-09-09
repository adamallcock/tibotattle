// Shared decorative model identity for public charts and local usage tables.
const MODEL_PRESENTATION_ORDER = Object.freeze([
  "gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5",
]);
const MODEL_PRESENTATION_THEMES = Object.freeze([
  "astra", "sol", "terra", "luna", "classic",
]);

// Shared visual identity only. Admin retains its private preview contract and
// renderer; both surfaces use the same ordering, colours and decorative icons.
export function allowanceModelPresentation(modelId, catalogIndex = 0) {
  const preferred = MODEL_PRESENTATION_ORDER.indexOf(modelId);
  return {
    order: preferred < 0 ? MODEL_PRESENTATION_ORDER.length + catalogIndex : preferred,
    theme: preferred < 0 ? null : MODEL_PRESENTATION_THEMES[preferred],
    className: preferred < 0 ? `allowance-series-${catalogIndex % 8}`
      : `allowance-model-${MODEL_PRESENTATION_THEMES[preferred]}`,
  };
}

export function modelUsagePresentation(modelId) {
  if (modelId === "gpt-5.3-codex-spark") return { theme: "spark", className: "allowance-model-spark" };
  const aliases = { "gpt-5.5-codex": "gpt-5.5", "gpt-5.6-sol-wm": "gpt-5.6-sol" };
  return allowanceModelPresentation(aliases[modelId] ?? modelId);
}

export function modelThemeIcon(documentRef, theme) {
  const paths = {
    astra: "M12 3 14.5 9.5 21 12 14.5 14.5 12 21 9.5 14.5 3 12 9.5 9.5Z",
    sol: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1.5 1.5 M17.5 17.5 19 19 M5 19l1.5-1.5 M17.5 6.5 19 5",
    terra: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M4 8h5l2 4-3 2 1 6 M14 4l-1 4 4 2 3-1 M18 14l-3 1-1 5",
    luna: "M19.5 15.5A9 9 0 0 1 8.5 4.5a9 9 0 1 0 11 11Z",
    spark: "M13 2 5 14h6l-1 8 9-13h-6Z",
    classic: "M5 6h14v12H5Z M9 6v12 M5 10h14",
  };
  if (!paths[theme]) return null;
  const icon = documentRef.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [name, value] of Object.entries({ class: "allowance-model-icon", viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false" })) icon.setAttribute(name, value);
  const path = documentRef.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", paths[theme]);
  icon.append(path);
  return icon;
}
