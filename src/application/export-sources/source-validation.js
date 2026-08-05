const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export function validSha256(value) {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

export function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
