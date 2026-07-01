/**
 * Query-parameter coercion shared by the paginated custom routes
 * (`history` / `threads`). Each route keeps its own page-size default
 * and hard cap and passes them in, so the coercion rules stay in one
 * place without collapsing the routes' distinct sizing.
 */

/** Bounds for {@link clampPerPage}. */
export interface PerPageBounds {
  /** Page size used for empty / non-positive / non-numeric inputs. */
  fallback: number;
  /** Hard cap so a misbehaving client can't fetch everything at once. */
  max: number;
}

/** Coerce / clamp a `perPage` value, falling back to `bounds.fallback`. */
export function clampPerPage(value: number | undefined, bounds: PerPageBounds): number {
  if (value === undefined || Number.isNaN(value)) return bounds.fallback;
  const n = Math.trunc(value);
  if (n <= 0) return bounds.fallback;
  return Math.min(n, bounds.max);
}

/**
 * Coerce a Hono query value into a non-negative integer. Returns
 * `undefined` for empty / non-numeric / negative inputs so the caller
 * can apply its built-in defaults.
 */
export function parseIntParam(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.trunc(n);
}
