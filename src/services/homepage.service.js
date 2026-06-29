'use strict';

const httpClient = require('../lib/httpClient');
const cache      = require('../lib/cacheService');
const { CACHE_TTL } = require('../config/env');
const { mapApiItem, ensureContentType } = require('../lib/scraper');

const UPSTREAM_HOMEPAGE = () => httpClient.getJson('/api/homepage');

function pickSection(above, predicate, fallbackIndex) {
  return above.find(predicate) || above[fallbackIndex];
}

function mapSectionItems(section) {
  return (section?.data || []).map(mapApiItem).filter(Boolean);
}

/**
 * Fetch and parse featured movies from the upstream homepage.
 * Results are cached for CACHE_TTL.featured hours.
 * @returns {Promise<Array>}
 */
async function getFeatured() {
  return cache.readThrough('featured', CACHE_TTL.featured, 'featured', async () => {
    const data = await UPSTREAM_HOMEPAGE();
    if (!data || !data.above) return [];
    const section = pickSection(data.above,
      s => s.title && s.title.toLowerCase().includes('featured'), 0);
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
    const section = pickSection(data.above,
      s => s.title && s.title.toLowerCase().includes('recently added movies'), 1);
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
 * Fetch and return homepage content organised by section name.
 * Returns an object keyed by section title (e.g. "Trending Now", "Recently Added Movies").
 * @returns {Promise<Object>}
 */
async function getHomeSections() {
  const sections = await cache.readThrough('home.sections', CACHE_TTL.home, 'home.sections', async () => {
    const data = await UPSTREAM_HOMEPAGE();
    if (!data) return {};
    const sectionsOut = {};
    const allSections = [...(data.above || []), ...(data.below || [])];
    for (const s of allSections) {
      if (!s.title) continue;
      const items = mapSectionItems(s);
      if (items.length) sectionsOut[s.title] = items;
    }
    return sectionsOut;
  }) || {};

  // For trending sections that are imbalanced (e.g. all series, no movies),
  // replace with a mixed feed from upstream browse endpoints so that
  // "Trending Now" contains both movies and TV series.
  const enriched = { ...sections };
  await Promise.all(
    Object.keys(enriched)
      .filter(title => title.toLowerCase().includes('trending'))
      .map(async (title) => {
        const items = enriched[title];
        const hasMovies = items.some(i => i.type === 'movie');
        const hasSeries = items.some(i => i.type === 'series');
        if (hasMovies && hasSeries) return;
        const mixed = await fetchMixedTrending(items.length);
        if (mixed.length > 0) enriched[title] = mixed;
      })
  );

  return enriched;
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
