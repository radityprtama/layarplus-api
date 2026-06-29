'use strict';

const httpClient = require('../lib/httpClient');
const cache      = require('../lib/cacheService');
const metrics    = require('../lib/metrics');
const { CACHE_TTL } = require('../config/env');
const { mapApiItem, ensureContentType } = require('../lib/scraper');

/**
 * Fetch and parse featured movies from the upstream homepage.
 * Results are cached for CACHE_TTL.featured hours.
 * @returns {Promise<Array>}
 */
async function getFeatured() {
  const key = 'featured';
  if (cache.isHit(key, CACHE_TTL.featured)) { metrics.recordHit('featured'); return cache.get(key); }

  const data = await metrics.fetch('featured', () => httpClient.getJson('/api/homepage'));
  if (!data || !data.above) return [];
  
  const section = data.above.find(s => s.title && s.title.toLowerCase().includes('featured')) || data.above[0];
  const items = (section?.data || []).map(mapApiItem).filter(Boolean);
  
  cache.set(key, items);
  return items;
}

/**
 * Fetch and parse recently added movies from the upstream homepage.
 * Results are cached for CACHE_TTL.cinemaxxi hours.
 * @returns {Promise<Array>}
 */
async function getCinemaxxi() {
  const key = 'cinemaxxi';
  if (cache.isHit(key, CACHE_TTL.cinemaxxi)) { metrics.recordHit('cinemaxxi'); return cache.get(key); }

  const data = await metrics.fetch('cinemaxxi', () => httpClient.getJson('/api/homepage'));
  if (!data || !data.above) return [];

  const section = data.above.find(s => s.title && s.title.toLowerCase().includes('recently added movies')) || data.above[1];
  const items = (section?.data || []).map(mapApiItem).filter(Boolean);
  
  cache.set(key, items);
  return items;
}

/**
 * Fetch and return all homepage content as a flat array of items.
 * Combines Trending Now, Recently Added Movies, and Network Originals sections.
 * @returns {Promise<Array>}
 */
async function getHome() {
  const key = 'home.all';
  if (cache.isHit(key, CACHE_TTL.home)) { metrics.recordHit('home.all'); return cache.get(key); }

  const data = await metrics.fetch('home.all', () => httpClient.getJson('/api/homepage'));
  if (!data) return [];

  const allSections = [...(data.above || []), ...(data.below || [])];
  const items = allSections.flatMap(s => (s.data || []).map(mapApiItem)).filter(Boolean);
  
  cache.set(key, items);
  return items;
}

/**
 * Fetch and return homepage content organised by section name.
 * Returns an object keyed by section title (e.g. "Trending Now", "Recently Added Movies").
 * @returns {Promise<Object>}
 */
async function getHomeSections() {
  const key = 'home.sections';
  if (cache.isHit(key, CACHE_TTL.home)) { metrics.recordHit('home.sections'); return cache.get(key); }

  const data = await metrics.fetch('home.sections', () => httpClient.getJson('/api/homepage'));
  if (!data) return {};

  const sections = {};
  const allSections = [...(data.above || []), ...(data.below || [])];
  
  for (const s of allSections) {
    if (!s.title) continue;
    const items = (s.data || []).map(mapApiItem).filter(Boolean);
    if (items.length) {
      sections[s.title] = items;
    }
  }

  // For trending sections that are imbalanced (e.g. all series, no movies),
  // replace with a mixed feed from upstream browse endpoints so that
  // "Trending Now" contains both movies and TV series.
  for (const title of Object.keys(sections)) {
    if (title.toLowerCase().includes('trending')) {
      const items = sections[title];
      const hasMovies = items.some(i => i.type === 'movie');
      const hasSeries = items.some(i => i.type === 'series');
      if (!hasMovies || !hasSeries) {
        const mixed = await fetchMixedTrending(items.length);
        if (mixed.length > 0) {
          sections[title] = mixed;
        }
      }
    }
  }

  cache.set(key, sections);
  return sections;
}

/**
 * Fetch a balanced mix of movies and series from upstream browse endpoints,
 * sorted by popularityScore. Used to enrich imbalanced trending sections.
 * @param {number} limit - Number of items to return
 * @returns {Promise<Array>}
 */
async function fetchMixedTrending(limit) {
  const fetchResource = (resource, category) => async () => {
    const json = await httpClient.getJson(`/api/${resource}?country=US&page=1&limit=${limit}&sort=popularityScore`);
    if (json == null) return null;
    return Array.isArray(json.data) ? json.data : [];
  };

  const [movieRes, seriesRes] = await Promise.allSettled([
    metrics.fetch('trending.movieFallback', fetchResource('movies', 'trending.movieFallback')),
    metrics.fetch('trending.seriesFallback', fetchResource('series', 'trending.seriesFallback')),
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