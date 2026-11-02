/**
 * Client IP extraction for anti-abuse layers (rate-limit buckets, optional
 * Supabase Auth IP forwarding).
 *
 * The app runs behind proxies (Vercel / Cloudflare): Express is configured
 * with `trust proxy`, so `req.ip` already resolves the forwarded chain there.
 * The explicit header fallbacks cover adapter runtimes where `req.ip` is not
 * useful (e.g. the Cloudflare Pages shim provides an empty socket address).
 *
 * Returns null when no source IP can be determined - callers MUST treat that
 * as "IP layer unavailable" (skip the IP bucket) rather than inventing a
 * shared pseudo-IP that would throttle unrelated users together.
 */

/**
 * @param {import('express').Request} req
 * @returns {string | null}
 */
export function extractClientIp(req) {
  const direct = typeof req.ip === 'string' ? req.ip.trim() : '';
  if (direct) return direct;
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') {
    const first = forwarded.split(',')[0].trim();
    if (first) return first;
  }
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real.trim()) return real.trim();
  return null;
}
