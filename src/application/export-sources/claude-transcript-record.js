const MAXIMUM_JSON_DEPTH = 256;
const ARRAY_ITEMS = Symbol("array_items");
const LEAF = Symbol("leaf");

const CACHE_SELECTOR = Object.freeze({
  ephemeral_5m_input_tokens: LEAF,
  ephemeral_1h_input_tokens: LEAF,
});

const ITERATION_SELECTOR = Object.freeze({
  type: LEAF,
  model: LEAF,
  input_tokens: LEAF,
  cache_read_input_tokens: LEAF,
  cache_creation_input_tokens: LEAF,
  output_tokens: LEAF,
  cache_creation: CACHE_SELECTOR,
});

const USAGE_SELECTOR = Object.freeze({
  input_tokens: LEAF,
  cache_read_input_tokens: LEAF,
  cache_creation_input_tokens: LEAF,
  output_tokens: LEAF,
  cache_creation: CACHE_SELECTOR,
  iterations: Object.freeze({ [ARRAY_ITEMS]: ITERATION_SELECTOR }),
  speed: LEAF,
});

const CONTENT_SELECTOR = Object.freeze({
  type: LEAF,
  id: LEAF,
  name: LEAF,
});

const RECORD_SELECTOR = Object.freeze({
  type: LEAF,
  sessionId: LEAF,
  timestamp: LEAF,
  isSidechain: LEAF,
  agentId: LEAF,
  message: Object.freeze({
    id: LEAF,
    model: LEAF,
    usage: USAGE_SELECTOR,
    content: Object.freeze({ [ARRAY_ITEMS]: CONTENT_SELECTOR }),
  }),
});

export class ClaudeTranscriptRecordParseError extends Error {
  constructor() {
    super("Claude transcript row is not valid JSON");
    this.name = "ClaudeTranscriptRecordParseError";
    this.code = "claude_transcript_record_invalid_json";
  }
}

function invalid() {
  throw new ClaudeTranscriptRecordParseError();
}

function whitespace(code) {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function digit(code) {
  return code >= 0x30 && code <= 0x39;
}

function hex(code) {
  return digit(code)
    || (code >= 0x41 && code <= 0x46)
    || (code >= 0x61 && code <= 0x66);
}

function parseJsonString(text, start, end) {
  try {
    return JSON.parse(text.slice(start, end));
  } catch {
    invalid();
  }
}

/**
 * Validate a complete Claude JSONL row while retaining only accounting fields.
 * Large prompt, response, thinking, and tool-input strings are walked in place
 * and never copied into the returned object.
 */
export function parseClaudeTranscriptRecord(text) {
  if (typeof text !== "string") invalid();
  let offset = 0;

  function skipWhitespace() {
    while (offset < text.length && whitespace(text.charCodeAt(offset))) offset += 1;
  }

  function stringBounds() {
    if (text.charCodeAt(offset) !== 0x22) invalid();
    const start = offset;
    offset += 1;
    while (offset < text.length) {
      const code = text.charCodeAt(offset);
      if (code === 0x22) {
        offset += 1;
        return { start, end: offset };
      }
      if (code < 0x20) invalid();
      if (code !== 0x5c) {
        offset += 1;
        continue;
      }
      offset += 1;
      if (offset >= text.length) invalid();
      const escape = text.charCodeAt(offset);
      if (escape === 0x75) {
        if (offset + 4 >= text.length) invalid();
        for (let index = 1; index <= 4; index += 1) {
          if (!hex(text.charCodeAt(offset + index))) invalid();
        }
        offset += 5;
      } else if (escape === 0x22 || escape === 0x5c || escape === 0x2f
          || escape === 0x62 || escape === 0x66 || escape === 0x6e
          || escape === 0x72 || escape === 0x74) {
        offset += 1;
      } else {
        invalid();
      }
    }
    invalid();
  }

  function numberBounds() {
    const start = offset;
    if (text.charCodeAt(offset) === 0x2d) offset += 1;
    if (offset >= text.length) invalid();
    if (text.charCodeAt(offset) === 0x30) {
      offset += 1;
      if (offset < text.length && digit(text.charCodeAt(offset))) invalid();
    } else {
      if (!digit(text.charCodeAt(offset))) invalid();
      while (offset < text.length && digit(text.charCodeAt(offset))) offset += 1;
    }
    if (text.charCodeAt(offset) === 0x2e) {
      offset += 1;
      if (!digit(text.charCodeAt(offset))) invalid();
      while (offset < text.length && digit(text.charCodeAt(offset))) offset += 1;
    }
    const exponent = text.charCodeAt(offset);
    if (exponent === 0x65 || exponent === 0x45) {
      offset += 1;
      const sign = text.charCodeAt(offset);
      if (sign === 0x2b || sign === 0x2d) offset += 1;
      if (!digit(text.charCodeAt(offset))) invalid();
      while (offset < text.length && digit(text.charCodeAt(offset))) offset += 1;
    }
    return { start, end: offset };
  }

  function literal(value) {
    if (!text.startsWith(value, offset)) invalid();
    offset += value.length;
  }

  function parseValue(selector, depth) {
    if (depth > MAXIMUM_JSON_DEPTH) invalid();
    skipWhitespace();
    const code = text.charCodeAt(offset);
    if (code === 0x7b) return parseObject(selector, depth + 1);
    if (code === 0x5b) return parseArray(selector, depth + 1);
    if (code === 0x22) {
      const bounds = stringBounds();
      return selector === null ? undefined : parseJsonString(text, bounds.start, bounds.end);
    }
    if (code === 0x74) {
      literal("true");
      return selector === null ? undefined : true;
    }
    if (code === 0x66) {
      literal("false");
      return selector === null ? undefined : false;
    }
    if (code === 0x6e) {
      literal("null");
      return selector === null ? undefined : null;
    }
    if (code === 0x2d || digit(code)) {
      const bounds = numberBounds();
      if (selector === null) return undefined;
      const value = Number(text.slice(bounds.start, bounds.end));
      if (!Number.isFinite(value)) invalid();
      return value;
    }
    invalid();
  }

  function parseObject(selector, depth) {
    const selected = selector !== null;
    const fieldSelectors = selected && selector !== LEAF && selector?.[ARRAY_ITEMS] === undefined
      ? selector : null;
    const result = selected ? {} : undefined;
    offset += 1;
    skipWhitespace();
    if (text.charCodeAt(offset) === 0x7d) {
      offset += 1;
      return result;
    }
    for (;;) {
      skipWhitespace();
      const bounds = stringBounds();
      const key = fieldSelectors === null
        ? null : parseJsonString(text, bounds.start, bounds.end);
      skipWhitespace();
      if (text.charCodeAt(offset) !== 0x3a) invalid();
      offset += 1;
      const childSelector = key !== null && Object.hasOwn(fieldSelectors, key)
        ? fieldSelectors[key] : null;
      const value = parseValue(childSelector, depth);
      if (childSelector !== null) result[key] = value;
      skipWhitespace();
      const separator = text.charCodeAt(offset);
      if (separator === 0x7d) {
        offset += 1;
        return result;
      }
      if (separator !== 0x2c) invalid();
      offset += 1;
    }
  }

  function parseArray(selector, depth) {
    const selected = selector !== null;
    const itemSelector = selected && selector !== LEAF ? selector?.[ARRAY_ITEMS] ?? null : null;
    const result = selected ? [] : undefined;
    offset += 1;
    skipWhitespace();
    if (text.charCodeAt(offset) === 0x5d) {
      offset += 1;
      return result;
    }
    for (;;) {
      const value = parseValue(itemSelector, depth);
      if (selected) result.push(value);
      skipWhitespace();
      const separator = text.charCodeAt(offset);
      if (separator === 0x5d) {
        offset += 1;
        return result;
      }
      if (separator !== 0x2c) invalid();
      offset += 1;
    }
  }

  const record = parseValue(RECORD_SELECTOR, 0);
  skipWhitespace();
  if (offset !== text.length) invalid();
  return record;
}
