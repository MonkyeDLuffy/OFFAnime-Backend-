/**
 * Query-string parameter helpers (Phase 7 frontend endpoints).
 *
 * Defensive parsing of untrusted query params: query values can be strings,
 * string arrays, or objects depending on how Express parsed them. These
 * helpers normalize to single values and enforce bounds so arbitrary input
 * never reaches providers (all provider URL construction stays inside
 * provider/query modules - frontend input never controls provider URLs).
 */

import { ValidationError } from '../errors/index.js';

/**
 * Extract the first string value from a query param. Throws when the value
 * exceeds the max length (prevents unbounded query lengths).
 * @param {unknown} value
 * @param {{ maxLength?: number, label?: string }} [options]
 * @returns {string | undefined} Trimmed value, or undefined when absent.
 * @throws {ValidationError} when the value exceeds maxLength.
 */
export function firstString(value, { maxLength = 200, label = 'value' } = {}) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  if (trimmed.length > maxLength) {
    throw new ValidationError(`Invalid ${label}: exceeds max length of ${maxLength}`, { received: trimmed.length });
  }
  return trimmed;
}

/**
 * Extract an optional integer from a query param with bounds.
 * @param {unknown} value
 * @param {{ min?: number, max?: number, label?: string }} [options]
 * @returns {number | undefined}
 * @throws {ValidationError} when present but not a valid bounded integer.
 */
export function optionalInt(value, { min, max, label = 'value' } = {}) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new ValidationError(`Invalid ${label}: expected an integer`, { received: raw });
  }
  if (min !== undefined && n < min) {
    throw new ValidationError(`Invalid ${label}: must be >= ${min}`, { received: n });
  }
  if (max !== undefined && n > max) {
    throw new ValidationError(`Invalid ${label}: must be <= ${max}`, { received: n });
  }
  return n;
}
