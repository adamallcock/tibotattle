export const LOCAL_COMPANION_STATIC_FILES = Object.freeze({
  "/": Object.freeze({
    file: "index.html",
    type: "text/html; charset=utf-8",
  }),
  "/index.html": Object.freeze({
    file: "index.html",
    type: "text/html; charset=utf-8",
  }),
  "/app.js": Object.freeze({
    file: "app.js",
    type: "text/javascript; charset=utf-8",
  }),
  "/community-view.js": Object.freeze({
    file: "community-view.js",
    type: "text/javascript; charset=utf-8",
  }),
  "/data-client.js": Object.freeze({
    file: "data-client.js",
    type: "text/javascript; charset=utf-8",
  }),
  "/install-cta.js": Object.freeze({
    file: "install-cta.js",
    type: "text/javascript; charset=utf-8",
  }),
  "/i18n.generated.js": Object.freeze({
    file: "i18n.generated.js",
    type: "text/javascript; charset=utf-8",
  }),
  "/lib.js": Object.freeze({
    file: "lib.js",
    type: "text/javascript; charset=utf-8",
  }),
  "/navigation.js": Object.freeze({
    file: "navigation.js",
    type: "text/javascript; charset=utf-8",
  }),
  "/telemetry-shared.generated.js": Object.freeze({
    file: "telemetry-shared.generated.js",
    type: "text/javascript; charset=utf-8",
  }),
  "/telemetry-envelope.js": Object.freeze({
    file: "telemetry-envelope.js",
    type: "text/javascript; charset=utf-8",
  }),
  "/ui-format.js": Object.freeze({
    file: "ui-format.js",
    type: "text/javascript; charset=utf-8",
  }),
  "/styles.css": Object.freeze({
    file: "styles.css",
    type: "text/css; charset=utf-8",
  }),
  "/tibotattle-icon.png": Object.freeze({
    file: "tibotattle-icon.png",
    type: "image/png",
  }),
});

export function createLocalCompanionReportRoutes(reportFiles) {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(reportFiles).map(([route, file]) => [
        route,
        Object.freeze({
          file,
          type: "text/html; charset=utf-8",
        }),
      ]),
    ),
  );
}
