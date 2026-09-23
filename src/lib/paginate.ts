/**
 * Pagination arithmetic. PURE.
 *
 * Small enough to inline, kept separate because the parts that go wrong are
 * arithmetic — a page left stranded past the end of a shrinking list, an
 * off-by-one in "showing 11–20 of 37" — and those deserve tests rather than a
 * second look at the JSX.
 *
 * PAGINATION IS PRESENTATION. Nothing here filters, sorts, re-ranks or drops a
 * row: it slices a list the caller already decided on. It must be applied AFTER
 * filtering, or page 2 of an unfiltered list gets shown as page 2 of a filtered
 * one and the count in the corner becomes a lie.
 */

export const PAGE_SIZES = [10, 20, 50] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

export interface Page<T> {
  items: T[];
  /** Clamped into range. Never returns a page that does not exist. */
  page: number;
  totalPages: number;
  total: number;
  /** 1-based inclusive bounds of what is on screen, for "showing 11–20 of 37". */
  from: number;
  to: number;
  hasPrev: boolean;
  hasNext: boolean;
}

/**
 * Slices one page out of an already-filtered list.
 *
 * `page` is clamped rather than trusted. A filter that shrinks 40 rows to 3
 * leaves the caller holding page 4, and the honest answer is the last real
 * page, not an empty table with "Page 4 of 1" underneath it.
 */
export function paginate<T>(items: readonly T[], page: number, size: number): Page<T> {
  const total = items.length;
  const perPage = Math.max(1, Math.floor(size) || 1);
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const clamped = Math.min(Math.max(1, Math.floor(page) || 1), totalPages);
  const start = (clamped - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  return {
    items: slice,
    page: clamped,
    totalPages,
    total,
    from: total === 0 ? 0 : start + 1,
    to: start + slice.length,
    hasPrev: clamped > 1,
    hasNext: clamped < totalPages,
  };
}

/** "Page 2 of 4", or "Page 1 of 1" on an empty list rather than "Page 1 of 0". */
export const pageLabel = (p: Pick<Page<unknown>, "page" | "totalPages">): string =>
  `Page ${p.page} of ${p.totalPages}`;

/** "Showing 11–20 of 37", or a plain zero when there is nothing. */
export const rangeLabel = (p: Pick<Page<unknown>, "from" | "to" | "total">): string =>
  p.total === 0 ? "No rows" : `Showing ${p.from}–${p.to} of ${p.total}`;
