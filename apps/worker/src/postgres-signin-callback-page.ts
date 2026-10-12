/**
 * The hosted sign-in callback page served by the PostgreSQL identity routes.
 *
 * The markup and headers are byte-identical to the Worker's
 * signInCallbackPage (index.ts) for its two real uses: the completed page and
 * the not-completed page. The page is a fixed template: no script, external
 * asset, or request, provider or user value ever reaches it. The only link is
 * the registered application URL, which carries no OAuth material. The
 * postgres-signin-primitives spec compares these bytes against golden
 * fixtures and against the Worker template itself.
 */

const SIGNIN_CALLBACK_APP_OPEN_URL = "usagemonitor://open";
const SIGNIN_COMPLETED_MESSAGE = "Signed in — return to TiboTattle.";
const SIGNIN_NOT_COMPLETED_MESSAGE =
  "Sign-in was not completed. Return to TiboTattle and start the sign-in again.";

/** The exact response headers of the Worker callback page. */
export const SIGN_IN_CALLBACK_PAGE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "cache-control": "no-store",
  "content-type": "text/html; charset=utf-8",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
});

function signInCallbackPageMarkup(completed: boolean): string {
  const title = completed
    ? "You're signed in"
    : "Sign-in was not completed";
  const message = completed
    ? SIGNIN_COMPLETED_MESSAGE
    : SIGNIN_NOT_COMPLETED_MESSAGE;
  const detail = completed
    ? "TiboTattle is opening now. You can close this browser tab."
    : "No data was uploaded. TiboTattle is reopening so you can try again.";
  const refresh = `<meta http-equiv="refresh" content="${completed ? "0" : "2"}; url=${SIGNIN_CALLBACK_APP_OPEN_URL}">`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refresh}
<title>TiboTattle sign-in</title>
<style>
:root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
* { box-sizing: border-box; }
body { align-items: center; background: #f5f3ec; color: #16211d; display: flex; justify-content: center; margin: 0; min-height: 100vh; padding: 28px; }
main { background: #fffefa; border: 1px solid #d7d5cc; border-radius: 20px; box-shadow: 0 18px 54px rgba(24, 39, 32, .14); max-width: 34rem; padding: 38px; width: 100%; }
.brand { color: #176052; font-size: .78rem; font-weight: 750; letter-spacing: .12em; margin: 0 0 18px; text-transform: uppercase; }
h1 { font-family: ui-serif, Georgia, serif; font-size: clamp(2rem, 7vw, 3.1rem); letter-spacing: -.035em; line-height: 1.04; margin: 0 0 16px; }
p { color: #52625b; font-size: 1rem; line-height: 1.55; margin: 0; }
.action { background: #155f51; border-radius: 11px; color: #fff; display: inline-block; font-weight: 700; margin-top: 28px; padding: 13px 18px; text-decoration: none; }
.hint { color: #718078; font-size: .9rem; margin-top: 16px; }
@media (prefers-color-scheme: dark) { body { background: #16201d; color: #f5f4ed; } main { background: #202b27; border-color: #425048; box-shadow: none; } p { color: #c1cbc4; } .hint { color: #9dab9f; } }
</style>
</head>
<body>
<main>
<p class="brand">TiboTattle</p>
<h1>${title}</h1>
<p>${message}</p>
<p class="hint">${detail}</p>
<a class="action" href="${SIGNIN_CALLBACK_APP_OPEN_URL}">Open TiboTattle</a>
</main>
</body>
</html>
`;
}

/**
 * Render the callback page: HTTP 200 for both outcomes. Only `true` renders
 * the completed page; any other value renders the not-completed page.
 */
export function renderSignInCallbackPage(completed: boolean): Response {
  return new Response(signInCallbackPageMarkup(completed === true), {
    status: 200,
    headers: { ...SIGN_IN_CALLBACK_PAGE_HEADERS },
  });
}
