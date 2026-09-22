// The real Worker class is only needed when Wrangler bundles the deployed
// module. PostgreSQL route qualification runs in Node against a local socket;
// this keeps the entrypoint importable without granting Node a fake D1.
export class DurableObject {}
