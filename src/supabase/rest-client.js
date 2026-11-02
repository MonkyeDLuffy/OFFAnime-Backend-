/**
 * Generic PostgREST client for backend-owned Supabase tables (thin wrapper).
 *
 * This is infrastructure shared by user-related serverless features (login
 * attempt limiting, signup duplicate-suppression, watchlist persistence). It:
 *   - Authenticates with EITHER the server-side service-role key (backend-owned
 *     tables that bypass RLS) OR with a USER access token forwarded to
 *     PostgREST (`apikey: anon` + `Authorization: Bearer <user token>`), which
 *     makes Postgres evaluate row-level security AS THAT USER for user-owned
 *     tables. It NEVER mixes both modes on one request.
 *   - Captures non-2xx response BODIES before throwing, so failures carry the
 *     exact upstream status, PostgREST/Postgres error code and message
 *     (`42P01` missing table, `42501` RLS denial, `23505` duplicates...) - no
 *     more opaque "HTTP 500-ish" infrastructure logs.
 *   - Sends credentials ONLY in headers (never URLs, never logs).
 *
 * This client knows nothing about feature semantics (locks, rows, ownership);
 * services own that behavior.
 */

import { config } from '../config/env.js';
import { httpRequest } from '../providers/http-client.js';

export class PostgrestClient {
  /**
   * @param {object} params
   * @param {string} params.url          Supabase project URL.
   * @param {string} params.apiKey       `apikey` header value (anon or
   *   service-role key - the corresponding role's privileges apply).
   * @param {string} [params.accessToken] When present, requests act AS THAT
   *   USER (RLS applies to their role/uid). Overrides the Bearer credential.
   * @param {number} [params.timeoutMs]
   */
  constructor({ url, apiKey, accessToken, timeoutMs } = {}) {
    this._baseUrl = String(url ?? '').replace(/\/+$/, '');
    this._apiKey = apiKey;
    this._timeoutMs = timeoutMs ?? config.REQUEST_TIMEOUT_MS;
    // Credentials are sent ONLY via headers - never in URLs, never logged.
    this._headers = {
      apikey: apiKey,
      // User-token mode: RLS evaluates as the verified USER (never the
      // service role - that would bypass per-user policies).
      Authorization: `Bearer ${accessToken ?? apiKey}`,
      Accept: 'application/json',
    };
  }

  /** @returns {string} */
  _tableUrl(table) {
    return `${this._baseUrl}/rest/v1/${table}`;
  }

  /**
   * @param {string} table
   * @param {object} [options]
   * @param {Record<string, string|number>} [options.filters] equality filters.
   * @param {string} [options.columns] select projection (default '*').
   * @param {number} [options.limit]
   * @param {string} [options.order] PostgREST order spec (e.g. "added_at.desc").
   * @returns {Promise<unknown[]>}
   */
  async select(table, { filters = {}, columns = '*', limit, order } = {}) {
    const params = new URLSearchParams({ select: columns });
    for (const [column, value] of Object.entries(filters)) {
      params.append(column, `eq.${value}`);
    }
    if (order) params.append('order', order);
    if (Number.isFinite(limit)) params.append('limit', String(limit));
    const response = await this._request(`${this._tableUrl(table)}?${params.toString()}`, { method: 'GET' }, 'select');
    return Array.isArray(response.data) ? response.data : [];
  }

  /**
   * Call a SQL RPC function with named args.
   * @param {string} fn
   * @param {Record<string, unknown>} params
   * @returns {Promise<unknown>} Parsed JSON return value.
   */
  async rpc(fn, params = {}) {
    const response = await this._request(`${this._baseUrl}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      body: params,
    }, 'rpc');
    return response.data;
  }

  /**
   * Insert a single row. With `onConflict` the insert becomes an upsert.
   * @param {string} table
   * @param {Record<string, unknown>} row
   * @param {object} [options]
   * @param {string} [options.onConflict] Conflict target columns
   *   (comma-separated, must be backed by a unique constraint/index).
   * @param {string} [options.prefer] overrides the Prefer header
   *   (default "return=representation,resolution=merge-duplicates" with
   *   onConflict, "return=representation" without).
   * @returns {Promise<Array>} Returned rows (`[]` when nothing was returned,
   *   e.g. an ignore-duplicates conflict or RLS-hidden row).
   */
  async insert(table, row, { onConflict, prefer } = {}) {
    const url = onConflict !== undefined
      ? `${this._tableUrl(table)}?on_conflict=${encodeURIComponent(onConflict)}`
      : this._tableUrl(table);
    const resolvedPrefer = prefer
      ?? (onConflict !== undefined
        ? 'return=representation,resolution=merge-duplicates'
        : 'return=representation');
    const response = await this._request(url, { method: 'POST', body: row, prefer: resolvedPrefer }, 'insert');
    return Array.isArray(response.data) ? response.data : [];
  }

  /**
   * Delete rows with equality filters.
   * @param {string} table
   * @param {Record<string, string|number>} filters
   * @param {object} [options]
   * @param {string} [options.prefer] default "return=minimal" (204).
   * @returns {Promise<Array>} Deleted rows (`[]` for none).
   */
  async delete(table, filters, { prefer = 'return=minimal' } = {}) {
    const params = new URLSearchParams();
    for (const [column, value] of Object.entries(filters)) {
      params.append(column, `eq.${value}`);
    }
    const response = await this._request(`${this._tableUrl(table)}?${params.toString()}`, {
      method: 'DELETE',
      prefer,
    }, 'delete');
    return Array.isArray(response.data) ? response.data : [];
  }

  /**
   * Perform a request; non-2xx responses throw a precise error that carries
   * `upstreamStatus`, `upstreamCode`, `upstreamMessage` (truncated) so services
   * and logs can pinpoint the exact failing operation. Credentials are never
   * echoed.
   * @param {string} url
   * @param {{ method?: string, body?: unknown, prefer?: string }} options
   * @param {string} operation Short failure label for the error message.
   * @returns {Promise<import('../providers/http-client.js').HttpResponse>}
   */
  async _request(url, options = {}, operation) {
    const { prefer, body, ...rest } = options;
    const response = await httpRequest(url, {
      ...rest,
      provider: 'supabase',
      timeoutMs: this._timeoutMs,
      allowNon2xx: true,
      // JSON bodies are serialized HERE (the shared client passes `body`
      // straight to fetch); plain objects would otherwise become
      // "[object Object]".
      body: body !== undefined ? JSON.stringify(body) : undefined,
      headers: {
        ...this._headers,
        ...(prefer !== undefined ? { Prefer: prefer } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    if (response.ok) return response;
    throw this._upstreamError(response, operation);
  }

  /**
   * Build the precise upstream failure error.
   * @param {import('../providers/http-client.js').HttpResponse} response
   * @param {string} operation
   * @returns {Error}
   */
  _upstreamError(response, operation) {
    const body = response.data;
    const code = typeof body?.code === 'string' ? body.code : undefined;
    const message = typeof body?.message === 'string' ? body.message
      : typeof body?.error_description === 'string' ? body.error_description
        : typeof body?.msg === 'string' ? body.msg : undefined;
    const failure = new Error(
      `supabase PostgREST ${operation} failed with HTTP ${response.status}${code ? ` (${code})` : ''}`,
    );
    failure.name = 'PostgrestUpstreamError';
    failure.upstreamStatus = response.status;
    failure.upstreamCode = code;
    failure.upstreamMessage = typeof message === 'string' ? truncate(message, 200) : undefined;
    return failure;
  }
}

/** @param {string} value @param {number} max */
function truncate(value, max) {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}
