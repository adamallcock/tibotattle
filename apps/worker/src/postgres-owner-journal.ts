import { quotePostgresIdentifier, type PostgresClient } from "./postgres-client";

/**
 * Typed access to the PostgreSQL owner-journal authority (staged primary
 * migration 0046). Every function runs inside the caller's transaction on the
 * caller's client: producers write their event-source receipt and the journal
 * row atomically, and the database functions take their own row locks in the
 * documented order (participant, owner link, domain head, source state, owner
 * revision head).
 *
 * `storage_journal_append` is the only live producer of exact (version-1)
 * journal rows; scripts/storage-journal-single-producer.check.mjs refuses any
 * other production write to that table.
 *
 * The migration's constant refusals surface as PostgresOwnerJournalError; any
 * other database failure is rethrown unchanged for the caller's transaction
 * helper to sanitize. A caller that wants to act on a journal code passes a
 * preserveSafeError mapper to its transaction.
 */

export const OWNER_JOURNAL_KINDS = Object.freeze([
  "source-updated",
  "owner-active",
  "owner-withdrawn",
  "owner-erased",
] as const);

export type OwnerJournalKind = (typeof OWNER_JOURNAL_KINDS)[number];
export type OwnerLinkInitialState = "active" | "withdrawn";

export type PostgresOwnerJournalCode =
  | "OWNER_JOURNAL_INPUT_INVALID"
  | "OWNER_JOURNAL_SOURCE_UNINITIALIZED"
  | "OWNER_JOURNAL_OWNER_ERASED"
  | "OWNER_JOURNAL_OWNER_UNINITIALIZED"
  | "OWNER_JOURNAL_OWNER_INELIGIBLE"
  | "OWNER_JOURNAL_EVENT_CONFLICT"
  | "OWNER_JOURNAL_PARTICIPANT_UNAVAILABLE"
  | "OWNER_JOURNAL_READBACK_FAILED";

export class PostgresOwnerJournalError extends Error {
  readonly code: PostgresOwnerJournalCode;

  constructor(code: PostgresOwnerJournalCode) {
    super(code);
    this.name = "PostgresOwnerJournalError";
    this.code = code;
  }
}

export interface AppendPostgresOwnerJournalInput {
  readonly kind: OwnerJournalKind;
  readonly ownerDigest: string;
  readonly eventDigest: string;
  readonly objectDigest: string;
  readonly contentDigest: string;
}

export interface PostgresOwnerJournalAppendResult {
  readonly sequence: number;
}

/** Content-free counts over the owner-journal authority. */
export interface PostgresOwnerJournalHealth {
  readonly sourceInitialized: boolean;
  readonly heads: {
    readonly active: number;
    readonly withdrawn: number;
    readonly erased: number;
  };
  /** Heads whose first exact row was not a D1-first owner-active. */
  readonly seededPartialHeads: number;
  /** Owner links that have never been journaled with an exact row. */
  readonly linksWithoutHead: number;
  /** Unqualified version-0 rows written for an owner that has a head. */
  readonly versionZeroRowsForHeadedOwners: number;
}

const HEX64 = /^[0-9a-f]{64}$/u;
const PARTICIPANT_ID = /^[\x21-\x7e]{1,256}$/u;

/**
 * Constant database messages raised by migration 0046. Only these closed
 * messages, with the dedicated SQLSTATE, are translated; any other failure is
 * rethrown for the caller's transaction helper to sanitize.
 */
const DATABASE_CODES: ReadonlyMap<string, PostgresOwnerJournalCode> = new Map([
  ["storage_source_uninitialized", "OWNER_JOURNAL_SOURCE_UNINITIALIZED"],
  ["storage_owner_erased", "OWNER_JOURNAL_OWNER_ERASED"],
  ["storage_owner_uninitialized", "OWNER_JOURNAL_OWNER_UNINITIALIZED"],
  ["storage_owner_ineligible", "OWNER_JOURNAL_OWNER_INELIGIBLE"],
  ["storage_journal_event_conflict", "OWNER_JOURNAL_EVENT_CONFLICT"],
  ["storage_owner_link_participant_unavailable", "OWNER_JOURNAL_PARTICIPANT_UNAVAILABLE"],
  ["storage_journal_kind_invalid", "OWNER_JOURNAL_INPUT_INVALID"],
  ["storage_journal_digest_invalid", "OWNER_JOURNAL_INPUT_INVALID"],
  ["storage_owner_link_state_invalid", "OWNER_JOURNAL_INPUT_INVALID"],
]);

function fail(code: PostgresOwnerJournalCode): never {
  throw new PostgresOwnerJournalError(code);
}

function translate(error: unknown): never {
  if (error !== null && typeof error === "object") {
    const state = Reflect.get(error, "code");
    const message = Reflect.get(error, "message");
    const code = state === "P1005" && typeof message === "string" ? DATABASE_CODES.get(message) : undefined;
    if (code !== undefined) fail(code);
  }
  throw error;
}

function schemaName(schema: string): string {
  try {
    return quotePostgresIdentifier(schema);
  } catch {
    fail("OWNER_JOURNAL_INPUT_INVALID");
  }
}

function rows<Row extends object>(value: unknown): readonly Row[] {
  if (value === null || typeof value !== "object") fail("OWNER_JOURNAL_READBACK_FAILED");
  const result = Reflect.get(value, "rows");
  if (!Array.isArray(result)) fail("OWNER_JOURNAL_READBACK_FAILED");
  return result as readonly Row[];
}

function count(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail("OWNER_JOURNAL_READBACK_FAILED");
  return parsed;
}

function isKind(value: unknown): value is OwnerJournalKind {
  return typeof value === "string" && (OWNER_JOURNAL_KINDS as readonly string[]).includes(value);
}

/**
 * Return the participant's shared owner digest, minting a random link in
 * `initialState` when none exists. Concurrent calls converge on one link; an
 * existing link keeps its digest and state, and a link is never minted erased.
 */
export async function ensurePostgresOwnerLink(
  client: PostgresClient,
  schema: string,
  participantId: string,
  initialState: OwnerLinkInitialState,
): Promise<string> {
  const quoted = schemaName(schema);
  if (typeof participantId !== "string" || !PARTICIPANT_ID.test(participantId)
      || (initialState !== "active" && initialState !== "withdrawn")) {
    fail("OWNER_JOURNAL_INPUT_INVALID");
  }
  let result;
  try {
    result = await client.query<{ owner_digest: unknown }>(
      `SELECT ${quoted}.storage_owner_link_ensure($1,$2) AS owner_digest`,
      [participantId, initialState],
    );
  } catch (error) {
    translate(error);
  }
  const selected = rows<{ owner_digest: unknown }>(result);
  const digest = selected[0]?.owner_digest;
  if (selected.length !== 1 || typeof digest !== "string" || !HEX64.test(digest)) {
    fail("OWNER_JOURNAL_READBACK_FAILED");
  }
  return digest;
}

/**
 * Append one exact journal row through `storage_journal_append`. Revision,
 * owner and public authority epochs, sequence and recorded time are all
 * derived by the database exactly as D1 derives them; the caller supplies only
 * the kind and the event, object and content digests it has already proved.
 */
export async function appendPostgresOwnerJournal(
  client: PostgresClient,
  schema: string,
  input: AppendPostgresOwnerJournalInput,
): Promise<PostgresOwnerJournalAppendResult> {
  const quoted = schemaName(schema);
  if (input === null || typeof input !== "object" || !isKind(input.kind)
      || typeof input.ownerDigest !== "string" || !HEX64.test(input.ownerDigest)
      || typeof input.eventDigest !== "string" || !HEX64.test(input.eventDigest)
      || typeof input.objectDigest !== "string" || !HEX64.test(input.objectDigest)
      || typeof input.contentDigest !== "string" || !HEX64.test(input.contentDigest)) {
    fail("OWNER_JOURNAL_INPUT_INVALID");
  }
  let result;
  try {
    result = await client.query<{ sequence: unknown }>(
      `SELECT ${quoted}.storage_journal_append($1,$2,$3,$4,$5)::text AS sequence`,
      [input.kind, input.ownerDigest, input.eventDigest, input.objectDigest, input.contentDigest],
    );
  } catch (error) {
    translate(error);
  }
  const selected = rows<{ sequence: unknown }>(result);
  if (selected.length !== 1) fail("OWNER_JOURNAL_READBACK_FAILED");
  const sequence = count(selected[0]?.sequence);
  if (sequence < 1) fail("OWNER_JOURNAL_READBACK_FAILED");
  return Object.freeze({ sequence });
}

/**
 * Read content-free health counts. No digest, participant or source
 * identifier leaves this function. Links and version-0 rows are measured
 * against the singleton source; without one every link is headless.
 */
export async function readPostgresOwnerJournalHealth(
  client: PostgresClient,
  schema: string,
): Promise<PostgresOwnerJournalHealth> {
  const quoted = schemaName(schema);
  const result = await client.query(
    `WITH source AS (
       SELECT source_id FROM ${quoted}.storage_source_state WHERE singleton=1
     )
     SELECT EXISTS (SELECT 1 FROM source) AS source_initialized,
       (SELECT count(*) FROM ${quoted}.storage_owner_revisions WHERE state='active')::text AS active_heads,
       (SELECT count(*) FROM ${quoted}.storage_owner_revisions WHERE state='withdrawn')::text AS withdrawn_heads,
       (SELECT count(*) FROM ${quoted}.storage_owner_revisions WHERE state='erased')::text AS erased_heads,
       (SELECT count(*) FROM ${quoted}.storage_owner_revisions WHERE seeded_partial)::text AS seeded_partial_heads,
       (SELECT count(*) FROM ${quoted}.storage_v11_owner_links link
         WHERE NOT EXISTS (
           SELECT 1 FROM ${quoted}.storage_owner_revisions head
             JOIN source ON source.source_id=head.source_id
            WHERE head.owner_digest=link.owner_digest))::text AS links_without_head,
       (SELECT count(*) FROM ${quoted}.storage_ingestion_changes change
          JOIN ${quoted}.storage_owner_revisions head
            ON head.source_id=change.source_id AND head.owner_digest=change.owner_digest
          JOIN source ON source.source_id=change.source_id
         WHERE change.event_tuple_version=0)::text AS mixed_rows`,
  );
  const selected = rows<Record<string, unknown>>(result);
  const row = selected[0];
  if (selected.length !== 1 || row === undefined || typeof row.source_initialized !== "boolean") {
    fail("OWNER_JOURNAL_READBACK_FAILED");
  }
  return Object.freeze({
    sourceInitialized: row.source_initialized,
    heads: Object.freeze({
      active: count(row.active_heads),
      withdrawn: count(row.withdrawn_heads),
      erased: count(row.erased_heads),
    }),
    seededPartialHeads: count(row.seeded_partial_heads),
    linksWithoutHead: count(row.links_without_head),
    versionZeroRowsForHeadedOwners: count(row.mixed_rows),
  });
}
