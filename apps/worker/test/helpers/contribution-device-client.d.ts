import type { Buffer } from "node:buffer";

interface DeviceSecretBinding {
  origin: string;
  deviceId: string;
  currentSecret: Buffer;
}
interface DeviceRotationOptions {
  expectedOrigin: string;
  deriveSecret(binding: DeviceSecretBinding): Buffer;
  performRemoteRotation(binding: DeviceSecretBinding & { nextDeviceSecretHash: string }):
    Promise<{ committed: true; expiresAt: string }>;
}
export function claimContributionDevicePairing(options: {
  origin: string;
  pairingCode: string;
  fetchImpl: (url: URL, init: RequestInit) => Promise<Response>;
  ensureCapability: (options: { origin: string }) => Promise<{
    origin: string; deviceId: string; deviceSecretHash: string; status?: "created" | "existing";
  }>;
  rotate: (options: DeviceRotationOptions) => Promise<{
    status: "renewed"; origin: string; deviceId: string; expiresAt: string;
  }>;
}): Promise<{ status: "paired"; origin: string; deviceId: string; scope: "upload_registration"; expiresAt: string }>;
