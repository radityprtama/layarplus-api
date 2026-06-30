'use strict';

const httpClient = require('../lib/httpClient');
const cache      = require('../lib/cacheService');
const { CACHE_TTL, HOMEPAGE_BUDGET, HOMEPAGE_ROW_SIZE } = require('../config/env');
const { mapApiItem, ensureContentType } = require('../lib/scraper');

const UPSTREAM_HOMEPAGE = () => httpClient.getJson('/api/homepage');

// ─── Section Registry ──────────────────────────────────────────────────────────
//
// Classifies upstream section titles into stable internal categories.
// `matcher` is a RegExp tested against the upstream title (case-insensitive).
// `priority` controls render order (lower = higher on the page).
// `merge: true` means all sections matching this id are combined into one row.
// `maxItems` caps the total pool size during the merge step.
//
// Section titles like "Trending Now", "Trending Worldwide", "Global Trending"
// all classify as id = 'trending'. This makes the backend resilient to upstream
// title changes.

const SECTION_REGISTRY = [
  { id: 'featured',    matcher: /featured/i,              priority: 0,  merge: false, maxItems: 10 },
  { id: 'trending',    matcher: /trending/i,              priority: 10, merge: true,  maxItems: 40 },
  { id: 'recent',      matcher: /recently\s+added|new\s+release/i, priority: 20, merge: true,  maxItems: 40 },
  { id: 'originals',   matcher: /original/i,              priority: 30, merge: false, maxItems: 20 },
  { id: 'collections', matcher: /collection/i,            priority: 40, merge: false, maxItems: 20 },
];

// Human-readable display titles for merged families.
const FAMILY_DISPLAY_TITLES = {
  trending: 'Trending Now',
  recent: 'Recently Added',
};

// Minimum items a row must have after dedup/refill to survive.
const MIN_ROW_ITEMS = 3;

// ─── Classification ────────────────────────────────────────────────────────────

/**
 * Classify an upstream section title into a stable registry category.
 * Returns a shallow copy of the matching registry entry, or a generic
 * 'unclassified' entry if nothing matches.
 */
function classifySection(title) {
  if (!title || typeof title !== 'string') return { id: 'unclassified', priority: 99, merge: false, maxItems: 20 };
  for (const entry of SECTION_REGISTRY) {
    if (entry.matcher.test(title)) return { ...entry };
  }
  return { id: 'unclassified', priority: 99, merge: false, maxItems: 20 };
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function mapSectionItems(section) {
  return (section?.data || []).map(mapApiItem).filter(Boolean);
}

/**
 * Deduplicate an items array by slug, preserving first-seen order.
 */
function dedupeBySlug(items) {
  const seen = new Set();
  return items.filter(item => {
    if (!item.slug || seen.has(item.slug)) return false;
    seen.add(item.slug);
    return true;
  });
}

/**
 * Sort items by popularityScore descending (used for trending merge).
 */
function sortByPopularity(items) {
  return [...items].sort((a, b) => {
    const sa = Number(a.popularityScore ?? a._popularityScore ?? 0);
    const sb = Number(b.popularityScore ?? b._popularityScore ?? 0);
    return (Number.isFinite(sb) ? sb : 0) - (Number.isFinite(sa) ? sa : 0);
  });
}

// ─── Merge Families ────────────────────────────────────────────────────────────

/**
 * Merge classified sections that share the same `id` and have `merge: true`.
 * Returns an array of section objects (one per unique family id + one each for
 * non-merge sections), sorted by priority.
 *
 * @param {Array} classified - Array of { ...registryEntry, rawTitle, items }
 * @param {Array} mixedTrending - Pre-fetched balanced trending fallback
 * @returns {Array} Merged sections, sorted by priority
 */
function mergeFamilies(classified, mixedTrending) {
  const families = {};    // id → { id, priority, merge, maxItems, items, displayTitle }
  const standalone = [];  // non-merge sections

  for (const entry of classified) {
    if (entry.merge) {
      if (!families[entry.id]) {
        families[entry.id] = {
          id: entry.id,
          priority: entry.priority,
          merge: entry.merge,
          maxItems: entry.maxItems,
          items: [],
          displayTitle: FAMILY_DISPLAY_TITLES[entry.id] || entry.rawTitle,
        };
      }
      families[entry.id].items.push(...entry.items);
    } else {
      standalone.push({
        id: entry.id,
        title: entry.rawTitle,
        type: entry.id,
        priority: entry.priority,
        items: entry.items,
      });
    }
  }

  // Process each merged family.
  for (const [id, family] of Object.entries(families)) {
    family.items = dedupeBySlug(family.items);

    if (id === 'trending') {
      // Enrich: if the merged trending pool is imbalanced (all movies or all
      // series), replace with the pre-fetched mixed trending feed.
      const hasMovies = family.items.some(i => i.type === 'movie');
      const hasSeries = family.items.some(i => i.type === 'series');
      if ((!hasMovies || !hasSeries) && mixedTrending.length > 0) {
        family.items = mixedTrending;
      } else {
        family.items = sortByPopularity(family.items);
      }
    }

    family.items = family.items.slice(0, family.maxItems);
  }

  // Convert families to section objects.
  const merged = Object.values(families).map(f => ({
    id: f.id,
    title: f.displayTitle,
    type: f.id,
    priority: f.priority,
    items: f.items,
    _pool: f.items,   // keep full pool for refill step
  }));

  return [...merged, ...standalone].sort((a, b) => a.priority - b.priority);
}

// ─── Cross-Row Dedup + Refill ──────────────────────────────────────────────────

/**
 * Deduplicate items across rows: if a slug appears in a higher-priority row,
 * remove it from lower-priority rows. Then refill sparse rows from their
 * original pool (for merged families).
 *
 * @param {Array} sections - Array of section objects sorted by priority
 * @param {number} rowSize - Target items per row (HOMEPAGE_ROW_SIZE)
 * @returns {{ sections: Array }} Deduplicated and refilled sections
 */
function dedupAndRefill(sections, rowSize) {
  const seenSlugs = new Set();
  const result = [];

  for (const section of sections) {
    // Remove items already consumed by higher-priority rows.
    const deduped = section.items.filter(item => !seenSlugs.has(item.slug));
    deduped.forEach(item => seenSlugs.add(item.slug));

    // Refill: if the section has a _pool (merged family), try to pull more
    // items that haven't been seen in any row.
    let finalItems = deduped;
    if (section._pool && deduped.length < rowSize) {
      const extras = section._pool
        .filter(item => !seenSlugs.has(item.slug))
        .slice(0, rowSize - deduped.length);
      extras.forEach(item => seenSlugs.add(item.slug));
      finalItems = [...deduped, ...extras];
    }

    // Drop rows with too few items after dedup/refill.
    if (finalItems.length < MIN_ROW_ITEMS) continue;

    result.push({
      id: section.id,
      title: section.title,
      type: section.type,
      priority: section.priority,
      items: finalItems.slice(0, rowSize),
    });
  }

  return { sections: result };
}

// ─── Response Builder ──────────────────────────────────────────────────────────

/**
 * Build the backward-compatible response shape.
 *
 * Returns an object with:
 *   _curated: ordered array of { id, title, type, priority, items }
 *   plus each section's items keyed by its display title (legacy compat)
 */
function buildResponse(curatedSections) {
  const response = { _curated: curatedSections };
  for (const section of curatedSections) {
    response[section.title] = section.items;
  }
  return response;
}

// ─── Public API ─────────────────────────────────────────────────────────────────

/**
 * Fetch and parse featured movies from the upstream homepage.
 * Results are cached for CACHE_TTL.featured hours.
 * @returns {Promise<Array>}
 */
async function getFeatured() {
  return cache.readThrough('featured', CACHE_TTL.featured, 'featured', async () => {
    const data = await UPSTREAM_HOMEPAGE();
    if (!data || !data.above) return [];
    const section = data.above.find(
      s => s.title && s.title.toLowerCase().includes('featured')
    ) || data.above[0];
    return mapSectionItems(section);
  });
}

/**
 * Fetch and parse recently added movies from the upstream homepage.
 * Results are cached for CACHE_TTL.cinemaxxi hours.
 * @returns {Promise<Array>}
 */
async function getCinemaxxi() {
  return cache.readThrough('cinemaxxi', CACHE_TTL.cinemaxxi, 'cinemaxxi', async () => {
    const data = await UPSTREAM_HOMEPAGE();
    if (!data || !data.above) return [];
    const section = data.below
      ? [...data.above, ...data.below].find(
          s => s.title && s.title.toLowerCase().includes('recently added movies')
        )
      : data.above.find(
          s => s.title && s.title.toLowerCase().includes('recently added movies')
        ) || data.above[1];
    return mapSectionItems(section);
  });
}

/**
 * Fetch and return all homepage content as a flat array of items.
 * Combines Trending Now, Recently Added Movies, and Network Originals sections.
 * @returns {Promise<Array>}
 */
async function getHome() {
  return cache.readThrough('home.all', CACHE_TTL.home, 'home.all', async () => {
    const data = await UPSTREAM_HOMEPAGE();
    if (!data) return [];
    const allSections = [...(data.above || []), ...(data.below || [])];
    return allSections.flatMap(s => (s.data || []).map(mapApiItem)).filter(Boolean);
  });
}

/**
 * Fetch and return a curated, deduplicated, budget-capped set of homepage
 * sections. The response includes both an ordered `_curated` array (for the
 * new frontend) and legacy key-value pairs (for backward compatibility).
 *
 * Pipeline:
 *   1. Fetch upstream homepage (single call, cached)
 *   2. Classify each section against the SECTION_REGISTRY
 *   3. Fetch mixed trending fallback for enrichment
 *   4. Merge section families (trending, recent)
 *   5. Cross-row dedup with refill
 *   6. Apply section budget
 *   7. Build backward-compatible response
 *
 * @returns {Promise<Object>} { _curated: [...], "Title": [...], ... }
 */
async function getHomeSections() {
  return cache.readThrough('home.sections.v2', CACHE_TTL.home, 'home.sections', async () => {
    const data = await UPSTREAM_HOMEPAGE();
    if (!data) return buildResponse([]);

    const allRaw = [...(data.above || []), ...(data.below || [])];

    // Step 1: Classify each upstream section.
    const classified = allRaw
      .filter(s => s.title && s.title.trim().length > 0)  // skip empty titles
      .map(s => ({
        ...classifySection(s.title),
        rawTitle: s.title,
        items: mapSectionItems(s),
      }))
      .filter(s => s.items.length >= MIN_ROW_ITEMS);  // skip junk rows

    // Step 2: Prefetch mixed trending for enrichment.
    const mixedTrending = await fetchMixedTrending(40);

    // Step 3: Merge families and sort by priority.
    const merged = mergeFamilies(classified, mixedTrending);

    // Step 4: Cross-row dedup + refill.
    const { sections } = dedupAndRefill(merged, HOMEPAGE_ROW_SIZE);

    // Step 5: Budget cap.
    const budgeted = sections.slice(0, HOMEPAGE_BUDGET);

    // Step 6: Build response.
    return buildResponse(budgeted);
  });
}

/**
 * Fetch a balanced mix of movies and series from upstream browse endpoints,
 * sorted by popularityScore. Used to enrich imbalanced trending sections.
 * @param {number} limit - Number of items to return
 * @returns {Promise<Array>}
 */
async function fetchMixedTrending(limit) {
  const fetchResource = (resource, category) =>
    () => cache.readThrough(
      `trending.fallback.${resource}`,
      CACHE_TTL.trending,
      category,
      async () => {
        const json = await httpClient.getJson(
          `/api/${resource}?country=US&page=1&limit=${limit}&sort=popularityScore`);
        return json == null ? null : (Array.isArray(json.data) ? json.data : []);
      }
    );

  const [movieRes, seriesRes] = await Promise.allSettled([
    fetchResource('movies', 'trending.movieFallback')(),
    fetchResource('series', 'trending.seriesFallback')(),
  ]);

  const movieOk = movieRes.status === 'fulfilled' && movieRes.value != null;
  const seriesOk = seriesRes.status === 'fulfilled' && seriesRes.value != null;

  if (!movieOk && !seriesOk) return [];

  const movies = movieOk ? movieRes.value : [];
  const series = (seriesOk ? seriesRes.value : []).map(i => ensureContentType(i));

  return [...movies, ...series]
    .sort((a, b) => {
      const sa = Number(a?.popularityScore);
      const sb = Number(b?.popularityScore);
      return (Number.isFinite(sb) ? sb : 0) - (Number.isFinite(sa) ? sa : 0);
    })
    .slice(0, limit)
    .map(mapApiItem)
    .filter(Boolean);
}

module.exports = { getFeatured, getCinemaxxi, getHome, getHomeSections };
