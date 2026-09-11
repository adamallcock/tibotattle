# Schemas

This directory contains canonical closed JSON Schemas and the checked mirrors
of package-owned telemetry schemas. Start with the maintained
[schema and contract lifecycle](../docs/reference/schema-contracts.md) for the
ownership map, generators, compatibility rules, and retirement procedure.

Do not hand-edit `schemas/telemetry-contribution-v0.2/` or
`schemas/telemetry-contribution-v1.1/`. v0.2 canonical sources are under
`packages/telemetry-contract/schemas/v0.2/`. v1.1 package schemas and root mirrors
are generated from `packages/telemetry-contract/src/telemetry-v1.1-schemas.js`.
Both families are synchronized by:

```bash
npm run telemetry:upload-schemas:generate
npm run telemetry:upload-schemas:check
```

Privacy-sensitive objects remain closed. Adding or changing a field requires
the producer, consumers, consent/compatibility state, storage behavior, tests,
generated artifacts, and maintained privacy/API documentation to move in the
same change. Delete a schema only after all producers, consumers, retained data,
and supported compatibility windows have a reviewed disposition.
