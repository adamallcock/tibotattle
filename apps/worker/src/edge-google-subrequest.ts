/**
 * The x-real-ip value the thin edge sends on every subrequest to Google: the
 * origin forward (edge-origin-proxy.ts) and the ID-token exchange
 * (edge-google-id-token.ts).
 *
 * Cloudflare documents that a Worker subrequest to a host outside any
 * Cloudflare zone, such as *.run.app or oauth2.googleapis.com, carries the
 * client's address in both CF-Connecting-IP and x-real-ip, and that a Worker
 * can change only x-real-ip
 * (developers.cloudflare.com/fundamentals/reference/http-headers/). The edge
 * therefore always sets x-real-ip to this constant, the address Cloudflare
 * itself substitutes for a cross-zone Worker subrequest, so that header never
 * carries a client value. In a same-zone subrequest Cloudflare copies
 * x-real-ip into CF-Connecting-IP, so the constant also covers that topology.
 *
 * It does not change CF-Connecting-IP on a subrequest to a non-Cloudflare
 * host: no Worker code can. On 2026-10-02 an owner-authorized probe from a
 * workers.dev Worker (scripts/edge-ip-probe) saw neither header reach a Cloud
 * Run service and this constant arrive in x-forwarded-for. The case without
 * the override was not tested, so it stays load-bearing. The production-zone
 * re-run and OD-E6 are in docs/decisions/2026-10-01-thin-worker-edge-proxy.md,
 * section 5.
 */
export const EDGE_SUBREQUEST_REAL_IP_HEADER = "x-real-ip";
export const EDGE_SUBREQUEST_REAL_IP = "2a06:98c0:3600::103";
