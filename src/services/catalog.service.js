'use strict';

const httpClient = require('../lib/httpClient');
const cache      = require('../lib/cacheService');
const metrics    = require('../lib/metrics');
const { CACHE_TTL } = require('../config/env');
const { mapApiItem, ensureContentType } = require('../lib/scraper');

function buildKey(parts) {
  return parts.filter(Boolean).join('.');
}

async function fetchWithCache(key, ttl, path, parser) {
  if (cache.isHit(key, ttl)) return cache.get(key);

  const { data } = await httpClient.get(path);
  const items = parser(data);
  cache.set(key, items);
  return items;
}

async function getCategoryIndex(category) {
  const key = buildKey([category, 'index']);
  if (cache.isHit(key, CACHE_TTL.page)) { metrics.recordHit(`${category}.index`); return cache.get(key); }

  let items = [];

  if (category === 'genre') {
    const data = await metrics.fetch('genre.index', () => httpClient.getJson('/api/genres'));
    items = (data?.data || []).map(g => ({
      title: g.name,
      originalTitle: g.name,
      category: 'genre',
      slug: g.slug,
      value: g.slug,
      genre: g.slug,
      link: { endpoint: `genre/${g.slug}`, url: `${require('../config/env').BASE_URL}/genre/${g.slug}` }
    }));
  } else if (category === 'country') {
    const data = await metrics.fetch('country.index', () => httpClient.getJson('/api/browse/countries'));
    items = (data?.data || []).map(c => ({
      title: c.name,
      originalTitle: c.name,
      category: 'country',
      slug: c.code,
      value: c.code,
      code: c.code,
      link: { endpoint: `country/${c.code}`, url: `${require('../config/env').BASE_URL}/country/${c.code}` }
    }));
  } else if (category === 'year') {
    const data = await metrics.fetch('year.index', () => httpClient.getJson('/api/browse/years'));
    items = (data?.data || []).map(y => ({
      title: y,
      originalTitle: y,
      category: 'year',
      slug: y,
      value: parseInt(y, 10),
      year: parseInt(y, 10),
      link: { endpoint: `year/${y}`, url: `${require('../config/env').BASE_URL}/year/${y}` }
    }));
  } else if (category === 'network') {
    const HARDCODED_NETWORKS = [
      { slug: 'netflix', title: 'Netflix' },
      { slug: 'hbo', title: 'HBO' },
      { slug: 'prime-video', title: 'Prime Video' },
      { slug: 'disney-plus', title: 'Disney+' },
      { slug: 'apple-tv-plus', title: 'Apple TV+' }
    ];
    items = HARDCODED_NETWORKS.map(n => ({
      title: n.title,
      originalTitle: n.title,
      category: 'network',
      slug: n.slug,
      value: n.slug,
      network: n.slug,
      link: { endpoint: `network/${n.slug}`, url: `${require('../config/env').BASE_URL}/network/${n.slug}` }
    }));
    // No upstream call for network — don't record miss.
    cache.set(key, items);
    return items;
  }

  cache.set(key, items);
  return items;
}

async function getCategoryBrowse(category, value, type, page = 1, limit) {
  const resLimit = Number(limit) || 36;
  const key = buildKey([category, value, type || 'all', `page-${page}`, `limit-${resLimit}`]);
  if (cache.isHit(key, CACHE_TTL.page)) { metrics.recordHit(`${category}.browse`); return cache.get(key); }

  const isSeries = type === 'series';
  const apiPath = isSeries ? '/api/series' : '/api/movies';
  
  const qs = `${category}=${value}&page=${page}&limit=${resLimit}&sort=createdAt`;
  
  const data = await metrics.fetch(`${category}.browse`, () => httpClient.getJson(`${apiPath}?${qs}`));
  const items = (data?.data || []).map(i => ensureContentType(i, isSeries ? 'tv_series' : 'movie')).map(mapApiItem).filter(Boolean);

  cache.set(key, items);
  return items;
}

module.exports = {
  getCategoryIndex,
  getCategoryBrowse,
};
