// The Cloud Run image runtime (Node v22.16.0) for specs that run an entry or a
// built bundle under it. The hosted postgres-17-suite job installs it and names
// it EDGE_E2E_NODE, which the suite passes to every pass; a developer machine
// falls back to nvm's install.
import { homedir } from "node:os";
import { join } from "node:path";

export const IMAGE_NODE = process.env.EDGE_E2E_NODE || join(homedir(), ".nvm/versions/node/v22.16.0/bin/node");
