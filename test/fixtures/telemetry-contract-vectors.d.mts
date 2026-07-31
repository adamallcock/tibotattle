export interface TelemetryContractAdversarialVector {
  readonly label: string;
  readonly value: Record<string, unknown>;
  readonly code:
    | "ENVELOPE_INVALID"
    | "PRIVACY_CANARY_DETECTED"
    | "TELEMETRY_RECORD_INVALID";
  readonly detailCode: string;
}

export function telemetryV01Golden(): Record<string, unknown>;
export function telemetryV02Golden(): Record<string, unknown>;
export function telemetryV02LegacyIdGolden(): Record<string, unknown>;
export function telemetryEnvelopeGolden(): Record<string, unknown>;
export function telemetryContractAdversarialVectors():
  readonly TelemetryContractAdversarialVector[];
export function telemetryEnvelopeAdversarialVectors():
  readonly Readonly<{
    label: string;
    value: Record<string, unknown>;
  }>[];
