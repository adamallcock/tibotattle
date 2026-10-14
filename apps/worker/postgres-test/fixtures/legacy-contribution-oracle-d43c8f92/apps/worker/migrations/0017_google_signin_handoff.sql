PRAGMA foreign_keys = ON;

-- Google sign-in now uses the same server-owned redirect as Apple: the start
-- route mints an unguessable state and its PKCE verifier, Google's redirect
-- lands on this Worker's callback, and the originating page reads the result
-- back once. It replaces a client-side authorization request whose loopback
-- callback handed the code back through window.localStorage — a signal the
-- in-app dashboard can never receive, because the app's web view will not load
-- a provider host and shares no storage with the browser that finishes the
-- sign-in.
--
-- The PKCE verifier lives here rather than in any client: it is minted with
-- the state, read only by this service's own token exchange, and destroyed
-- with the row. The row is otherwise content-free apart from the short-lived
-- id_token. No participant id, subject, email, name, IP, or user-agent is
-- stored, and nothing here is joined to participants — enrollment verifies the
-- token and keeps only the pairwise identity link key. Rows are single-use
-- (consumed_at) and short-lived (expires_at, five minutes); the start and
-- result routes delete expired rows opportunistically so an unfinished sign-in
-- leaves no residue.
CREATE TABLE google_signin_handoffs (
  state TEXT PRIMARY KEY NOT NULL,
  code_verifier TEXT NOT NULL,
  id_token TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
) STRICT;

CREATE INDEX google_signin_handoffs_expires_at
  ON google_signin_handoffs (expires_at);
