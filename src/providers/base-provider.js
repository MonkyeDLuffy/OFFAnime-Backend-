/**
 * BaseProvider - shared behavior for every external provider.
 *
 * Concrete providers (AniList/Jikan/TMDB/MegaPlay) extend this class. It gives
 * them a consistent constructor (name + baseUrl + logger) and a `request`
 * helper that delegates to the portable HTTP client while tagging calls with
 * the provider name for logs and typed errors.
 *
 * What belongs in a subclass:  endpoint-specific methods (e.g. `getAnimeById`).
 * What does NOT belong here:    normalization (that's the normalizers' job) and
 *                               any knowledge of the frontend.
 *
 * Phase 1 ships only this base + thin subclasses whose data methods throw
 * NotImplementedError. No real endpoints are called yet.
 */

import { httpRequest } from './http-client.js';
import { logger } from '../utils/logger.js';

export class BaseProvider {
  /**
   * @param {object} params
   * @param {string} params.name    Provider id (see PROVIDERS).
   * @param {string} params.baseUrl Root URL for this provider's API.
   */
  constructor({ name, baseUrl }) {
    if (!name) throw new Error('BaseProvider requires a name');
    this.name = name;
    this.baseUrl = baseUrl ? String(baseUrl).replace(/\/+$/, '') : '';
    this.log = logger.child({ provider: name });
  }

  /**
   * Build an absolute URL from a path (or return an absolute path unchanged).
   * @param {string} [path='']
   * @returns {string}
   */
  buildUrl(path = '') {
    if (/^https?:\/\//i.test(path)) return path;
    if (!path) return this.baseUrl;
    return `${this.baseUrl}/${String(path).replace(/^\/+/, '')}`;
  }

  /**
   * Perform a request scoped to this provider. Thin wrapper around the shared
   * HTTP client that injects the provider name for logging/error tagging.
   * @param {string} path Absolute URL or path relative to `baseUrl`.
   * @param {import('./http-client.js').HttpRequestOptions} [options]
   * @returns {Promise<import('./http-client.js').HttpResponse>}
   */
  request(path, options = {}) {
    return httpRequest(this.buildUrl(path), { ...options, provider: this.name });
  }
}
