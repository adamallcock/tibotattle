import { describe, expect, it } from "vitest";

import { canonicalPublicRedirectUrl } from "../src/admin-ui";
import { handleRequest } from "../src/index";

function publicOriginBindings(publicOrigin: unknown): Env {
  return { PUBLIC_ORIGIN: publicOrigin } as unknown as Env;
}

describe("public canonical-host routing", () => {
  it("redirects the configured www alias before it reaches static assets", async () => {
    const response = await handleRequest(
      new Request(
        "https://www.tibotattle.com/privacy?utm_source=search&campaign=launch",
      ),
      publicOriginBindings("https://tibotattle.com"),
    );

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(
      "https://tibotattle.com/privacy?utm_source=search&campaign=launch",
    );
  });

  it("continues serving apex assets through the Worker fallback", async () => {
    let fetchedRequest: Request | null = null;
    const assets = {
      fetch: async (request: Request) => {
        fetchedRequest = request;
        return new Response("public asset", {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      },
    };
    const request = new Request("https://tibotattle.com/docs");
    const response = await handleRequest(
      request,
      {
        PUBLIC_ORIGIN: "https://tibotattle.com",
        ASSETS: assets,
      } as unknown as Env,
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("public asset");
    expect(fetchedRequest).toBe(request);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("uses only the pinned public origin and retains the request path and query", () => {
    const environment = publicOriginBindings("https://tibotattle.com");
    expect(canonicalPublicRedirectUrl(
      new URL("https://www.tibotattle.com/docs?ref=mail"),
      environment,
    )).toBe("https://tibotattle.com/docs?ref=mail");
    expect(canonicalPublicRedirectUrl(
      new URL("https://tibotattle.com/docs?ref=mail"),
      environment,
    )).toBeNull();
    expect(canonicalPublicRedirectUrl(
      new URL("https://admin.tibotattle.com/docs?ref=mail"),
      environment,
    )).toBeNull();

    for (const malformedOrigin of [
      "http://tibotattle.com",
      "https://tibotattle.com/",
      "https://tibotattle.com/path",
      "not-a-url",
      "",
      undefined,
    ]) {
      expect(canonicalPublicRedirectUrl(
        new URL("https://www.tibotattle.com/docs?ref=mail"),
        publicOriginBindings(malformedOrigin),
      )).toBeNull();
    }
  });

  it("keeps a network-path pathname on the configured origin", () => {
    const environment = publicOriginBindings("https://tibotattle.com");
    // A `//host` or `/\host` pathname is a network-path reference to the URL
    // constructor; the Location must never leave the canonical origin.
    for (const attack of [
      "https://www.tibotattle.com//attacker.example",
      "https://www.tibotattle.com//attacker.example/path?q=1",
      "https://www.tibotattle.com/\\attacker.example",
      "https://www.tibotattle.com/\\/attacker.example",
    ]) {
      const location = canonicalPublicRedirectUrl(new URL(attack), environment);
      expect(location).not.toBeNull();
      // The one property that matters: the redirect authority is our origin,
      // never the attacker host that the network-path prefix tried to name.
      expect(new URL(location as string).origin).toBe("https://tibotattle.com");
      expect(new URL(location as string).hostname).toBe("tibotattle.com");
    }
    // The leading slash run is collapsed so no confusing `//` Location survives.
    expect(canonicalPublicRedirectUrl(
      new URL("https://www.tibotattle.com//attacker.example"),
      environment,
    )).toBe("https://tibotattle.com/attacker.example");
  });
});
