// Exercise the production v1.2 client modules, not hand-assembled requests.
export {
  readTelemetryV12Capabilities,
  runTelemetryV12Sync,
} from "../../../../src/contribution/telemetry-v12-sync.js";
export { createTelemetryV12Day } from "../../../../src/contribution/telemetry-v12-chunks.js";
export { createTelemetryV12Envelope } from "../../../../src/platform/telemetry-v12-envelope.js";
