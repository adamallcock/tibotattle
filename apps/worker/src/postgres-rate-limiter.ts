import {
  createPostgresSchemaConfig,
  quotePostgresIdentifier,
  withPostgresMutation,
  type PostgresClient,
  type PostgresPool,
  type PostgresSchemaOptions,
} from "./postgres-client";

const LIMITER_NAME = /^[A-Z][A-Z0-9_]{0,79}$/u;
const KEY_MAX_BYTES = 1_024;
const KEY_DIGEST_BYTES = 32;
const MAX_LIMIT = 10_000;
const MAX_PERIOD_SECONDS = 86_400;
const encoder = new TextEncoder();

interface RateLimitBucketRow {
  readonly window_started_at_ms: string;
  readonly used_count: number | string;
}

export interface PostgresRateLimiterOptions extends PostgresSchemaOptions {
  readonly name: unknown;
  readonly limit: unknown;
  readonly periodSeconds: unknown;
  /** A deployment secret used to make stored bucket identities irreversible. */
  readonly keyHashSecret: string | Uint8Array;
}

export interface PostgresRateLimitResult {
  readonly success: boolean;
}

function invalid(): never {
  throw new TypeError("Invalid PostgreSQL rate limiter configuration");
}

function safePositiveInteger(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) invalid();
  return value as number;
}

function safeName(value: unknown): string {
  if (typeof value !== "string" || !LIMITER_NAME.test(value)) invalid();
  return value;
}

function secretBytes(value: string | Uint8Array): Uint8Array {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < KEY_DIGEST_BYTES) invalid();
  return bytes.slice();
}

function keyBytes(value: unknown): Uint8Array {
  if (typeof value !== "string" || value.length === 0) invalid();
  const bytes = encoder.encode(value);
  if (bytes.byteLength > KEY_MAX_BYTES) invalid();
  return bytes;
}

function numberValue(value: unknown): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("invalid rate bucket value");
  return result;
}

function arrayBufferOf(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

function hex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Fixed-window PostgreSQL equivalent of Cloudflare's simple RateLimit
 * binding. The raw key is HMACed before any database operation; only the
 * digest participates in the primary key and cleanup queries.
 */
export class PostgresRateLimiter {
  readonly name: string;
  readonly limitValue: number;
  readonly periodSeconds: number;
  private readonly pool: PostgresPool;
  private readonly schema: string;
  private readonly keyHashSecret: Uint8Array;

  constructor(pool: PostgresPool, options: PostgresRateLimiterOptions) {
    if (!pool || typeof pool.connect !== "function") invalid();
    const config = createPostgresSchemaConfig(options);
    this.name = safeName(options.name);
    this.limitValue = safePositiveInteger(options.limit, MAX_LIMIT);
    this.periodSeconds = safePositiveInteger(options.periodSeconds, MAX_PERIOD_SECONDS);
    this.keyHashSecret = secretBytes(options.keyHashSecret);
    this.pool = pool;
    this.schema = config.primarySchema;
  }

  private table(): string {
    return `${quotePostgresIdentifier(this.schema)}."postgres_rate_limit_buckets"`;
  }

  private async hashKey(key: string): Promise<string> {
    const material = encoder.encode(`app-usagemonitor/postgres-rate-limit/v1\u0000${this.name}\u0000${key}`);
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      arrayBufferOf(this.keyHashSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return hex(await crypto.subtle.sign("HMAC", cryptoKey, arrayBufferOf(material)));
  }

  private async cleanup(client: PostgresClient): Promise<void> {
    // Keep maintenance bounded under a flood. SKIP LOCKED avoids waiting on a
    // bucket currently being admitted by another instance.
    await client.query(`
      WITH expired AS (
        SELECT limiter_name,key_digest
          FROM ${this.table()}
         WHERE limiter_name=$1
           AND window_started_at < clock_timestamp()
             - ($2::double precision * interval '1 second')
         ORDER BY window_started_at
         FOR UPDATE SKIP LOCKED
         LIMIT 256
      )
      DELETE FROM ${this.table()} bucket
       USING expired
       WHERE bucket.limiter_name=expired.limiter_name
         AND bucket.key_digest=expired.key_digest`, [this.name, this.periodSeconds]);
  }

  async limit(input: { readonly key: string }): Promise<PostgresRateLimitResult> {
    const key = keyBytes(input?.key);
    // Hash before opening a database transaction. No raw request identity is
    // ever bound to SQL or retained in provider diagnostics.
    const keyDigest = await this.hashKey(new TextDecoder().decode(key));
    return withPostgresMutation(this.pool, async (client) => {
      await client.query(`
        INSERT INTO ${this.table()}(limiter_name,key_digest,window_started_at,used_count)
        VALUES($1,$2,clock_timestamp(),0)
        ON CONFLICT (limiter_name,key_digest) DO NOTHING`, [this.name, keyDigest]);
      const result = await client.query<RateLimitBucketRow>(`
        SELECT floor(extract(epoch FROM window_started_at)*1000)::text AS window_started_at_ms,
               used_count
          FROM ${this.table()}
         WHERE limiter_name=$1 AND key_digest=$2
         FOR UPDATE`, [this.name, keyDigest]);
      const row = result.rows[0];
      if (!row) throw new Error("rate bucket missing");
      const nowResult = await client.query<{ now_ms: string }>(
        `SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS now_ms`,
      );
      const now = numberValue(nowResult.rows[0]?.now_ms);
      const started = numberValue(row.window_started_at_ms);
      const used = numberValue(row.used_count);
      const expired = now - started >= this.periodSeconds * 1_000;
      let success = false;
      if (expired) {
        success = true;
        await client.query(`
          UPDATE ${this.table()}
             SET window_started_at=to_timestamp($3::double precision/1000.0), used_count=1
           WHERE limiter_name=$1 AND key_digest=$2`, [this.name, keyDigest, now]);
      } else if (used < this.limitValue) {
        success = true;
        const updated = await client.query(`
          UPDATE ${this.table()}
             SET used_count=used_count+1
           WHERE limiter_name=$1 AND key_digest=$2 AND used_count < $3`,
        [this.name, keyDigest, this.limitValue]);
        if (updated.rowCount !== 1) throw new Error("rate bucket update failed");
      }
      await this.cleanup(client);
      return { success };
    }, { operation: "rate_limit.limit" });
  }
}

export function createPostgresRateLimiter(
  pool: PostgresPool,
  options: PostgresRateLimiterOptions,
): PostgresRateLimiter {
  return new PostgresRateLimiter(pool, options);
}
