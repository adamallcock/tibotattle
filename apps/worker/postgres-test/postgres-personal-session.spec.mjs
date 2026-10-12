import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const WORKER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vite = await createServer({
  root: WORKER_ROOT,
  configFile: false,
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
});
const personalSession = await vite.ssrLoadModule("/src/postgres-personal-session.ts");

after(async () => vite.close());

function mutationPool({ sessionRows = 1 } = {}) {
  const queries = [];
  let releases = 0;
  return {
    queries,
    get releases() { return releases; },
    async connect() {
      return {
        async query(text, values = []) {
          queries.push({ text, values });
          if (text.startsWith('UPDATE "personal_session_test"."web_sessions"')) {
            return {
              rows: sessionRows === 1 ? [{ id: values[0] }] : [],
              rowCount: sessionRows,
            };
          }
          return { rows: [], rowCount: 0 };
        },
        release() { releases += 1; },
      };
    },
  };
}

test("session logout revokes only that owner's session and unused session grants in one transaction", async () => {
  const pool = mutationPool();
  const participantId = "synthetic-social-owner-a";
  const sessionId = randomUUID();
  await personalSession.revokePostgresPersonalSession(pool, participantId, sessionId, {
    schema: { primarySchema: "personal_session_test" },
  });

  assert.equal(pool.queries[0]?.text, "BEGIN");
  assert.equal(pool.queries.at(-1)?.text, "COMMIT");
  assert.equal(pool.releases, 1);
  const mutations = pool.queries.filter((query) => query.text.startsWith("UPDATE "));
  assert.equal(mutations.length, 3);
  assert.match(mutations[0].text, /WHERE id = \$1 AND participant_id = \$2 AND state = 'active'/u);
  assert.match(mutations[1].text, /issued_by_session_id = \$2 AND state = 'unused'/u);
  assert.match(mutations[2].text, /issued_by_session_id = \$2 AND state = 'unused'/u);
  for (const mutation of mutations) {
    const expectedOwnerAndSession = mutation === mutations[0]
      ? [sessionId, participantId]
      : [participantId, sessionId];
    assert.deepEqual(mutation.values.slice(0, 2), expectedOwnerAndSession);
    assert.match(mutation.values[2], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  }
  assert.equal(mutations[0].values[0], sessionId);
  assert.equal(mutations[0].values[1], participantId);
  assert.equal(mutations[0].values[2], mutations[1].values[2]);
  assert.equal(mutations[0].values[2], mutations[2].values[2]);
});

test("logout refuses a session that is no longer active and rolls back without touching grants", async () => {
  const pool = mutationPool({ sessionRows: 0 });
  await assert.rejects(
    personalSession.revokePostgresPersonalSession(
      pool,
      "synthetic-social-owner-a",
      randomUUID(),
      { schema: { primarySchema: "personal_session_test" } },
    ),
    { status: 401, code: "AUTH_INVALID" },
  );
  assert.equal(pool.queries.filter((query) => query.text.includes('."upload_authorizations"')).length, 0);
  assert.equal(pool.queries.filter((query) => query.text.includes('."device_pairings"')).length, 0);
  assert.equal(pool.queries.at(-1)?.text, "ROLLBACK");
  assert.equal(pool.releases, 1);
});

test("logout validates the configured schema before opening a connection", async () => {
  const pool = mutationPool();
  await assert.rejects(
    personalSession.revokePostgresPersonalSession(
      pool,
      "synthetic-social-owner-a",
      randomUUID(),
      { schema: { primarySchema: "invalid.schema" } },
    ),
    TypeError,
  );
  assert.equal(pool.queries.length, 0);
  assert.equal(pool.releases, 0);
});
