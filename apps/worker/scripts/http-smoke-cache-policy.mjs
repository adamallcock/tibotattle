// Only a successful GET of one of these public reads has a shared cache
// lifetime: the community daily range and the owner-decided community
// model-performance slot (2026-10-10).
const PUBLIC_CACHE_PATHNAMES = new Set([
  "/api/v1/community/daily",
  "/api/v1/community/model-performance",
]);

export function assertHttpSmokeCachePolicy(response, { method, pathname }) {
  // Private responses, failures, and every other route retain the no-store
  // contract.
  const publicCommunityRead = method === "GET"
    && PUBLIC_CACHE_PATHNAMES.has(pathname)
    && response.status === 200;
  const expected = publicCommunityRead ? "public, max-age=300" : "no-store";
  if (response.headers.get("cache-control") !== expected) {
    throw new Error("The backend returned an unexpected cache policy.");
  }
  if (publicCommunityRead && response.headers.has("set-cookie")) {
    throw new Error("The public community response unexpectedly set a cookie.");
  }
}
