/**
 * Shared bounded-concurrency helper.
 *
 * Runs `worker` over `items` with at most `limit` workers in flight - never an
 * unbounded Promise.all across a large catalogue. Results keep the input
 * order; a worker failure is the worker's own concern (it should return a
 * failure descriptor here, never a thrown error that would cancel its peers).
 */

/**
 * Bounded-concurrency map: at most `limit` workers run at once. Results keep
 * the input order.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
export async function mapWithBoundedConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(0, Math.min(limit, items.length)) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
