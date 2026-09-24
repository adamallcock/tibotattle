import {
  acquireUploadIngressBudgetLease,
  assertUploadIngressBudgetPolicy,
  dropExpiredUploadIngressLeases,
  parseUploadIngressBudgetState,
  releaseUploadIngressBudgetLease,
  replenishUploadIngressBudgetTokens,
  renewUploadIngressBudgetLease,
  uploadIngressBudgetStatus,
  UPLOAD_INGRESS_BUDGET_LEASE_ID,
  type UploadIngressBudgetDecision,
  type UploadIngressBudgetPolicy,
  type UploadIngressBudgetState,
  type UploadIngressBudgetStatus,
} from "./ingress-budget-policy";
import {
  createPostgresSchemaConfig,
  quotePostgresIdentifier,
  withPostgresMutation,
  type PostgresClient,
  type PostgresPool,
  type PostgresSchemaOptions,
} from "./postgres-client";

/** Matches the Durable Object namespace name used by upload-ingress-admission. */
export const POSTGRES_UPLOAD_INGRESS_BUDGET_NAME = "upload-ingress-budget-v0.1";
const BUDGET_NAME_PATTERN = /^[\x21-\x7e]{1,200}$/u;

interface BudgetStateRow {
  readonly tokens: number | string;
  readonly updated_at_ms: string;
  readonly concurrency_denials: string;
  readonly start_rate_denials: string;
  readonly last_denied_at_ms: string | null;
}

interface BudgetLeaseRow {
  readonly lease_id: string;
  readonly expires_at_ms: string;
}

function invalidBudgetName(): never {
  throw new TypeError("Invalid upload ingress budget name");
}

function assertBudgetName(value: unknown): asserts value is string {
  if (typeof value !== "string" || !BUDGET_NAME_PATTERN.test(value)) invalidBudgetName();
}

function safeInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 0 || result > maximum) {
    throw new Error("invalid ingress budget integer");
  }
  return result;
}

function finiteNumber(value: unknown): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(result) || result < 0) throw new Error("invalid ingress budget token count");
  return result;
}

function snapshotPolicy(policy: UploadIngressBudgetPolicy): UploadIngressBudgetPolicy {
  assertUploadIngressBudgetPolicy(policy);
  return Object.freeze({
    maximumConcurrent: policy.maximumConcurrent,
    maximumStartsPerMinute: policy.maximumStartsPerMinute,
    burst: policy.burst,
    leaseMilliseconds: policy.leaseMilliseconds,
  });
}

export interface PostgresUploadIngressBudgetOptions extends PostgresSchemaOptions {
  readonly budgetName?: unknown;
}

/**
 * A PostgreSQL-backed equivalent of the named ingress Durable Object.
 *
 * Every operation locks one state row before reading the DB clock, expires
 * child leases, and updates tokens plus denial counters in one transaction.
 * Separate instances therefore share exactly one admission point when they
 * receive the same budget name.
 */
export class PostgresUploadIngressBudget {
  readonly budgetName: string;
  private readonly pool: PostgresPool;
  private readonly schema: string;

  constructor(
    pool: PostgresPool,
    schemaOptions: PostgresSchemaOptions = {},
    budgetName: unknown = POSTGRES_UPLOAD_INGRESS_BUDGET_NAME,
  ) {
    if (!pool || typeof pool.connect !== "function") throw new TypeError("Invalid PostgreSQL pool");
    const config = createPostgresSchemaConfig(schemaOptions);
    assertBudgetName(budgetName);
    this.pool = pool;
    this.schema = config.primarySchema;
    this.budgetName = budgetName;
  }

  private stateTable(): string {
    return `${quotePostgresIdentifier(this.schema)}."upload_ingress_budget_states"`;
  }

  private leaseTable(): string {
    return `${quotePostgresIdentifier(this.schema)}."upload_ingress_budget_leases"`;
  }

  private async lockAndReadState(
    client: PostgresClient,
    policy: UploadIngressBudgetPolicy,
  ): Promise<{ readonly state: UploadIngressBudgetState; readonly now: number }> {
    const states = this.stateTable();
    const leases = this.leaseTable();
    await client.query(`
      INSERT INTO ${states}
        (budget_name,schema_version,tokens,updated_at)
      VALUES($1,'upload-ingress-budget-v0.1',$2,clock_timestamp())
      ON CONFLICT (budget_name) DO NOTHING`, [this.budgetName, policy.burst]);
    // The row lock is acquired before any clock value is captured. A caller
    // waiting behind another instance must be judged against current time.
    const stateResult = await client.query<BudgetStateRow>(`
      SELECT tokens, floor(extract(epoch FROM updated_at)*1000)::text AS updated_at_ms,
             concurrency_denials::text AS concurrency_denials,
             start_rate_denials::text AS start_rate_denials,
             CASE WHEN last_denied_at IS NULL THEN NULL
               ELSE floor(extract(epoch FROM last_denied_at)*1000)::text END AS last_denied_at_ms
        FROM ${states}
       WHERE budget_name=$1
       FOR UPDATE`, [this.budgetName]);
    const row = stateResult.rows[0];
    if (!row) throw new Error("ingress budget state missing");
    await client.query(`
      DELETE FROM ${leases}
       WHERE budget_name=$1 AND expires_at <= clock_timestamp()`, [this.budgetName]);
    const nowResult = await client.query<{ now_ms: string }>(
      `SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now_ms`,
    );
    const now = safeInteger(nowResult.rows[0]?.now_ms);
    const leaseResult = await client.query<BudgetLeaseRow>(`
      SELECT lease_id::text, floor(extract(epoch FROM expires_at)*1000)::text AS expires_at_ms
        FROM ${leases}
       WHERE budget_name=$1
       ORDER BY lease_id
       LIMIT 65`, [this.budgetName]);
    const rawState = {
      schemaVersion: "upload-ingress-budget-v0.1",
      tokens: finiteNumber(row.tokens),
      updatedAt: safeInteger(row.updated_at_ms),
      leases: Object.fromEntries(leaseResult.rows.map((lease) => [
        lease.lease_id,
        safeInteger(lease.expires_at_ms),
      ])),
      concurrencyDenials: safeInteger(row.concurrency_denials, 1_000_000_000),
      startRateDenials: safeInteger(row.start_rate_denials, 1_000_000_000),
      lastDeniedAtEpoch: row.last_denied_at_ms === null
        ? null : safeInteger(row.last_denied_at_ms),
    } satisfies UploadIngressBudgetState;
    const state = parseUploadIngressBudgetState(rawState, now, policy);
    return { state, now };
  }

  private async persistState(
    client: PostgresClient,
    state: UploadIngressBudgetState,
  ): Promise<void> {
    await client.query(`
      UPDATE ${this.stateTable()}
         SET tokens=$2,
             updated_at=to_timestamp($3::double precision/1000.0),
             concurrency_denials=$4,
             start_rate_denials=$5,
             last_denied_at=CASE WHEN $6::bigint IS NULL THEN NULL
               ELSE to_timestamp($6::double precision/1000.0) END
       WHERE budget_name=$1`, [
      this.budgetName,
      state.tokens,
      state.updatedAt,
      state.concurrencyDenials,
      state.startRateDenials,
      state.lastDeniedAtEpoch,
    ]);
  }

  async acquire(policy: UploadIngressBudgetPolicy): Promise<UploadIngressBudgetDecision> {
    const effectivePolicy = snapshotPolicy(policy);
    return withPostgresMutation(this.pool, async (client) => {
      const { state, now } = await this.lockAndReadState(client, effectivePolicy);
      replenishUploadIngressBudgetTokens(state, now, effectivePolicy);
      dropExpiredUploadIngressLeases(state, now);
      const decision = acquireUploadIngressBudgetLease(state, effectivePolicy, now);
      if (decision.allowed && decision.leaseId !== null) {
        const inserted = await client.query(`
          INSERT INTO ${this.leaseTable()}(budget_name,lease_id,expires_at)
          VALUES($1,$2,to_timestamp($3::double precision/1000.0))`,
        [this.budgetName, decision.leaseId, state.leases[decision.leaseId]]);
        if (inserted.rowCount !== 1) throw new Error("ingress lease insert failed");
      }
      await this.persistState(client, state);
      return decision;
    }, { operation: "ingress_budget.acquire" });
  }

  async renew(leaseId: string, policy: UploadIngressBudgetPolicy): Promise<boolean> {
    const effectivePolicy = snapshotPolicy(policy);
    return withPostgresMutation(this.pool, async (client) => {
      const { state, now } = await this.lockAndReadState(client, effectivePolicy);
      replenishUploadIngressBudgetTokens(state, now, effectivePolicy);
      dropExpiredUploadIngressLeases(state, now);
      const renewed = renewUploadIngressBudgetLease(state, leaseId, effectivePolicy, now);
      if (renewed) {
        const result = await client.query(`
          UPDATE ${this.leaseTable()}
             SET expires_at=to_timestamp($3::double precision/1000.0)
           WHERE budget_name=$1 AND lease_id=$2`,
        [this.budgetName, leaseId, state.leases[leaseId]]);
        if (result.rowCount !== 1) throw new Error("ingress lease renew failed");
      }
      await this.persistState(client, state);
      return renewed;
    }, { operation: "ingress_budget.renew" });
  }

  async probe(policy: UploadIngressBudgetPolicy): Promise<boolean> {
    const effectivePolicy = snapshotPolicy(policy);
    return withPostgresMutation(this.pool, async (client) => {
      const { state, now } = await this.lockAndReadState(client, effectivePolicy);
      replenishUploadIngressBudgetTokens(state, now, effectivePolicy);
      dropExpiredUploadIngressLeases(state, now);
      await this.persistState(client, state);
      return true;
    }, { operation: "ingress_budget.probe" });
  }

  async status(policy: UploadIngressBudgetPolicy): Promise<UploadIngressBudgetStatus> {
    const effectivePolicy = snapshotPolicy(policy);
    return withPostgresMutation(this.pool, async (client) => {
      const { state, now } = await this.lockAndReadState(client, effectivePolicy);
      replenishUploadIngressBudgetTokens(state, now, effectivePolicy);
      dropExpiredUploadIngressLeases(state, now);
      await this.persistState(client, state);
      return uploadIngressBudgetStatus(state, effectivePolicy);
    }, { operation: "ingress_budget.status" });
  }

  async release(leaseId: string): Promise<void> {
    if (typeof leaseId !== "string" || !UPLOAD_INGRESS_BUDGET_LEASE_ID.test(leaseId)) return;
    return withPostgresMutation(this.pool, async (client) => {
      const result = await client.query(`
        SELECT budget_name
          FROM ${this.stateTable()}
         WHERE budget_name=$1
         FOR UPDATE`, [this.budgetName]);
      if (result.rowCount !== 1) return;
      await client.query(`
        DELETE FROM ${this.leaseTable()}
         WHERE budget_name=$1 AND lease_id=$2`, [this.budgetName, leaseId]);
    }, { operation: "ingress_budget.release" });
  }
}

export function createPostgresUploadIngressBudget(
  pool: PostgresPool,
  schemaOptions: PostgresSchemaOptions = {},
  budgetName: unknown = POSTGRES_UPLOAD_INGRESS_BUDGET_NAME,
): PostgresUploadIngressBudget {
  return new PostgresUploadIngressBudget(pool, schemaOptions, budgetName);
}
