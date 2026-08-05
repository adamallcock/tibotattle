import { ApiError } from "./errors";

/**
 * Wall-clock limits for a request body. Byte limits alone do not bound the
 * lifetime of a slot when a peer deliberately dribbles a valid request.
 */
export interface BoundedBodyReadPolicy {
  readonly maximumTotalMilliseconds: number;
  readonly maximumIdleMilliseconds: number;
}

function timeoutError(): ApiError {
  return new ApiError(408, "BODY_TIMEOUT");
}

function validPolicy(policy: BoundedBodyReadPolicy): boolean {
  return Number.isSafeInteger(policy.maximumTotalMilliseconds)
    && Number.isSafeInteger(policy.maximumIdleMilliseconds)
    && policy.maximumTotalMilliseconds >= 1
    && policy.maximumIdleMilliseconds >= 1
    && policy.maximumIdleMilliseconds <= policy.maximumTotalMilliseconds;
}

async function readWithDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maximumWaitMilliseconds: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(timeoutError()), maximumWaitMilliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Read an incoming body subject to byte, total wall-clock, and inter-chunk
 * idle limits. The cancellation path is important: it propagates the timeout
 * to the peer and lets a caller's finally block promptly release any shared
 * admission lease it holds.
 */
export async function readBoundedRequestBody(
  request: Request,
  maximumBytes: number,
  policy: BoundedBodyReadPolicy,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || !validPolicy(policy)) {
    throw new TypeError("Invalid bounded request body policy");
  }
  if (!request.body) throw new ApiError(400, "BODY_INVALID");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  const startedAt = Date.now();
  let total = 0;
  let completed = false;
  try {
    while (true) {
      const remainingTotalMilliseconds = policy.maximumTotalMilliseconds
        - (Date.now() - startedAt);
      if (remainingTotalMilliseconds <= 0) throw timeoutError();
      const result = await readWithDeadline(
        reader,
        Math.min(policy.maximumIdleMilliseconds, remainingTotalMilliseconds),
      );
      if (result.done) {
        completed = true;
        break;
      }
      total += result.value.byteLength;
      if (total > maximumBytes) throw new ApiError(413, "BODY_TOO_LARGE");
      chunks.push(result.value);
    }
  } catch (error) {
    if (!completed) {
      try {
        // Do not await an untrusted stream's cancellation promise. A peer can
        // make an underlying source slow or non-settling precisely when this
        // path matters; propagation is best-effort, while the caller must be
        // able to release its admission lease immediately.
        void reader.cancel(error).catch(() => {});
      } catch {
        // The original bounded-read failure is the client-visible outcome.
      }
    }
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "BODY_INVALID");
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A cancelled reader can already have released its lock in a runtime.
    }
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}
