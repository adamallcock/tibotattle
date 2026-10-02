---
title: Terminal selective erasure v5 draft review
date: 2026-10-02
type: review
status: paused-draft
---

# Terminal selective source stamp: paused draft

Status: paused for user maintenance. Do not run or adopt this draft without review.

- Candidate v4 migration SHA256: `8e6c5e8391fa491816b7eac709737ca05dcda13e87f04f5f82e5c1b9983e60fb`.
- Candidate selective spec SHA256: `19f065e5e0b8c749e2a803abd09393bd2767b96838d99fe564a3ca16c6c93d2c`.
- Candidate original skew spec SHA256: `7b1a1386c8c085245374e00b7be89e800b25e7bcc0e290da0036da486467d107`.
- Off-tree untested v5 SQL draft SHA256: `9a282b0389345767d57d6871244d1239c8135bf218ec4840646bbad02ec8a60d`. Off-tree spec is the unchanged v4 copy, SHA256 `19f065e5e0b8c749e2a803abd09393bd2767b96838d99fe564a3ca16c6c93d2c`.
- v4 run receipt: `/private/tmp/tibotattle-terminal-scoped-ledger-v4-seven-1790943780856-62675.receipt.json`, SHA256 `9ee602d214832a3aa2128ab5f535c93ca73a90da211c95a39309846d71e2e23e`. Seven selected: four passed, three failed; 3,284 input pins unchanged; process group reaped.

The original terminal failure changes only the retained owner's `seal.sourceStamp` after physical erasure; facts, fact revisions and the other seal fields match. Native erasure first calls `revokeAccountlessEnrollment(..., 'security_reset')`, then marks the participant deleting. Its BEFORE DELETE trigger changes the owner link to erased and journals owner-erased. At the source-state trigger, v4 requires the participant, ledger, owner and credential to remain active, so no owner effect is inserted and the global policy stamp advances. This is source-supported cause, while a corrected v5 outcome remains untested.

Two additive v4 erasure fixtures failed before their assertions because they directly DELETE an active accountless participant; migration 0058 requires ledger revocation first. They must follow the native revoke/deleting/delete order, retaining all original terminal assertions and public authority fences.

The off-tree v5 draft adds a narrow owner-erased branch requiring a deleting accountless participant with deletion fence, security-reset revoked ledger/owner/credential, matching revocation times, exact existing event/revision/link/owner mapping, consistent grants and no retained-history marker. It has no test edits yet and has not been parsed, typechecked, run, or reviewed. Check whether additional erasure cascade triggers advance the global policy stamp before claiming this fixes the whole terminal path. Unknown, mismatched, retained, source-identity and key-change paths must retain global fallback. Migration 0014 global revision and final public authority fences remain unchanged.

No v5 test or D1 execution was started. The last v4 controller completed and reaped its process group. An attempted `ps` inventory was denied by the sandbox; there is no ongoing process started by this paused turn.
