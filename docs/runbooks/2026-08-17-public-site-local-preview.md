---
title: TiboTattle public-site local preview
date: 2026-08-17
type: runbook
status: maintained
---

# TiboTattle public-site local preview

Use this command to visually review checked-out public-site changes without
hand-serving `apps/web/public/community.html`. It first runs the reviewed
public release-site generator into a temporary directory and serves that
generated output on loopback. The temporary directory is removed when the
preview stops.

## Start a preview

From the repository root:

```sh
npm run product:release-site:preview
```

The command prints a `http://127.0.0.1:<port>/` URL. Open that URL in a
browser, then press `Ctrl+C` in the terminal to stop the server and remove its
temporary output. Port `0` is the default, so parallel previews do not collide.
Choose a stable port only when it is useful for a browser tool or another local
workflow:

```sh
npm run product:release-site:preview -- --port 4175
```

The default preview performs these bounded, read-only remote requests to the
reviewed production public origin from `config/deployment-endpoints.js`:

1. `GET /` to read the **already published** installer and link metadata, so
   the proposed generated page can display the current real download card.
2. `GET /api/v1/community/daily?from=…&to=…` when the page asks for the
   released aggregate community series.

The proxy accepts only that exact aggregate `GET`, only canonical `from` and
`to` day parameters, and only from the configured public HTTPS origin. It does
not forward browser cookies, authorization, request headers, local dashboard
data, or any `/api/local/` request. Every local response is `no-store` and
labels its mode with the `X-TiboTattle-Preview` response header.

## Offline, generator-only review

For layout, typography, or responsive work that does not need the current
public release card or community figures, use:

```sh
npm run product:release-site:preview -- --offline
```

Offline mode makes no network request. It deliberately has no published
installer metadata, so the download CTA remains unavailable and the aggregate
community endpoint responds with a visible unavailable state. That is expected:
it prevents a local preview from silently inventing release metadata or sample
community data.

## Preview another reviewed public origin

The optional upstream override accepts only a public HTTPS origin (no local
host, port, path, query, or credentials):

```sh
npm run product:release-site:preview -- \
  --upstream https://reviewed-public-origin.example
```

Use it only for a reviewed, intentionally public origin. It is not a way to
serve a development Worker or a private endpoint; those should use their own
purpose-built tests.

## What this proves—and what it does not

The preview proves that the checked-out source can pass the public-site
generator and that its generated HTML/CSS/JS renders locally. In default mode
it also makes it easy to compare that generated source with the current public
release metadata and aggregate series.

It does **not** prove that a candidate DMG is signed, notarized, available at
the shown URL, or matches its displayed digest; it does not deploy or upload
anything; and it does not prove the live website has the checked-out source.
Those remain separate release and deployed-site checks. Treat the remote
metadata and aggregate response as display inputs for visual review only.

## Troubleshooting and maintenance checks

- If the default mode says published metadata is invalid or unavailable, do
  not substitute values by hand. Check the public homepage separately, or use
  `--offline` while the release metadata issue is investigated.
- If the aggregate chart says the preview upstream is unavailable, the layout
  is still generated correctly; the proxy intentionally returns a bounded
  error instead of falling back to mock data.
- If a selected fixed port is in use, omit `--port` or choose another port.
- Verify the preview contract after changing its server, generator integration,
  or metadata parsing:

  ```sh
  node --test test/public-release-site-preview.test.js
  npm run product:release-site:test
  ```

The test fixture uses no live network data. It verifies source generation,
metadata validation, loopback-only asset serving, the narrowly scoped aggregate
proxy, offline behavior, and cleanup of the temporary output.
