// Node stand-in for the workerd `cloudflare:workers` module, for the dense
// production-code oracle bundle only. d43c8f92's Worker source imports it in
// ingress-budget.ts (the upload ingress Durable Object class, never constructed
// by the scheduled lanes or the public read) and test/helpers/model-history.ts
// (the vitest `env`, unused by the helpers the oracle calls).
export class DurableObject {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
}
export const env = Object.freeze({});
