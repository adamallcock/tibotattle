import { handleRequest } from "../../src/index";

const PUBLIC_ORIGIN = "https://example.test";
const ADMIN_ORIGIN = "https://admin.example.test";
const ACCESS_TEAM_DOMAIN = "erasure-test.cloudflareaccess.com";
const ACCESS_AUD = "e".repeat(64);
const ACCESS_KEY_ID = "owner-erasure-test-key";
let signingMaterial: Promise<{ privateKey: CryptoKey; jwks: string }> | undefined;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function encodedJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function keys(): Promise<{ privateKey: CryptoKey; jwks: string }> {
  signingMaterial ??= (async () => {
    const pair = await crypto.subtle.generateKey({
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    }, true, ["sign", "verify"]);
    if (!("publicKey" in pair)) throw new Error("expected RSA key pair");
    const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    return {
      privateKey: pair.privateKey,
      jwks: JSON.stringify({ keys: [{ ...publicJwk, kid: ACCESS_KEY_ID, alg: "RS256", use: "sig" }] }),
    };
  })();
  return signingMaterial;
}

/** A real, locally signed Access assertion; no participant or auth bypass is seeded. */
export async function ownerErasureRequest(
  runtimeEnv: Env,
  participantId: string,
  claimOverrides: Record<string, unknown> = {},
): Promise<{ request: Request; runtimeEnv: Env }> {
  const material = await keys();
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const input = `${encodedJson({ alg: "RS256", typ: "JWT", kid: ACCESS_KEY_ID })}.${encodedJson({
    aud: [ACCESS_AUD],
    email: "owner@example.test",
    iss: `https://${ACCESS_TEAM_DOMAIN}`,
    sub: "owner-erasure-test-subject",
    iat: nowSeconds,
    nbf: nowSeconds,
    exp: nowSeconds + 600,
    ...claimOverrides,
  })}`;
  const signature = new Uint8Array(await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", material.privateKey, new TextEncoder().encode(input),
  ));
  const ownerEnv = { ...runtimeEnv };
  for (const [key, value] of Object.entries({
    PUBLIC_ORIGIN,
    ACCESS_TEAM_DOMAIN,
    ACCESS_AUD,
    ACCESS_ADMIN_EMAIL: "owner@example.test",
    ACCESS_TEST_JWKS_JSON: material.jwks,
  })) Reflect.set(ownerEnv, key, value);
  return {
    runtimeEnv: ownerEnv,
    request: new Request(`${ADMIN_ORIGIN}/api/v1/admin/action`, {
      method: "POST",
      headers: {
        origin: ADMIN_ORIGIN,
        "content-type": "application/json",
        "x-usage-monitor-admin": "1",
        "cf-access-jwt-assertion": `${input}.${base64Url(signature)}`,
      },
      body: JSON.stringify({
        action: "run_maintenance",
        participantErasure: { participantId, confirmation: "erase_hosted_participant" },
      }),
    }),
  };
}

export async function ownerErase(runtimeEnv: Env, participantId: string): Promise<Response> {
  const fixture = await ownerErasureRequest(runtimeEnv, participantId);
  return handleRequest(fixture.request, fixture.runtimeEnv);
}
