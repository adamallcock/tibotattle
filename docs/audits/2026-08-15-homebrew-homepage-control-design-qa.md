---
title: Homebrew Homepage Control Design QA
date: 2026-08-15
type: audit
status: complete
---

# Homebrew homepage control design QA

The artifact paths below record the original local QA environment. Generated
captures are supporting evidence, not release or deployment authority.

## Comparison setup

- Source visual truth: `/var/folders/tv/4fwgy5qn2j3789gfz33ps_xr0000gn/T/codex-clipboard-a33aa90a-68ce-48c6-862a-6be9d4cdfd00.png`
- Source pixels: 3824 × 2358. The focused comparison uses the download and Homebrew-command region rather than treating CodexBar's whole page as a TiboTattle redesign target.
- Implementation: `.release-build/homebrew-homepage-qa/wide-desktop-idle-final.png`
- Implementation pixels and CSS viewport: 1353 × 827 at browser `devicePixelRatio` 1.33. The browser screenshot is normalized to CSS-pixel dimensions.
- Mobile evidence: `.release-build/homebrew-homepage-qa/mobile-actions-final.png`, 293 × 634 CSS pixels at browser `devicePixelRatio` 1.33.
- Combined focused evidence: `.release-build/homebrew-homepage-qa/comparison.png`, 1491 × 677 pixels.
- State: verified v0.1.12 installer metadata present; Homebrew copy action idle for layout comparison. Copied and Spanish-localized states were also exercised.

## Findings

- No actionable P0, P1, or P2 differences remain.
- Fonts and typography: the command uses the existing system monospace stack at a legible compact size, while the primary button keeps TiboTattle's established sans styling. The hierarchy matches the reference pattern without replacing TiboTattle's display face.
- Spacing and layout rhythm: Download and the command share a 54 px height and align in one row at the wide breakpoint. The command uses the inter-column gap without touching the product preview. At the narrow breakpoint both controls occupy the hero width and the command wraps to two readable lines.
- Colors and visual tokens: the terminal treatment uses TiboTattle's existing deep-green hero, paper foreground, radius, focus, and bright-green success tokens. Contrast and focus treatment remain distinct on the dark hero.
- Image quality and asset fidelity: the existing Apple asset is retained. No product imagery was recreated or replaced, and no placeholder or handcrafted icon was introduced.
- Copy and content: the displayed and copied command is exactly `brew install --cask adamallcock/tap/tibotattle`. The fixed command is independent of DOM or service content. Copy success, manual-copy fallback, group labels, and button labels are available in English, Simplified Chinese, and Spanish.
- Intentional P3 adaptation: TiboTattle uses a visible `Copy` label instead of CodexBar's icon-only affordance. This is clearer without adding an icon dependency and preserves the requested interaction pattern.

## Comparison history

1. Initial narrow capture: the hero's grid item inherited the command's intrinsic width and overflowed the viewport. Fixed with bounded grid/flex children and a stacked mobile action layout.
2. Second narrow capture: the control fit, but the command was horizontally clipped. Fixed by allowing the fixed command to wrap at the narrow breakpoint; final document client and scroll widths are both 293 px.
3. Initial wide capture: the last characters were scrollable rather than immediately visible. Fixed by letting the action row use 44 px of the existing wide-screen column gap. Final command `clientWidth` and `scrollWidth` are both 304 px, the page has no horizontal overflow, and 15 px remains before the preview card.

## Interaction and browser checks

- Primary download link still resolves to the verified v0.1.12 GitHub DMG.
- Copy click changes `Copy` to `Copied` and announces `Homebrew install command copied.`
- Switching to Spanish updates the copied state to `Copiado` and its Spanish live-region message.
- Desktop and mobile layouts were rendered in the Codex in-app browser.
- Browser console warnings/errors: none.

## Implementation checklist

- [x] Match the reference's paired Download + terminal-command pattern.
- [x] Keep the signed-download gate and release metadata behavior unchanged.
- [x] Copy only the fixed first-party tap command.
- [x] Provide accessible and localized feedback.
- [x] Prevent desktop and mobile overflow.
- [x] Verify the rendered interaction and focused visual comparison.

## Follow-up polish

None required for this scoped addition.

Final result: passed.
