export function assertHttpSmokeCachePolicy(response, { method, pathname }) {
  // Only this successful public read has a shared cache lifetime. Private
  // responses, failures, and every other route retain the no-store contract.
  const publicCommunityDaily = method === "GET"
    && pathname === "/api/v1/community/daily"
    && response.status === 200;
  const expected = publicCommunityDaily ? "public, max-age=300" : "no-store";
  if (response.headers.get("cache-control") !== expected) {
    throw new Error("The backend returned an unexpected cache policy.");
  }
  if (publicCommunityDaily && response.headers.has("set-cookie")) {
    throw new Error("The public community response unexpectedly set a cookie.");
  }
}
