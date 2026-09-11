# Retained staging rehearsal lineage

These three SQL files are the exact accountless rehearsal migrations that were
applied to the retired synthetic staging database as `0046` through `0048`.
They are retained as evidence for that historical, divergent ledger only.

They are deliberately outside the Worker `migrations/` directory and must not
be applied to another database. The active, forward-only lineage follows the
production `0046`–`0056` prefix and appends equivalent accountless migrations
as `0057`–`0059`. A future staging binding may move to a separately prepared
canonical database only after its own approved cutover; this directory is not
a migration source or an alternate deployment path.
