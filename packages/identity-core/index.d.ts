export type IdentitySecret = string | Uint8Array;

export function deriveExportPseudonym(
  secret: IdentitySecret,
  prefix: string,
  subject: string,
): string;

export function deriveExportPseudonymV2(
  secret: IdentitySecret,
  prefix: string,
  subject: string,
): string;
