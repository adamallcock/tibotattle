import type { BoundedBodyReadPolicy } from "./bounded-body";
import { type UploadIngressBudgetPolicy } from "./ingress-budget";
export declare const UPLOAD_INGRESS_BUDGET_OBJECT_NAME = "upload-ingress-budget-v0.1";
export interface UploadIngressLease {
    leaseId: string;
    policy: UploadIngressBudgetPolicy;
}
export interface UploadIngressLeaseHeartbeat {
    assertActive(): Promise<void>;
    stop(): Promise<void>;
}
export interface UploadIngressBodyReadPolicy extends BoundedBodyReadPolicy {
}
/**
 * A shared ingress lease begins before parsing the envelope. Keep the body
 * read itself strictly shorter than that lease, with a separate idle bound, so
 * a syntactically plausible slow request cannot renew a scarce slot forever.
 */
export declare function uploadIngressBodyReadPolicy(env: Env): UploadIngressBodyReadPolicy;
export declare function assertUploadIngressConfiguration(env: Env): void;
export declare function acquireUploadIngressLease(env: Env): Promise<UploadIngressLease>;
/** ISO-timestamped ingress pressure for the owner operations overview. */
export interface UploadIngressStatus {
    readonly activeLeases: number;
    readonly maximumConcurrent: number;
    readonly availableStartTokens: number;
    readonly burst: number;
    readonly concurrencyDenials: number;
    readonly startRateDenials: number;
    readonly lastDeniedAt: string | null;
}
/**
 * Best-effort read of the shared ingress budget for the owner operations
 * overview. The overview must stay readable during containment or before the
 * budget binding is configured, so every failure degrades to `null` rather
 * than failing the whole authenticated read.
 */
export declare function readUploadIngressStatus(env: Env): Promise<UploadIngressStatus | null>;
export declare function probeUploadIngressBudget(env: Env): Promise<void>;
export declare function renewUploadIngressLease(env: Env, lease: UploadIngressLease): Promise<boolean>;
export declare function startUploadIngressLeaseHeartbeat(env: Env, lease: UploadIngressLease): UploadIngressLeaseHeartbeat;
export declare function releaseUploadIngressLease(env: Env, lease: UploadIngressLease): Promise<void>;
