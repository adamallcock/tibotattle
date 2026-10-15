const PRIVATE_LOCAL_PATH_PATTERNS = Object.freeze([
  /\bfile(?::|%3a)(?:\/{1,3}|%2f|[A-Z]:[\\/])/iu,
  /(?<![\p{L}\p{N}_.\/:\-])\/(?:Users|home)\/[^/\s"'\x60<>]+(?:\/|(?=$|[\s"'\x60)>.,;:!?]))/iu,
  /(?<![\p{L}\p{N}_.\/:\-])\/root\/[^/\s"'\x60<>]+(?:\/|(?=$|[\s"'\x60)>.,;:!?]))/iu,
  /(?<![\p{L}\p{N}_.\/:\-])\/Volumes\/[^/\s"'\x60<>]+\/(?:Users|home)\/[^/\s"'\x60<>]+(?:\/|(?=$|[\s"'\x60)>.,;:!?]))/iu,
  /(?<![\p{L}\p{N}_.\/:\-])\/mnt\/[^/\s"'\x60<>]+\/(?:Users|home)\/[^/\s"'\x60<>]+(?:\/|(?=$|[\s"'\x60)>.,;:!?]))/iu,
  /(?<![\p{L}\p{N}_.\/:\-])[A-Z]:[\\/]+(?:Users|Documents and Settings|home)[\\/]+[^\\/\s"'\x60<>]+(?:[\\/]+|(?=$|[\s"'\x60)>.,;:!?]))/iu,
  /(?<![\p{L}\p{N}_.\/:\-])\/(?:private\/)?var\/folders\/[^/\s"'\x60<>]+(?:\/|(?=$|[\s"'\x60)>.,;:!?]))/iu,
  /(?<![\p{L}\p{N}_.\/:\-])~[A-Za-z][A-Za-z0-9_.-]*\//u,
]);

function decodePercentEscapes(value) {
  return value.replace(/%([0-9a-f]{2})/giu, (_match, hex) =>
    String.fromCharCode(Number.parseInt(hex, 16)));
}

export function containsPrivateLocalPath(value) {
  if (typeof value !== "string") return false;
  const decoded = decodePercentEscapes(value);
  return PRIVATE_LOCAL_PATH_PATTERNS.some((pattern) =>
    pattern.test(value) || pattern.test(decoded));
}

export function privateLocalPathLines(contents) {
  if (typeof contents !== "string") {
    throw new TypeError("contents must be a string");
  }
  const lines = [];
  for (const [index, line] of contents.split("\n").entries()) {
    if (containsPrivateLocalPath(line)) lines.push(index + 1);
  }
  return Object.freeze(lines);
}
