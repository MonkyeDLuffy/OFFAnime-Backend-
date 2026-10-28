/**
 * Supabase REST client (thin PostgREST wrapper).
 *
 * Server-only infrastructure for the L2 cache. Uses the project's existing
 * shared HTTP abstraction (providers/http-client.js - portable fetch with
 * timeout and typed errors) - no @supabase/supabase-js dependency, no second
 * HTTP client.
 *
 * Credential handling: the Supabase key is sent ONLY in request headers
 * (`apikey` + `Authorization: Bearer`), never in URLs, never logged, never
 * returned in API responses, never hardcoded.
 *
 * This client knows nothing about cache semantics (fresh/stale) - it only
 * performs PostgREST operations. The SupabaseStore owns cache behavior.
 */

import { httpRequest } from '../../providers/http-client.js';

const REST_PATH = '/rest/v1';
const TABLE = 'cache_entries';

export class SupabaseRestClient {
  /**
   * @param {object} params
   * @param {string} params.url     Supabase project URL.
   * @param {string} params.apiKey  Service-role (preferred) or anon key.
   * @param {number} [params.timeoutMs] Overrides the default request timeout.
   */
  constructor({ url, apiKey, timeoutMs }) {
    this._baseUrl = String(url).replace(/\/+$/, '');
    this._apiKey = apiKey;
    this._timeoutMs = timeoutMs;
    // The key is sent ONLY via headers - never in URLs or query strings.
    this._headers = {
      apikey: apiKey,
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
  }

  /** @returns {string} */
  _tableUrl() {
    return `${this._baseUrl}${REST_PATH}/${TABLE}`;
  }

  /**
   * Perform a request scoped to Supabase (provider tag for logs/errors).
   * @param {string} pathOrUrl
   * @param {{ method?: string, body?: unknown, prefer?: string }} [options]
   * @returns {Promise<import('../../providers/http-client.js').HttpResponse>}
   */
  _request(pathOrUrl, { method = 'GET', body, prefer } = {}) {
    return httpRequest(pathOrUrl.startsWith('http') ? pathOrUrl : `${this._baseUrl}${pathOrUrl}`, {
      method,
      headers: prefer ? { ...this._headers, Prefer: prefer } : this._headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      provider: 'supabase',
      ...(this._timeoutMs !== undefined ? { timeoutMs: this._timeoutMs } : {}),
    });
  }

  /**
   * Select rows with equality filters (e.g. { namespace, cache_key }).
   * @param {Record<string, string>} filters
   * @returns {Promise<unknown[]>} Rows (empty array when nothing matches).
   */
  async select(filters) {
    const params = new URLSearchParams({ select: '*' });
    for (const [column, value] of Object.entries(filters)) {
      params.append(column, `eq.${value}`);
    }
    const response = await this._request(`${this._tableUrl()}?${params.toString()}`);
    const data = response.data;
    if (!Array.isArray(data)) {
      const err = new Error('Supabase returned a non-array response for a select operation');
      err.details = { provider: 'supabase' };
      throw err;
    }
    return data;
  }

  /**
   * Atomic upsert against the unique (namespace, cache_key) identity.
   * `merge-duplicates` generates INSERT ... ON CONFLICT DO UPDATE for the
   * provided columns, so concurrent instances can populate the same key
   * safely without a SELECT-then-INSERT race.
   * @param {Record<string, unknown>} row
   * @returns {Promise<void>}
   */
  async upsert(row) {
    await this._request(this._tableUrl(), {
      method: 'POST',
      body: row,
      // created_at is intentionally omitted from the payload: its column
      // default applies on insert, and the existing value is preserved on
      // conflict (only provided columns are updated).
      prefer: 'resolution=merge-duplicates,return=minimal',
    });
  }

  /**
   * Delete rows with equality filters.
   * @param {Record<string, string>} filters
   * @returns {Promise<void>}
   */
  async delete(filters) {
    const params = new URLSearchParams();
    for (const [column, value] of Object.entries(filters)) {
      params.append(column, `eq.${value}`);
    }
    await this._request(`${this._tableUrl()}?${params.toString()}`, { method: 'DELETE' });
  }

  /**
   * Delete ALL rows from the cache table (clear). Use with care - this is a
   * cache table only.
   * @returns {Promise<void>}
   */
  async deleteAll() {
    await this._request(this._tableUrl(), { method: 'DELETE' });
  }
}
