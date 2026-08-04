import { ApiError } from "./errors";

/**
 * Queues are intentionally not bound or active yet. The synchronous path is
 * still the source of the accepted receipt, and an envelope may be 2 MiB while
 * a Queue message is much smaller. Enabling a Queue therefore needs an R2
 * pointer protocol, idempotent consumer receipts, deletion-race handling, a
 * DLQ, and separately measured consumer concurrency.
 */
export const DEFERRED_UPLOAD_QUEUE_INGRESS = Object.freeze({
  mode: "disabled",
  schemaVersion: "deferred-upload-queue-ingress-v0.1",
  activationRequires: Object.freeze([
    "r2_pointer_protocol",
    "idempotent_consumer_receipts",
    "deletion_race_policy",
    "dead_letter_observability",
    "measured_consumer_concurrency",
  ]),
});

export function assertDeferredUploadQueueIngress(env: Env): void {
  if (Reflect.get(env, "UPLOAD_INGRESS_QUEUE_MODE") !== "disabled") {
    throw new ApiError(503, "ADMISSION_CONFIGURATION_INVALID");
  }
}
