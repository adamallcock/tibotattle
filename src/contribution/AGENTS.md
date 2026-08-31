# Contribution domain guidance

Scope: all files under `src/contribution/`. Apply `AGENTS.md` and `src/AGENTS.md`
first.

## Capability and privacy boundary

- Contribution begins only after local data has been projected into the current
  allowlisted telemetry contract and passed recursive privacy validation. This
  domain never receives raw rollout or transcript records.
- Preserve the sequence: explicit consent, exact-data review, prepared immutable
  set, authenticated capability, accepted first upload, then while-open recurring
  contribution. Do not turn code availability into consent or background service.
- Keep local-only use account-free. Hosted sign-in identity, participant identity,
  device capability, account track, and event/session pseudonyms have distinct
  purposes and must not be joined into a richer identity.
- Never persist names, emails, credentials, raw provider account IDs, raw local
  paths, or arbitrary upstream metadata in contribution artifacts.
- Preserve the current contract's deliberately permitted bounded fields, including
  any UUID-shaped session field, exactly. Privacy changes require coordinated
  schema, consent, client, Worker, stored-data, and deletion review.

## Replay and lifecycle

- Prepared-set IDs, chunks, events, queue entries, device operations, and server
  acknowledgements are idempotent. Retry, resume, crash, reconnect, duplicate
  delivery, and multi-device order must converge without double contribution.
- Bind a review/claim to exact immutable prepared bytes. Later local data creates
  a new prepared set; it must not mutate the reviewed set in place.
- Keep consent revocation, contribution pause, device disconnection, local
  identity rotation, private owner erasure, and local evidence deletion separate.
  Device disconnection preserves hosted/local history; expose each exact effect.
- Recurring contribution is foreground/while-open and bounded. Do not introduce a
  daemon, hidden timer, autonomous raw scan, or unreviewed transport path.
- Fail closed on version mismatch, expired capability, clock ambiguity, unknown
  acknowledgement, or partial durable state; preserve recoverable local intent.

## Validation

- Add negative privacy, consent, version, replay, crash, duplicate, and multi-device
  tests whenever those boundaries change.
- Run focused contribution and preparation tests, then
  `npm run product:local:test`; add `npm run product:worker:check` for any shared
  client/server or schema contract.
- Use the disposable local Worker laboratory for end-to-end behavior. Do not use
  production participant data or endpoints.
- Verify the exact reviewed-data presentation when contribution fields change;
  schema validity without understandable review is incomplete.
