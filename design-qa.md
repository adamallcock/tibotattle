# Native menu-bar popover design QA

Date: 2026-08-24

State: live, English, light appearance, 7-day history selected

Visual result: passed

Overall status: passed

## Evidence

- Source visual truth: `/Users/adamallcock/.codex/generated_images/01a030b3-3ef4-7c52-a706-e3ae6d4a8513/exec-acacd359-28a4-4959-bd97-c042bcb8878b.png`
- Compiled implementation: `/Users/adamallcock/.codex/visualizations/2026/08/23/01a030b3-3ef4-7c52-a706-e3ae6d4a8513/menu-bar-popover-en-light.png`
- Full-view comparison: `/Users/adamallcock/.codex/visualizations/2026/08/23/01a030b3-3ef4-7c52-a706-e3ae6d4a8513/native-popup-comparison-final.png` (source left, implementation right)
- Additional renders: 11 total fixtures in the same visualization directory,
  including English 30-day, all three locales in light/dark, and Spanish
  partial-pricing, fully unpriced, and unavailable states.
- Source pixels: 1033 × 1522. Live implementation pixels: 800 × 1312 for the
  deterministic 400 × 656-point AppKit capture at 2× density. Runtime width is
  fixed at 400 points; runtime height is content-driven, so 656 points is not a
  shipped layout invariant. The shorter unavailable state and taller wrapped
  unpriced state verify that behavior directly.
- Comparison normalization: source aspect ratio preserved and downsampled to
  890 × 1312; implementation retained at native 800 × 1312. The source is a
  conceptual popover mock rather than an exact 400-point specification, so
  width and shell geometry were not treated as pixel-exact targets.
- Runtime shell note: the implementation capture is the popover content view. The shipped `NSPopover` supplies the rounded native shell and arrow when presented.

The full-resolution combined image keeps the header, allowance tracks, weekly-position tracks, chart, icons, labels, and actions legible. A separate focused crop was unnecessary because the relevant typography and control details remain readable in the full-view comparison.

## Findings

No actionable P0, P1, or P2 visual differences remain.

The following differences are intentional product constraints rather than drift:

- The reference's reset-credit row is absent. The user explicitly rejected reset-credit availability and redemption UI.
- The implementation gives exactly the five-hour and seven-day allowance windows equal, compact tracks instead of making the weekly number a hero. This preserves both fresh allowance windows within a fixed-width, no-scroll native surface without introducing any credit balance.
- The implementation expands the source's used-versus-elapsed text into two aligned tracks and an explicit `Above even pace` state. It is labeled as a comparison, not a forecast.
- The source's single seven-day chart becomes a native 7d/30d selector. Both ranges preserve one civil-day position per bar, including visibly partial evidence.
- Cost remains subordinate to tokens and is labeled `API-price equivalent` and `Not a subscription bill`.

## Required fidelity surfaces

- Fonts and typography: native San Francisco system text matches the macOS reference language; semibold hierarchy, monospaced-digit percentages and totals, line heights, truncation, and Spanish/Simplified Chinese fallback render cleanly at 400 points.
- Spacing and layout rhythm: 18-point horizontal insets, restrained separators, consistent section rhythm, aligned percent values, a fixed 400-point width, and content-driven height preserve scanability without scrolling or clipping. The deterministic fixture is 640 points high; the 30-bar chart remains readable at the same width.
- Colors and tokens: the existing TiboTattle green owns headings, allowance, chart, and primary action; orange is reserved for the above-pace semantic state. Light and dark renders keep sufficient foreground/background separation. High-contrast behavior is delegated to native semantic colors and controls; it is not falsely represented by a synthetic screenshot variant.
- Image quality and assets: the real bundled TiboTattle icon is reused at native scale. SF Symbols provide the standard ellipsis and refresh actions; there are no placeholder, emoji, handcrafted SVG, or code-drawn brand substitutes.
- Copy and content: `Above even pace`, `Compares use with time elapsed · not a forecast`, `API-price equivalent`, and `Not a subscription bill` state the evidence boundary directly. Partial observation is named, partially priced data is presented only as a known subtotal, and missing coverage withholds unsupported totals. No reset-credit availability, purchase, redemption, account, or plan copy appears.
- Icons and controls: the real brand icon, native segmented control, native buttons, and native action menu are optically aligned and consistent with AppKit.
- States and interactions: the compiled presentation contract exercises the 7d/30d selector and live/starting/unavailable states. Pure semantic routing checks distinguish left-click popover intent from right-click/Control-click menu intent, and the native wiring is compiled. This is not an operating-system mouse-injection test. The source visual target defines only the live state, so non-live states were not scored for visual fidelity.
- Accessibility: semantic AppKit controls, accessibility labels/help, progress/group roles, keyboard focus order, and dynamic system colors are present. The fixed layout contains no motion-dependent interaction.

## Open questions

None blocking. A future source mock for starting and unavailable states would permit visual comparison of those states instead of contract-only verification.

## Comparison history

- Pass 1: the normalized source-and-implementation comparison found no actionable P0/P1/P2 mismatch. No visual fix was made in response.
- Evidence integrity check: an initial image-preview response appeared to omit parts of the Simplified Chinese normal-appearance render. The unchanged PNG was complete when independently decoded; before/after SHA-256 and decoded pixels matched exactly. This was a preview-tool artifact, so no product workaround was retained.

## Implementation checklist

- [x] Preserve the selected reference hierarchy and TiboTattle visual language.
- [x] Remove reset-credit availability and all redemption/purchase behavior.
- [x] Make used-versus-elapsed position visually primary and explicitly non-forecasting.
- [x] Provide coherent 7-day and 30-day token histories.
- [x] Verify light/dark and English/Spanish/Simplified Chinese renders.
- [x] Re-run the focused and full macOS validation receipts against the final source tree, including the compiled AppKit interaction contract and native action ownership.

## Follow-up polish

No P3 visual polish is required. The final macOS lane passed 57/57 with no
failures, cancellations, or skips; the focused source, compiled semantic, and
11-state render receipts also passed.
