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
  modelId = typeof modelId === "string" ? modelId.trim().toLowerCase() : "";
  if (modelId === "gpt-5.3-codex-spark") return { theme: "spark", className: "allowance-model-spark" };
  if (modelId === "codex-auto-review") return { theme: "review", className: "allowance-model-review" };
  if (/^(?:gpt|codex)-.*\b(?:mini|nano)\b/.test(modelId)) {
    return { theme: "mini", className: "allowance-model-mini" };
  }
  const numberedThemes = {
    "5.4": "layers", "5.3": "grid", "5.2": "box", "5.1": "folder",
    "5": "chip", "4.1": "book", "4o": "rings", "4": "file",
  };
  const numbered = /^gpt-(5\.4|5\.3|5\.2|5\.1|5|4\.1|4o|4)(?:-|$)/.exec(modelId);
  if (numbered) return { theme: numberedThemes[numbered[1]], className: "allowance-model-classic" };
  const aliases = { "gpt-5.5-codex": "gpt-5.5", "gpt-5.6-sol-wm": "gpt-5.6-sol" };
  const presentation = allowanceModelPresentation(aliases[modelId] ?? modelId);
  return presentation.theme ? presentation : { theme: "generic", className: "allowance-model-classic" };
}

export function modelThemeIcon(documentRef, theme) {
  const paths = {
    astra: "M12 3 14.5 9.5 21 12 14.5 14.5 12 21 9.5 14.5 3 12 9.5 9.5Z",
    sol: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1.5 1.5 M17.5 17.5 19 19 M5 19l1.5-1.5 M17.5 6.5 19 5",
    terra: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M4 8h5l2 4-3 2 1 6 M14 4l-1 4 4 2 3-1 M18 14l-3 1-1 5",
    luna: "M19.5 15.5A9 9 0 0 1 8.5 4.5a9 9 0 1 0 11 11Z",
    spark: "M13 2 5 14h6l-1 8 9-13h-6Z",
    classic: "M5 6h14v12H5Z M9 6v12 M5 10h14",
    review: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M7.5 12l3 3 6-6",
    mini: "M8 8h8v8H8Z M10 5v3 M14 5v3 M10 16v3 M14 16v3 M5 10h3 M5 14h3 M16 10h3 M16 14h3",
    layers: "M3 8l9-5 9 5-9 5Z M3 12l9 5 9-5 M3 16l9 5 9-5",
    grid: "M4 4h6v6H4Z M14 4h6v6h-6Z M4 14h6v6H4Z M14 14h6v6h-6Z",
    box: "M4 7l8-4 8 4v10l-8 4-8-4Z M4 7l8 4 8-4 M12 11v10",
    folder: "M3 7V5h6l2 2h10v12H3Z",
    chip: "M6 6h12v12H6Z M9 3v3 M15 3v3 M9 18v3 M15 18v3 M3 9h3 M3 15h3 M18 9h3 M18 15h3",
    book: "M12 6C9 4 6 4 3 5v14c3-1 6-1 9 1 3-2 6-2 9-1V5c-3-1-6-1-9 1Z M12 6v14",
    rings: "M9 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14 M15 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14",
    file: "M6 3h8l4 4v14H6Z M14 3v5h4 M9 12h6 M9 16h6",
    generic: "M12 3l8 4.5v9L12 21l-8-4.5v-9Z M12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4",
  };
  if (!paths[theme]) return null;
  const icon = documentRef.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [name, value] of Object.entries({ class: "allowance-model-icon", viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false" })) icon.setAttribute(name, value);
  const path = documentRef.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", paths[theme]);
  icon.append(path);
  return icon;
}
