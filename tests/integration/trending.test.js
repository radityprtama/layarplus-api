'use strict';

jest.mock('../../src/lib/httpClient', () => ({
  getJson: jest.fn(),
}));
jest.mock('../../src/lib/cacheService', () => ({
  isHit: jest.fn(),
  get:   jest.fn(),
  set:   jest.fn(),
}));

const request    = require('supertest');
const createApp  = require('../../src/app');
const httpClient = require('../../src/lib/httpClient');
const cache      = require('../../src/lib/cacheService');

// ── Upstream fixtures ────────────────────────────────────────────────────────
// Movies carry `contentType: 'movie'`. Series from /api/series omit contentType
// entirely (the real upstream does) — the service must still classify them as
// series via the `numberOfSeasons`/tagging path.

const MOCK_MOVIES = {
  data: [
    { title: 'Movie High', slug: 'movie-high-2026', contentType: 'movie', popularityScore: 900, releaseDate: '2026-01-01' },
    { title: 'Movie Low',  slug: 'movie-low-2026',  contentType: 'movie', popularityScore: 100, releaseDate: '2026-02-01' },
  ],
};

const MOCK_SERIES = {
  data: [
    { title: 'Series Top', slug: 'series-top-2026', numberOfSeasons: 2, popularityScore: 950, firstAirDate: '2026-03-01' },
    { title: 'Series Mid', slug: 'series-mid-2026', numberOfSeasons: 1, popularityScore: 500, firstAirDate: '2026-04-01' },
  ],
};

/**
 * Route httpClient.getJson by URL so the two parallel resource fetches can be
 * controlled independently. `overrides` maps 'movies'|'series' to either a
 * resolved value or the sentinel Error to reject with.
 */
function mockUpstream({ movies = MOCK_MOVIES, series = MOCK_SERIES } = {}) {
  httpClient.getJson.mockImplementation((url) => {
    const target = url.startsWith('/api/movies') ? movies : series;
    if (target instanceof Error) return Promise.reject(target);
    return Promise.resolve(target);
  });
}

describe('GET /api/trending/near-you', () => {
  let app;

  beforeAll(() => { app = createApp(); });

  beforeEach(() => {
    jest.clearAllMocks();
    cache.isHit.mockReturnValue(false);
    cache.get.mockReturnValue(null);
  });

  // ── Mixed movie + series feed ──────────────────────────────────────────────

  it('returns a MIXED feed of movies AND series for the detected country', async () => {
    mockUpstream();

    const res = await request(app)
      .get('/api/trending/near-you')
      .set('CF-IPCountry', 'ID');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(4); // 2 movies + 2 series merged
    expect(res.body.meta).toEqual({ country: 'ID', detectedBy: 'cf-header' });

    // Both upstream resources are consumed, country-scoped.
    expect(httpClient.getJson).toHaveBeenCalledWith(
      '/api/movies?country=ID&page=1&limit=36&sort=popularityScore'
    );
    expect(httpClient.getJson).toHaveBeenCalledWith(
      '/api/series?country=ID&page=1&limit=36&sort=popularityScore'
    );

    // The feed contains BOTH types, correctly classified.
    const types = res.body.data.map(i => i.type);
    expect(types).toContain('movie');
    expect(types).toContain('series');
    // Series classified from /api/series despite missing contentType upstream.
    const seriesItem = res.body.data.find(i => i.slug === 'series-top-2026');
    expect(seriesItem.type).toBe('series');
    expect(seriesItem.link.endpoint).toBe('series/series-top-2026');
  });

  // ── Sorting by popularityScore (desc), interleaving the two resources ──────

  it('sorts the merged feed by popularityScore descending', async () => {
    mockUpstream();

    const res = await request(app).get('/api/trending/near-you');

    expect(res.status).toBe(200);
    // Expected order by score: Series Top (950) > Movie High (900) > Series Mid (500) > Movie Low (100)
    expect(res.body.data.map(i => i.slug)).toEqual([
      'series-top-2026',
      'movie-high-2026',
      'series-mid-2026',
      'movie-low-2026',
    ]);
  });

  // ── Geo detection unchanged (fallback) ─────────────────────────────────────

  it('falls back to US when no geo headers are present', async () => {
    mockUpstream();

    const res = await request(app).get('/api/trending/near-you');

    expect(res.status).toBe(200);
    expect(res.body.meta.country).toBe('US');
    expect(res.body.meta.detectedBy).toBe('fallback');
    expect(httpClient.getJson).toHaveBeenCalledWith(
      '/api/movies?country=US&page=1&limit=36&sort=popularityScore'
    );
    expect(httpClient.getJson).toHaveBeenCalledWith(
      '/api/series?country=US&page=1&limit=36&sort=popularityScore'
    );
  });

  // ── Partial upstream failure ───────────────────────────────────────────────

  it('returns series-only results when the movies upstream fails', async () => {
    mockUpstream({ movies: new Error('movies upstream down') });

    const res = await request(app).get('/api/trending/near-you');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.every(i => i.type === 'series')).toBe(true);
  });

  it('returns movies-only results when the series upstream fails', async () => {
    mockUpstream({ series: new Error('series upstream down') });

    const res = await request(app).get('/api/trending/near-you');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.every(i => i.type === 'movie')).toBe(true);
  });

  it('tolerates a non-OK (null) response from one upstream', async () => {
    // httpClient.getJson resolves null on a non-OK upstream response.
    mockUpstream({ series: null });

    const res = await request(app).get('/api/trending/near-you');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.every(i => i.type === 'movie')).toBe(true);
  });

  // ── Both upstreams fail → error ────────────────────────────────────────────

  it('returns an error only when BOTH upstream resources fail', async () => {
    mockUpstream({
      movies: new Error('movies down'),
      series: new Error('series down'),
    });

    const res = await request(app).get('/api/trending/near-you');

    expect(res.status).toBe(502);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toBeDefined();
  });

  // ── Empty responses ────────────────────────────────────────────────────────

  it('returns an empty array when both upstreams return no data', async () => {
    mockUpstream({ movies: { data: [] }, series: { data: [] } });

    const res = await request(app).get('/api/trending/near-you');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  // ── Backward compatibility ─────────────────────────────────────────────────

  it('preserves the response envelope and serves cached data when fresh', async () => {
    const cached = [
      { title: 'Cached', slug: 'cached-item', type: 'movie', link: { endpoint: 'movie/cached-item', url: 'http://x', thumbnail: null } },
    ];
    cache.isHit.mockReturnValue(true);
    cache.get.mockReturnValue(cached);

    const res = await request(app)
      .get('/api/trending/near-you')
      .set('CF-IPCountry', 'ID');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual(cached);
    expect(res.body.meta).toEqual({ country: 'ID', detectedBy: 'cf-header' });
    expect(httpClient.getJson).not.toHaveBeenCalled();
  });

  it('keeps mapped item fields (title, slug, type, poster, link) intact', async () => {
    mockUpstream({
      movies: { data: [{ title: 'Solo Movie', slug: 'solo-movie-2026', contentType: 'movie', popularityScore: 10, releaseDate: '2026-05-01', posterPath: '/p.jpg', voteAverage: '7.5' }] },
      series: { data: [] },
    });

    const res = await request(app).get('/api/trending/near-you');

    expect(res.status).toBe(200);
    const item = res.body.data[0];
    expect(item).toMatchObject({
      title: 'Solo Movie',
      slug: 'solo-movie-2026',
      year: 2026,
      type: 'movie',
      rating: 7.5,
      poster: 'https://image.tmdb.org/t/p/w300/p.jpg',
    });
    expect(item.link).toMatchObject({ endpoint: 'movie/solo-movie-2026' });
  });
});
