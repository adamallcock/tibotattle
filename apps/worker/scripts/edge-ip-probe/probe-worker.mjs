// Throwaway edge IP probe: calls the echo exactly as the edge calls Google
// (x-real-ip overwritten with Cloudflare's placeholder) and passes a salted
// hash of the visitor address so the echo can compare without seeing it.
//
// Owner-run tooling, deployed only as a temporary, separately named Worker
// (see README.md); never part of the production Worker's bundle. The constant
// must stay equal to EDGE_SUBREQUEST_REAL_IP in src/edge-google-subrequest.ts.
const PLACEHOLDER = "2a06:98c0:3600::103";
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname !== "/probe") return new Response("not found", { status: 404 });
    const salt = crypto.randomUUID();
    const visitor = request.headers.get("cf-connecting-ip") ?? "";
    const visitorHash = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(salt + visitor)));
    const upstream = await fetch(env.ECHO_URL, { headers: { "x-real-ip": PLACEHOLDER,
      "x-probe-salt": salt, "x-probe-visitor-hash": visitorHash } });
    const echo = await upstream.json();
    return new Response(JSON.stringify({ visitorSeenByWorker: visitor !== "", echo }), {
      headers: { "content-type": "application/json", "cache-control": "no-store" } });
  },
};
