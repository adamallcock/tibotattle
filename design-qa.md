# Native menu visual QA

## Comparison target

- Source visual truth: `/var/folders/tv/4fwgy5qn2j3789gfz33ps_xr0000gn/T/codex-clipboard-66b00039-d1c6-49be-ada5-1ef51c250310.png`
  (CodexBar expanded status menu, 664 x 1222 pixels).
- Implementation build: `.release-build/macos-qa/TiboTattle.app`, built from
  `codex/release-security-client-split`.
- Implementation capture:
  `.release-build/visual-qa/01-companion-error.png` (1016 x 768 pixels).
- Intended comparison state: a fresh, ready local companion with its menu
  expanded. The source and capture are not the same state and were not used as
  a fidelity comparison.

## Evidence and result

The current branch compiled into a fresh, ad-hoc app bundle. When that QA
bundle launched, the app correctly retained the existing user state but the
companion rejected a second instance because the already-running prior bundle
held the owner-only automatic-contribution instance lock. The QA bundle then
showed `UM_MACOS_COMPANION_EXITED`; it did not reach the ready dashboard or
render its expanded menu. Directly starting the bundled companion in a clean
temporary state succeeded, which isolates the failure to the intentionally
exclusive existing-state lock rather than the bundle payload.

This is not a valid comparison with the CodexBar reference. The UI source and
native unit suite show the newer menu hierarchy (freshness explanation,
observed lanes, state-aware local analysis, update action when present, and
quit), but that is not visual proof of the compiled menu.

After this blocked capture, the menu source was upgraded from stacked disabled
text rows to native AppKit summary and quota-lane views: a product heading,
freshness detail, accent-coloured progress tracks only for live evidence, and
per-lane label/value/reset hierarchy. A new bundle compiled successfully. It
still needs the ready-state capture below before it can pass design QA.

## Required fidelity surfaces

- Fonts and typography: blocked; the target menu was not rendered from this
  branch.
- Spacing and layout rhythm: blocked; the target menu was not rendered from
  this branch.
- Colors and visual tokens: blocked; the target menu was not rendered from
  this branch.
- Image quality and asset fidelity: blocked; no comparable image/menu state
  was rendered.
- Copy and content: source review confirms the app intentionally omits the
  privacy-inappropriate account/email surface in the reference, but a live
  ready-state inspection is still required.

## Next QA run

Run the fresh bundle when the previous TiboTattle instance is not using the
same owner-only state, capture the ready window and expanded menu at the same
state, then compare those captures with the supplied CodexBar reference. If a
second installed copy is a supported update scenario, improve the generic
startup failure to explain that another local instance owns the lock.

final result: blocked
