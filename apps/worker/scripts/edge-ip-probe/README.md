# Edge IP probe

An owner-run, throwaway probe of what Cloudflare's network and Google's front
end deliver to a Cloud Run service when a Worker fetches it the way the thin
edge does: `x-real-ip` overwritten with Cloudflare's Worker placeholder
`2a06:98c0:3600::103` (`EDGE_SUBREQUEST_REAL_IP` in
[`src/edge-google-subrequest.ts`](../../src/edge-google-subrequest.ts)). It
answers one question: does any header carrying the visitor's address reach
the origin?

Nothing in CI or in any npm script deploys or calls it.
`npm run edge:e2e:check` only syntax-checks both files and runs the offline
classification check, `echo-server.check.mjs`. Deploying and calling the probe
are protected operations: a GCP write and a Cloudflare write, each needing the
owner's authorization.

The 2026-10-02 result, from a `workers.dev` Worker, is in the
[edge receipt](../../../../docs/receipts/2026-10-01-gcp-edge-proxy-local.md#cloudflare-network-address-probe).
The decision it informs is OD-E6 in the
[thin Worker edge proxy decision record](../../../../docs/decisions/2026-10-01-thin-worker-edge-proxy.md#5-client-address-privacy).

| File | Role |
|---|---|
| `probe-worker.mjs` | The throwaway Worker. `GET /probe` reads the inbound `CF-Connecting-IP`, makes a fresh random salt, and fetches `ECHO_URL` with `x-real-ip` set to the placeholder, `x-probe-salt` and `x-probe-visitor-hash` (SHA-256 of salt plus address). Every other path is 404 |
| `echo-server.mjs` | The temporary Cloud Run echo. It answers with the sorted header names and, for each address-like name, four fields: `equalsPlaceholder`, `containsPlaceholder`, `containsVisitor` and `tokenCount` |
| `wrangler.example.jsonc` | The probe Worker's configuration, with `ECHO_URL` as a placeholder |
| `echo-server.check.mjs` | Offline check of the echo's classification, with documentation-range addresses only |

## Privacy design: no values leave

- The visitor's address never leaves the Worker. Only a salted hash travels,
  with a salt that is new for every request.
- The echo returns header names, booleans and token counts. It never returns,
  logs or stores a header value, the salt or the hash. The Worker returns
  `visitorSeenByWorker` (a boolean) and the echo's answer, nothing else.
- The salted hash keeps the address out of transit, the response and logs. It
  is not anonymization against whoever sees the salt and the hash, the echo's
  operator: an IPv4 address can be recovered by enumeration. Run the probe
  only on services you control, from your own connection, and call it once.
- Cloud Run's own request log records each request as it does for any
  service; the probe adds nothing to it.
- Address-like names match
  `(^|-)(ip|ipv6|for|forwarded|client|address|addr|real)($|-)`:
  `cf-connecting-ip`, `x-real-ip`, `x-forwarded-for`, `forwarded`,
  `true-client-ip` and similar. Values are split on commas, whitespace,
  semicolons and `=`, then stripped of quotes and square brackets, and each
  token is compared whole.

## Rerun it on the production zone before the first gcp deploy

The 2026-10-02 run used a `workers.dev` Worker. The production edge runs on
the `tibotattle.com` zone, so the gcp switch waits for one rerun from that
zone. Every step is owner-run, and the deploys and deletions are separate
authorizations.

1. **Stage the echo outside the repository.** Copy `echo-server.mjs` into an
   empty scratch directory and add this `package.json`:

   ```json
   { "name": "tibotattle-ip-probe-echo", "private": true, "type": "module", "scripts": { "start": "node echo-server.mjs" }, "engines": { "node": ">=22" } }
   ```

2. **Deploy the echo to the test project, publicly.** The probe sends no ID
   token: it tests Cloudflare's headers, not Cloud Run's IAM.

   ```bash
   gcloud run deploy tibotattle-ip-probe-echo --source <scratch directory> \
     --project <GCP test project> --region us-east1 --allow-unauthenticated
   ```

3. **Stage the probe Worker outside the repository.** Copy `probe-worker.mjs`
   and `wrangler.example.jsonc` (as `wrangler.jsonc`) into another scratch
   directory and set `ECHO_URL` to the echo's URL. For the zone run, set
   `workers_dev` to `false` and add one exact-path route on the zone, such as
   `tibotattle.com/probe`, with no wildcard. First check that nothing the
   production Worker serves uses `/probe`. The production Worker's name,
   configuration and custom domains are not touched. Never deploy the probe
   from `apps/worker`, with its `wrangler.jsonc`, or under the production
   Worker's name.
4. **Deploy the probe Worker** from that directory with `npx wrangler deploy`,
   authenticated to the owner's account.
5. **Call it once** from your own connection:
   `curl -sS https://tibotattle.com/probe`, or the `workers.dev` URL (which
   does not meet the gcp gate). If the answer is not the probe's JSON, the
   route did not take effect. Stop. Do not widen the pattern.
6. **Delete both.** Remove the route and delete the Worker (`npx wrangler
   delete` from the probe's directory), then confirm on the dashboard that no
   `/probe` route remains on the zone. Delete the echo with
   `gcloud run services delete tibotattle-ip-probe-echo --project <GCP test project> --region us-east1`,
   and delete the image that the source deploy left in the project's
   `cloud-run-source-deploy` Artifact Registry repository.
7. **Record the result** in a dated receipt: the date and time, the Worker's
   placement (zone route or `workers.dev`), the header names, and each
   address entry's booleans and token count. Never record a value or the URL
   of a still-running service.

## Read the result

The run passes when all of these hold:

- `visitorSeenByWorker` is `true`. Otherwise there was no visitor address to
  compare, and the run is void.
- No entry in `echo.address` has `containsVisitor: true`.
- `echo.headerNames` holds no name derived from the address. The echo gives a
  `cf-ip*` name such as `cf-ipcountry` no entry, so read the names list for
  it. A name absent from the 2026-10-02 list is a change: examine it before
  relying on the run.

On 2026-10-02 the names were `accept-encoding`, `cdn-loop`, `cf-ew-via`,
`cf-ray`, `cf-visitor`, `cf-worker`, `forwarded`, `host`, `traceparent`,
`x-cloud-trace-context`, `x-forwarded-for`, `x-forwarded-proto` and the two
probe headers. No `cf-connecting-ip` and no `x-real-ip` arrived.
`x-forwarded-for` had two tokens, including the placeholder, and `forwarded`
had four; neither contained the visitor.

If any condition fails, the edge cannot claim that no client address reaches
Google from that placement. The gcp switch stays blocked, and OD-E6's options
(a Cloudflare-proxied origin hostname, or acceptance with disclosure) are open
again.

What a pass does not show:

- The observation point is the container. A header that Google's front end
  removed before delivering the request would not appear.
- A token is compared whole, so an address written with a port
  (`192.0.2.1:443`, `[2001:db8::1]:443`) would not match the visitor.
- Values of headers that are not address-like are never examined.
- One request from one connection shows one path through Cloudflare's network.
- The probe always sends the override. It does not show what would arrive
  without it, so the override and E12's S7 assertion stay load-bearing.
