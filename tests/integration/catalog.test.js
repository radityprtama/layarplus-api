'use strict';

jest.mock('../../src/lib/httpClient', () => ({
  getJson: jest.fn(),
}));
jest.mock('../../src/lib/cacheService',
  () => require('../fixtures/cacheMock')());

const request    = require('supertest');
const createApp  = require('../../src/app');
const httpClient = require('../../src/lib/httpClient');
const cache      = require('../../src/lib/cacheService');

const MOCK_GENRES = { data: [{ name: 'Action', slug: 'action' }] };
const MOCK_COUNTRIES = { data: [{ name: 'China', code: 'CN' }] };
const MOCK_YEARS = { data: ['2026', '2025'] };
const MOCK_BROWSE = { data: [{ title: 'Movie 1', slug: 'm1', contentType: 'movie' }] };
const MOCK_SEARCH = { results: [{ title: 'Batman', slug: 'batman', contentType: 'movie' }] };
const MOCK_LEADERBOARD = { topMovies: [{ title: 'Top Movie', slug: 't1', contentType: 'movie' }] };
const MOCK_HOMEPAGE = { above: [{ title: 'Trending', data: [{ title: 'Trend', slug: 'tr', contentType: 'movie' }] }] };

describe('Catalog Routes', () => {
  let app;

  beforeAll(() => { app = createApp(); });

  beforeEach(() => {
    jest.clearAllMocks();
    cache.isHit.mockReturnValue(false);
    cache.get.mockReturnValue(null);
  });

  describe('GET /api/genre', () => {
    it('returns the genre index list with envelope', async () => {
      httpClient.getJson.mockResolvedValue(MOCK_GENRES);

      const res = await request(app).get('/api/genre');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data[0].slug).toBe('action');
      expect(httpClient.getJson).toHaveBeenCalledWith('/api/genres');
    });
  });

  describe('GET /api/country', () => {
    it('returns the country index list with envelope', async () => {
      httpClient.getJson.mockResolvedValue(MOCK_COUNTRIES);

      const res = await request(app).get('/api/country');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data[0].slug).toBe('CN');
      expect(httpClient.getJson).toHaveBeenCalledWith('/api/browse/countries');
    });
  });

  describe('GET /api/country/:country', () => {
    it('returns filtered media for a country page', async () => {
      httpClient.getJson.mockResolvedValue(MOCK_BROWSE);

      const res = await request(app).get('/api/country/CN?type=movie');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].type).toBe('movie');
      expect(httpClient.getJson).toHaveBeenCalledWith('/api/movies?country=CN&page=1&limit=36&sort=createdAt');
    });

    it('returns 200 for a paged request on page 2', async () => {
      httpClient.getJson.mockResolvedValue(MOCK_BROWSE);
      const res = await request(app).get('/api/country/CN/2');
      expect(res.status).toBe(200);
      expect(httpClient.getJson).toHaveBeenCalledWith('/api/movies?country=CN&page=2&limit=36&sort=createdAt');
    });
  });

  describe('GET /api/year', () => {
    it('returns the year index list with envelope', async () => {
      httpClient.getJson.mockResolvedValue(MOCK_YEARS);

      const res = await request(app).get('/api/year');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data[0].slug).toBe('2026');
      expect(httpClient.getJson).toHaveBeenCalledWith('/api/browse/years');
    });
  });

  describe('GET /api/year/:year', () => {
    it('returns media for a year page', async () => {
      httpClient.getJson.mockResolvedValue(MOCK_BROWSE);

      const res = await request(app).get('/api/year/2026?type=movie');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].type).toBe('movie');
      expect(httpClient.getJson).toHaveBeenCalledWith('/api/movies?year=2026&page=1&limit=36&sort=createdAt');
    });
  });

  describe('GET /api/network', () => {
    it('returns the network index list with envelope (hardcoded)', async () => {
      const res = await request(app).get('/api/network');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(httpClient.getJson).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/network/:network', () => {
    const SUPPORTED = ['netflix', 'hbo', 'prime-video', 'disney-plus', 'apple-tv-plus'];

    // Ensure ≥20 items so network warmup doesn't fire during tests.
    function padForWarmup(arr) {
      const items = [...arr];
      while (items.length < 20) {
        items.push({ slug: `_pad${items.length}`, title: '', type: 'series' });
      }
      return items;
    }

    it('never calls upstream and never returns the global catalog for a supported network', async () => {
      // Hypothetically upstream WOULD return a global catalog if asked.
      // The hotfix must refuse to even ask, so a network page cannot be
      // polluted with generic content.
      httpClient.getJson.mockResolvedValue(MOCK_BROWSE);

      // Seed an empty-but-hot index so rebuild doesn't fire.
      const emptyIndex = Object.fromEntries(SUPPORTED.map(s => [s, []]));
      cache.isHit.mockImplementation((key) => key === 'network.index.v1');
      cache.get.mockReturnValue(emptyIndex);

      const res = await request(app).get('/api/network/hbo?type=series');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      // No generic catalog leaks through (empty index in mock -> empty data).
      expect(res.body.data).toHaveLength(0);
    });

    it('returns DISTINCT, slug-scoped items for each supported network and never the global catalog', async () => {
      // Seed the network index cache with deliberately DIFFERENT items per slug
      // so we can assert each network returns only its own bucket and that a
      // global catalog is never substituted.
      const index = {
        netflix:       padForWarmup([{ slug: 'n1', title: 'NLX Original', type: 'series' }]),
        hbo:           padForWarmup([{ slug: 'h1', title: 'HBO Original', type: 'series' }]),
        'prime-video': padForWarmup([{ slug: 'p1', title: 'Prime Original', type: 'series' }]),
      };
      cache.isHit.mockImplementation((key) => key === 'network.index.v1');
      cache.get.mockReturnValue(index);
      // If upstream were called it would return the same MOCK_BROWSE for every
      // network — assert it is not called at all.
      httpClient.getJson.mockResolvedValue(MOCK_BROWSE);

      const results = {};
      for (const slug of ['netflix', 'hbo', 'prime-video']) {
        const res = await request(app).get(`/api/network/${slug}?type=series`);
        expect(res.status).toBe(200);
        results[slug] = res.body.data;
      }

      expect(httpClient.getJson).not.toHaveBeenCalled();
      // Each slug returns ONLY its own bucket (padded items filtered out by
      // response body assertions below — only named slugs matter).
      expect(results.netflix.map(i => i.slug)).toContain('n1');
      expect(results.hbo.map(i => i.slug)).toContain('h1');
      expect(results['prime-video'].map(i => i.slug)).toContain('p1');
      // Regression: the three sets must not be identical (the original bug).
      const slugsAcross = Object.values(results).flat().map((i) => i.slug).filter(s => !s.startsWith('_pad'));
      expect(new Set(slugsAcross).size).toBe(slugsAcross.length);
    });

    it('returns an honest empty result (not the global catalog) for an unknown slug', async () => {
      httpClient.getJson.mockResolvedValue(MOCK_BROWSE); // tempting global catalog

      const res = await request(app).get('/api/network/some-fake-network?type=series');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data).toHaveLength(0);
      expect(httpClient.getJson).not.toHaveBeenCalled();
      expect(res.body.pagination).toEqual({ currentPage: 1, totalPages: 1, hasNext: false });
      expect(res.body.filters?.network).toBe('some-fake-network');
    });

    it('returns an honest empty result for type=movie (movies not yet indexed)', async () => {
      // Even for a supported network, movies have no backing index today.
      // We must NOT serve the series index under a movie request, and must
      // NOT call upstream for movies either.
      // Warmup may fire during this call — only response assertions matter.
      const netflixItems = padForWarmup([{ slug: 'n1', title: 'NLX Series', type: 'series' }]);
      cache.isHit.mockImplementation((key) => key === 'network.index.v1');
      cache.get.mockReturnValue({ netflix: netflixItems });
      httpClient.getJson.mockResolvedValue(MOCK_BROWSE);

      const res = await request(app).get('/api/network/netflix?type=movie');

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]); // series index NOT leaked into movie request
    });

    it('emits a structured log for an unsupported slug and never calls upstream', async () => {
      // logger is silenced in test (level silent) but the call must still occur.
      const logger = require('../../src/lib/logger');
      const infoSpy = jest.spyOn(logger, 'info');

      await request(app).get('/api/network/not-a-real-network');

      expect(httpClient.getJson).not.toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({ slug: 'not-a-real-network' }),
        'network.browse.unsupported: empty result, no upstream call'
      );
      infoSpy.mockRestore();
    });

    it('serves the series index for type=all (no type query)', async () => {
      const hboItems = padForWarmup([{ slug: 'h1', title: 'HBO Series A', type: 'series' }]);
      cache.isHit.mockImplementation((key) => key === 'network.index.v1');
      cache.get.mockReturnValue({ hbo: hboItems });

      const res = await request(app).get('/api/network/hbo?limit=1');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].slug).toBe('h1');
    });

    it('supports every slug in the SUPPORTED_NETWORKS registry', async () => {
      // Warm the cache so rebuild/warmup don't fire for any slug.
      const fullIndex = Object.fromEntries(SUPPORTED.map(s => [s, padForWarmup([])]));
      cache.isHit.mockImplementation((key) => key === 'network.index.v1');
      cache.get.mockReturnValue(fullIndex);

      for (const slug of SUPPORTED) {
        const res = await request(app).get(`/api/network/${slug}?type=series`);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.data)).toBe(true);
      }
      expect(httpClient.getJson).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/search', () => {
    it('returns search results with query metadata', async () => {
      httpClient.getJson.mockResolvedValue(MOCK_SEARCH);

      const res = await request(app).get('/api/search?q=batman');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.meta.query).toBe('batman');
      expect(httpClient.getJson).toHaveBeenCalledWith('/api/search?q=batman');
    });

    it('returns 400 when query is too short', async () => {
      const res = await request(app).get('/api/search?q=a');
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('returns 400 when query is missing', async () => {
      const res = await request(app).get('/api/search');
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/leaderboard', () => {
    it('returns leaderboard with metadata', async () => {
      httpClient.getJson.mockResolvedValue(MOCK_LEADERBOARD);

      const res = await request(app).get('/api/leaderboard');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.topMovies).toBeDefined();
      expect(httpClient.getJson).toHaveBeenCalledWith('/api/leaderboard');
    });
  });

  describe('GET /api/home', () => {
    it('returns homepage items', async () => {
      httpClient.getJson.mockResolvedValue(MOCK_HOMEPAGE);

      const res = await request(app).get('/api/home');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(httpClient.getJson).toHaveBeenCalledWith('/api/homepage');
    });
  });
});
