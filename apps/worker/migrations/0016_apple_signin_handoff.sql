PRAGMA foreign_keys = ON;

-- Web Sign in with Apple needs an HTTPS redirect_uri and posts its result
-- back with response_mode=form_post, so the provider callback lands on this
-- Worker rather than on the page that started the flow. This table is the
-- only bridge between those two requests: the start route mints an
-- unguessable state, Apple's callback attaches the returned id_token to that
-- exact row, and the originating page reads it back once.
--
-- The row is deliberately content-free apart from the short-lived id_token.
-- No participant id, subject, email, name, IP, or user-agent is stored, and
-- nothing here is joined to participants — enrollment verifies the token and
-- keeps only the pairwise identity link key. Rows are single-use
-- (consumed_at) and short-lived (expires_at, five minutes); the result route
-- deletes expired rows opportunistically so an unfinished sign-in leaves no
-- residue.
CREATE TABLE apple_signin_handoffs (
  state TEXT PRIMARY KEY NOT NULL,
  id_token TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
) STRICT;

CREATE INDEX apple_signin_handoffs_expires_at
  ON apple_signin_handoffs (expires_at);
