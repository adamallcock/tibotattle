---
title: PF containment alternative for macOS credential qualification
date: 2026-09-22
type: plan
status: proposed
---

This is a synthetic host canary prepared for review, not installed-client or
credential-continuity evidence. No PF command, launchd mutation, hosted dispatch,
app launch, or Keychain operation was performed during its local preparation.
The signed 0.1.24 candidate and the existing credential launcher are unchanged.

## Reason and evidence boundary

The exact credential run reached GPU-process termination before the predecessor's
native introduction. Its outer Seatbelt wrapper remains a plausible conflict
with Chromium's own helper sandbox; this is not a confirmed product root cause.
A host firewall can avoid nesting process sandboxes while retaining Chromium's
normal sandbox, but must first qualify independently on a disposable hosted VM.

GitHub documents a fresh hosted VM and passwordless sudo for macOS; it does not
promise a particular PF state or an external IPv6 route. The live canary must
establish those conditions. Existing TCP/UDP states are checked before new filter
rules in [Apple's PF implementation](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/net/pf.c),
so active PF, existing references, or any existing state cause refusal. No state
flush, global rules replacement, global PF disable, or runner TLS exception is
permitted. [Apple warns that PF is not an API](https://developer.apple.com/documentation/technotes/tn3165-packet-filter-is-not-api);
this is a constrained hosted-image experiment, not portable product functionality.

## Prepared implementation

- `scripts/lib/macos-pf-qualification.mjs` defines an inert review plan, closed
  evidence checks, and cleanup ordering. It grants no app-launch capability.
- `scripts/lib/macos-pf-canary/supervisor.py` is copied into one fresh root-owned
  operation directory, then run by a root system LaunchDaemon. The coordinator
  must exit before containment begins. The supervisor accepts only fixed
  synthetic probes; it cannot select an app, credential helper, endpoint, or
  arbitrary child command.
- `scripts/qualify-macos-pf-canary.mjs` admits only the exact hosted ARM runner
  account and pinned Node, clean critical source at `GITHUB_SHA`, and explicit
  canary confirmation. Receipts bind the runner revision and copied Python SHA.
- The registered `electron-macos-credentials.yml` workflow has separate
  `pf-canary-plan` and `pf-canary-execute` modes. Legacy `plan`/`execute` retain
  their credential job and arguments; the canary job cannot execute that job.

Preflight requires PF disabled, empty states/references, a previously absent
unique child under the already reachable `com.apple/*` wildcard, no earlier
filter rules or skipped interfaces, and no child filtering/translation rules.
It preserves the existing root and other anchors. The network scenario also
requires routes to both fixed TEST-NET destinations before enabling PF; missing
routes produce an environment refusal before disconnecting the runner.

Four counter labels match only synthetic TCP/UDP destinations and port 9 in
IPv4/IPv6. Two following blanket rules deny all other non-loopback IP traffic.
Positive IPv4/IPv6 loopback probes, exact loaded rules, empty states, and increasing
matching kernel counters are required. Timeout, socket errors, successful UDP
queueing, and background runner traffic cannot independently prove denial.

The supervisor launches probes in `launchctl asuser 501` plus the runner UID,
preserving the GUI bootstrap. It records each fresh process group before releasing
a pipe gate; parent death before release leaves the child unable to execute.
Cleanup checks process birth before each signal and refuses uncertain ownership.
It stops all live owned processes before emptying only its exact anchor and
releasing only its private enable token. The `probe-timeout` scenario exercises
hung-child termination; it cannot claim network qualification. Probe output and
receipts are fixed and content-free; raw PF/process output and tokens stay private.

## Remaining gates and explicit limits

1. Complete local review and tests, then push only the reviewed diagnostic commit.
2. Dispatch plan mode against the existing workflow, then separately review and
   authorize the network and timeout canary runs. A successful upload after PF
   restoration is needed to establish actual CI reconnect and retained evidence.
3. Verify exact runner image, receipt revision/source SHA, both network families,
   GUI bootstrap access, coordinator exit, stopped probes and restored PF. A
   missing IPv6 route is a blocker, not permission to relax the counter check.
4. Only then integrate credential prefetch followed by containment before fixture
   creation. Product launch registration, orphaned helpers, Keychain cleanup,
   and the complete signed predecessor/candidate sequence require their own review
   and installed-artifact evidence. This canary does not satisfy those gates.

An uncertain `pfctl -E` result has no safely attributable token. The supervisor
keeps the anchor and unresolved phase across restarts, reports failure, and does
not globally disable PF. A live owned process or changed topology likewise
prevents unblock. These failures may leave the disposable VM disconnected until
GitHub destroys it: safety is retained, recovery liveness is not claimed. A
terminated parent whose surviving descendants lack a verifiable group leader is
also refused. The watchdog cannot guarantee GitHub will retain the VM or job.

## Dispatch route after review

Read-only API inspection found active workflow ID `357921507` for
`electron-macos-credentials.yml`. GitHub requires default-branch registration for
new manual workflows, but supports selecting another ref of an already-run
workflow. See [manual workflow events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch).
No new workflow file or diagnostic-branch merge is required.

Use the existing workflow ID/path and the reviewed diagnostic branch ref. Plan
inputs are `mode=pf-canary-plan`, `intake={}`, `canary_scenario=network`, with no
confirmation. Protected execution changes mode to `pf-canary-execute` and requires
`confirmation=RUN_DISPOSABLE_MAC_PF_CANARY`. The second independent execution uses
`canary_scenario=probe-timeout`. No dispatch was performed during preparation.
