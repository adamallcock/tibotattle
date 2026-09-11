# Internationalization package guidance

Scope: all files under `packages/i18n/`. Apply the repository root guidance
first.

## Locale and catalog contract

- This package owns runtime-neutral locale negotiation, canonical catalogs,
  placeholders, and formatting helpers. Surfaces consume it; they do not maintain
  divergent message semantics.
- Preserve English fallback and safe script/region negotiation. In particular,
  Traditional Chinese requests must not select a Simplified Chinese catalog.
- Keep language choice separate from regional number/date formatting and from
  quota, pricing, or event-time semantics.
- Every shipped locale has the exact canonical key set and compatible placeholder
  names. Do not hide missing keys through a production-only fallback that tests
  cannot observe.
- Translations preserve product meaning, evidence qualifiers, privacy language,
  unavailable/error distinctions, and action consequences; brevity must not
  weaken the contract.

## Change and validation discipline

- Keep the package deterministic, side-effect free, and independent of DOM,
  filesystem, network, native APIs, and app code. Accept locale inputs explicitly.
- Add or rename a key in the canonical package first, update every locale and
  affected accessibility label, then regenerate the browser mirror. Never edit
  the generated browser catalog directly.
- Preserve Unicode, plural/number/date behavior, interpolation escaping, and
  placeholder validation. Treat untrusted values as text, not markup.
- Run focused i18n tests, `npm run i18n:browser:check`, and the affected web/native
  surface tests. Use `npm run i18n:browser:generate` only after an intentional
  canonical change.
- Inspect real layouts for expansion, truncation, wrapping, focus/accessibility,
  and locale switching. Catalog equality alone is not rendered qualification.
