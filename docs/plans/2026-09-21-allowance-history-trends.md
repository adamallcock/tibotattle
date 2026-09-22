---
title: Shared robust LOWESS allowance history
date: 2026-09-21
type: plan
status: implemented
---

The selected implementation is automatic robust LOWESS on the allowance history
and social share graph. The exploratory segmented-median option and comparison
selector are removed. Keep the all-data median reference, raw estimates, ranges,
headline, plan attribution and privacy boundaries.

Fit once in the shared history model after plan, date-range and observed-span
selection. Both SVG and social-card Canvas consume the exact fitted values and
null gaps; the social-card signature, fixed-copy legend and accessible transcript
include the fitted trend. Saving or copying the image uses the same Canvas.

No new dependencies. LOWESS uses 50% neighbourhoods (minimum six points), three
bisquare robustness iterations and local value bounds. Require at least 14 days
of support. Gaps over 28 days split the fit; duplicate timestamps are excluded;
the first value after a long gap stays null to break both plotted lines. Reject
fitting above 250 visible resets without truncating raw observations. These are
exploratory defaults, not calibrated significance thresholds.

Acceptance: numerical edge cases; shared model and Canvas geometry parity;
filter, plan and refresh propagation; null-gap and sparse-state preservation;
translated line labels; real-data dashboard and social-image inspection. Use a
read-only loopback preview without writes to installed state. Installed/native
rendering, packaging, release and deployment remain separate gates.

Validated in the working checkout: 739 browser UI tests, five i18n and module
serving tests, architecture checks and generated-catalog parity. The final
255-test chart suite also verifies that filtering invalid raw estimates cannot
join disconnected LOWESS segments in the social image. Numerical fixtures are
synthetic; real derived data was inspected only in the read-only browser preview.
Rendered checks covered the allowance and social graphs, desktop and narrow
layouts, English and Spanish labels, and the insufficient-history state.
