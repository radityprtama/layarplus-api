'use strict';

const httpClient = require('../lib/httpClient');
const cache      = require('../lib/cacheService');
const { CACHE_TTL } = require('../config/env');
const { mapApiItem, ensureContentType } = require('../lib/scraper');

function buildKey(parts) {
  return parts.filter(Boolean).join('.');
}

const HARDCODED_NETWORKS = [
  { slug: 'netflix', title: 'Netflix' },
  { slug: 'hbo', title: 'HBO' },
  { slug: 'prime-video', title: 'Prime Video' },
  { slug: 'disney-plus', title: 'Disney+' },
  { slug: 'apple-tv-plus', title: 'Apple TV+' }
];

async function getCategoryIndex(category) {
  const key = buildKey([category, 'index']);

  // Network has no upstream — bypass readThrough's metric wrapper (category: null)
  // and cache the hardcoded list directly.
  if (category === 'network') {
    if (cache.isHit(key, CACHE_TTL.page)) return cache.get(key);
    const items = HARDCODED_NETWORKS.map(n => ({
      title: n.title,
      originalTitle: n.title,
      category: 'network',
      slug: n.slug,
      value: n.slug,
      network: n.slug,
      link: { endpoint: `network/${n.slug}`, url: `${require('../config/env').BASE_URL}/network/${n.slug}` }
    }));
    cache.set(key, items);
    return items;
  }

  return cache.readThrough(key, CACHE_TTL.page, `${category}.index`, async () => {
    let items;
    if (category === 'genre') {
      const data = await httpClient.getJson('/api/genres');
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
      const data = await httpClient.getJson('/api/browse/countries');
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
      const data = await httpClient.getJson('/api/browse/years');
      items = (data?.data || []).map(y => ({
        title: y,
        originalTitle: y,
        category: 'year',
        slug: y,
        value: parseInt(y, 10),
        year: parseInt(y, 10),
        link: { endpoint: `year/${y}`, url: `${require('../config/env').BASE_URL}/year/${y}` }
      }));
    } else {
      items = [];
    }
    return items;
  });
}

async function getCategoryBrowse(category, value, type, page = 1, limit, sort) {
  if (category === 'network') {
    const networkIndex = require('./networkIndex.service');
    const nLimit = Number(limit) || 36;
    const nSort = sort || 'createdAt';
    const isSeries = type === 'series';
    const apiPath = isSeries ? '/api/series' : '/api/movies';
    const qs = `network=${value}&page=${page}&limit=${nLimit}&sort=${nSort}`;
    try {
      const data = await httpClient.getJson(`${apiPath}?${qs}`);
      if (data?.data?.length) {
        const items = (data.data || [])
          .map(i => ensureContentType(i, isSeries ? 'tv_series' : 'movie'))
          .map(mapApiItem)
          .filter(Boolean);
        const upstreamPages = data?.totalPages || data?.pagination?.totalPages || 1;
        return {
          items,
          pagination: {
            currentPage: Number(page),
            totalPages: Number(upstreamPages),
            hasNext: Number(page) < Number(upstreamPages),
          },
        };
      }
    } catch {}
    return networkIndex.getNetworkItems(value, Number(page), nLimit);
  }

  const resLimit = Number(limit) || 36;
  const resSort = sort || 'createdAt';
  const key = buildKey([category, value, type || 'all', `page-${page}`, `limit-${resLimit}`, `sort-${resSort}`]);
  const isSeries = type === 'series';
  const apiPath = isSeries ? '/api/series' : '/api/movies';
  const qs = `${category}=${value}&page=${page}&limit=${resLimit}&sort=${resSort}`;

  return cache.readThrough(key, CACHE_TTL.page, `${category}.browse`, async () => {
    const data = await httpClient.getJson(`${apiPath}?${qs}`);
    const items = (data?.data || [])
      .map(i => ensureContentType(i, isSeries ? 'tv_series' : 'movie'))
      .map(mapApiItem)
      .filter(Boolean);
    const upstreamPages = data?.totalPages || data?.pagination?.totalPages || 1;
    return {
      items,
      pagination: {
        currentPage: Number(page),
        totalPages: Number(upstreamPages),
        hasNext: Number(page) < Number(upstreamPages),
      },
    };
  });
}

module.exports = {
  getCategoryIndex,
  getCategoryBrowse,
};
