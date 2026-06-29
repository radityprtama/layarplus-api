'use strict';

/**
 * Build a minimal upstream browse API response.
 *
 * Matches the shape returned by /api/movies and /api/series:
 * { data: [...], totalPages, pagination?: { totalPages } }
 *
 * @param {Array}  items       - Raw upstream items (with title, slug, contentType)
 * @param {number} [totalPages=1]
 * @returns {{ data: Array, totalPages: number }}
 */
function browseResponse(items, totalPages) {
  return { data: items, totalPages: totalPages ?? 1 };
}

/**
 * Build the object that cacheService stores for a paginated browse call.
 *
 * The controller unwraps .items and .pagination from this shape.
 *
 * @param {Array}  items        - Mapped media items
 * @param {number} [page=1]
 * @param {number} [totalPages=1]
 * @returns {{ items: Array, pagination: { currentPage: number, totalPages: number, hasNext: boolean } }}
 */
function cachedBrowseResult(items, page, totalPages) {
  const p = page ?? 1;
  const tp = totalPages ?? 1;
  return {
    items,
    pagination: { currentPage: p, totalPages: tp, hasNext: p < tp },
  };
}

/**
 * Build a raw upstream media item (before mapApiItem).
 *
 * @param {string} title
 * @param {string} slug
 * @param {'movie'|'series'} contentType
 * @returns {{ title: string, slug: string, contentType: string }}
 */
function rawMediaItem(title, slug, contentType) {
  return { title, slug, contentType };
}

module.exports = { browseResponse, cachedBrowseResult, rawMediaItem };
