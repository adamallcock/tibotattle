export const POLICY_EVENTS = [
  {
    effectiveAt: "2026-04-09T00:00:00.000Z",
    id: "pro-plan-restructure",
    status: "verified_announcement",
    effect: "The $100 Pro option launched with a temporary up-to-10x Codex allowance; the standard allowance was described as 5x and the $200 option remained the highest-usage tier.",
    sourceUrl: "https://help.openai.com/en/articles/6825453-chatgpt-release-notes",
  },
  {
    effectiveAt: "2026-05-29T00:00:00.000Z",
    id: "codex-profile-usage-visibility",
    status: "verified_ui_change",
    effect: "Profile usage and token activity became visible; this is a measurement-surface change, not proof of an allowance change.",
    sourceUrl: "https://developers.openai.com/codex/changelog",
  },
  {
    effectiveAt: "2026-07-09T00:00:00.000Z",
    id: "chatgpt-work-launch",
    status: "plausible_unconfirmed_accounting_boundary",
    effect: "ChatGPT Work launched for the first eligible cohorts and Codex joined the ChatGPT desktop app; no dated source says shared accounting began on this exact date.",
    sourceUrl: "https://help.openai.com/en/articles/6825453-chatgpt-release-notes",
  },
  {
    effectiveAt: "2026-07-16T00:00:00.000Z",
    id: "work-cross-device-continuity",
    status: "verified_ui_change",
    effect: "Work cross-device continuation and unified Chat/Work recents launched; this is not evidence of a quota-policy change.",
    sourceUrl: "https://help.openai.com/en/articles/6825453-chatgpt-release-notes",
  },
];

export function policyEpochAt(timestamp) {
  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs)) throw new Error("Policy epoch lookup requires a valid timestamp");
  const priorEvents = POLICY_EVENTS.filter((event) => Date.parse(event.effectiveAt) <= timestampMs);
  const current = priorEvents.at(-1) ?? null;
  return {
    id: current?.id ?? "pre-observed-policy-events",
    effectiveAt: current?.effectiveAt ?? null,
    status: current?.status ?? "unclassified",
  };
}

export function policyEpochsInRange(startAt, endAt) {
  const startMs = Date.parse(startAt);
  const endMs = Date.parse(endAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    throw new Error("Policy range must be chronological");
  }
  return POLICY_EVENTS.filter((event) => Date.parse(event.effectiveAt) >= startMs && Date.parse(event.effectiveAt) <= endMs);
}
