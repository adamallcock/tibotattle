import assert from "node:assert/strict";
import test from "node:test";

import {
  renderParticipantIdentityBackendMode,
  renderParticipantIdentityFileResidueState,
  renderParticipantIdentitySourceState,
} from "../local-review/identity-presentation.js";

test("local identity presentation exposes only closed vocabularies", () => {
  assert.equal(
    renderParticipantIdentityBackendMode("macos_keychain"),
    "macos_keychain",
  );
  assert.equal(renderParticipantIdentityBackendMode("PRIVATE"), "invalid");
  assert.equal(
    renderParticipantIdentitySourceState({ source: "environment" }),
    "external_override",
  );
  assert.equal(
    renderParticipantIdentitySourceState({ source: "secret_backend" }),
    "keychain",
  );
  assert.equal(
    renderParticipantIdentitySourceState({ status: "PRIVATE" }),
    "invalid",
  );
  assert.equal(
    renderParticipantIdentityFileResidueState("retired_removed"),
    "absent",
  );
  assert.equal(
    renderParticipantIdentityFileResidueState("retired_retained"),
    "retained",
  );
  assert.equal(
    renderParticipantIdentityFileResidueState("PRIVATE"),
    "invalid",
  );
});
