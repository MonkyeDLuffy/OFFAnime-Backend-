/**
 * RequestCoalescer - de-duplicates concurrent identical operations.
 *
 * If N callers ask for the same key while one operation is already in flight,
 * they all await the SAME promise instead of triggering N provider calls.
 *
 * This is a small, self-contained utility (a Map of in-flight promises), so it
 * is implemented for real here. It is, however, strictly an OPTIMIZATION:
 *
 *   - It only coalesces within a SINGLE process/instance. Across multiple
 *     serverless instances there is no shared memory, so duplicate work can
 *     still happen across instances - that is expected and acceptable.
 *   - Correctness must NEVER depend on coalescing. Cross-instance efficiency is
 *     addressed by the persistent L2 cache, not by this map.
 */

export class RequestCoalescer {
  constructor() {
    /** @type {Map<string, Promise<unknown>>} */
    this._inflight = new Map();
  }

  /**
   * Run `factory` for `key`, sharing an in-flight promise across callers.
   * @template T
   * @param {string} key
   * @param {() => Promise<T>} factory
   * @returns {Promise<T>}
   */
  run(key, factory) {
    const existing = this._inflight.get(key);
    if (existing) return /** @type {Promise<T>} */ (existing);

    // Start the operation and register it before any await so concurrent
    // callers in the same tick join this exact promise.
    const promise = (async () => factory())().finally(() => {
      this._inflight.delete(key);
    });

    this._inflight.set(key, promise);
    return promise;
  }

  /** Number of operations currently in flight (useful for tests/metrics). */
  get size() {
    return this._inflight.size;
  }
}
