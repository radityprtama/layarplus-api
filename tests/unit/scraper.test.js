'use strict';

const { mapApiItem, mapApiDetail } = require('../../src/lib/scraper');

describe('scraper.js', () => {

  describe('mapApiItem', () => {
    it('returns null if item is falsy', () => {
      expect(mapApiItem(null)).toBeNull();
    });

    it('maps a movie item correctly', () => {
      const apiItem = {
        title: 'Inception',
        slug: 'inception',
        contentType: 'movie',
        releaseDate: '2010-07-16',
        voteAverage: 8.8,
        posterPath: '/poster.jpg',
        quality: 'HD'
      };

      const mapped = mapApiItem(apiItem);
      expect(mapped).toMatchObject({
        title: 'Inception',
        originalTitle: 'Inception',
        year: 2010,
        type: 'movie',
        quality: 'HD',
        rating: 8.8,
        season: null,
        poster: 'https://image.tmdb.org/t/p/w300/poster.jpg',
        backdrop: null,
        logo: null,
        slug: 'inception',
        link: {
          endpoint: 'movie/inception',
          url: 'https://z2.idlixku.com/movie/inception',
          thumbnail: 'https://image.tmdb.org/t/p/w300/poster.jpg'
        }
      });
    });

    it('maps a series item correctly', () => {
      const apiItem = {
        title: 'Breaking Bad',
        slug: 'breaking-bad',
        contentType: 'series',
        releaseDate: '2008-01-20'
      };

      const mapped = mapApiItem(apiItem);
      expect(mapped).toMatchObject({
        title: 'Breaking Bad',
        year: 2008,
        type: 'series',
        backdrop: null,
        logo: null,
        link: expect.objectContaining({ endpoint: 'series/breaking-bad' })
      });
    });

    it('maps logoPath to a fully qualified TMDB logo URL', () => {
      const apiItem = {
        title: 'Test',
        slug: 'test',
        contentType: 'movie',
        releaseDate: '2024-01-01',
        posterPath: '/poster.jpg',
        logoPath: '/logo.png'
      };

      const mapped = mapApiItem(apiItem);
      expect(mapped.logo).toBe('https://image.tmdb.org/t/p/w500/logo.png');
    });

    it('sets logo to null when logoPath is missing', () => {
      const apiItem = {
        title: 'Test',
        slug: 'test',
        contentType: 'movie',
        releaseDate: '2024-01-01'
      };

      const mapped = mapApiItem(apiItem);
      expect(mapped.logo).toBeNull();
    });

    describe('episode mapping', () => {
      it('maps an episode with stillPath correctly', () => {
        const apiItem = {
          name: 'Deep In Enemy Territory',
          episodeNumber: 9,
          stillPath: '/still.jpg',
          voteAverage: '7.5',
          season: { seasonNumber: 1 },
          series: {
            title: 'Reborn Rookie',
            slug: 'reborn-rookie-2026',
            posterPath: '/series-poster.jpg',
            firstAirDate: '2026-05-30'
          },
          contentType: 'episode'
        };

        const mapped = mapApiItem(apiItem);
        expect(mapped).toMatchObject({
          title: 'Deep In Enemy Territory',
          originalTitle: 'Reborn Rookie',
          year: 2026,
          type: 'series',
          quality: null,
          rating: 7.5,
          season: 'S1:E9',
          poster: 'https://image.tmdb.org/t/p/w300/still.jpg',
          backdrop: null,
          logo: null,
          slug: 'reborn-rookie-2026',
          link: {
            endpoint: 'series/reborn-rookie-2026',
            url: 'https://z2.idlixku.com/series/reborn-rookie-2026',
            thumbnail: 'https://image.tmdb.org/t/p/w300/still.jpg'
          }
        });
      });

      it('falls back to series.posterPath when stillPath is missing', () => {
        const apiItem = {
          name: 'Episode 2',
          episodeNumber: 2,
          voteAverage: '6.5',
          season: { seasonNumber: 1 },
          series: {
            title: 'Agent Kim Reactivated',
            slug: 'agent-kim-reactivated-2026',
            posterPath: '/series-poster.jpg',
            firstAirDate: '2026-06-26'
          },
          contentType: 'episode'
        };

        const mapped = mapApiItem(apiItem);
        expect(mapped.poster).toBe('https://image.tmdb.org/t/p/w300/series-poster.jpg');
        expect(mapped.link.thumbnail).toBe('https://image.tmdb.org/t/p/w300/series-poster.jpg');
      });

      it('returns null poster when both stillPath and series.posterPath are missing', () => {
        const apiItem = {
          name: 'No Art Episode',
          episodeNumber: 5,
          season: { seasonNumber: 2 },
          series: { title: 'No Art Series', slug: 'no-art-series', firstAirDate: '2025-01-01' },
          contentType: 'episode'
        };

        const mapped = mapApiItem(apiItem);
        expect(mapped.poster).toBeNull();
        expect(mapped.link.thumbnail).toBeNull();
      });

      it('sets season to null when season object is missing', () => {
        const apiItem = {
          name: 'Test Episode',
          episodeNumber: 5,
          series: { title: 'Test Series', slug: 'test-series', firstAirDate: '2025-01-01' },
          contentType: 'episode'
        };

        const mapped = mapApiItem(apiItem);
        expect(mapped.season).toBeNull();
      });

      it('sets season to null when episodeNumber is missing', () => {
        const apiItem = {
          name: 'Test Episode',
          season: { seasonNumber: 2 },
          series: { title: 'Test Series', slug: 'test-series', firstAirDate: '2025-01-01' },
          contentType: 'episode'
        };

        const mapped = mapApiItem(apiItem);
        expect(mapped.season).toBeNull();
      });

      it('handles missing series object gracefully', () => {
        const apiItem = {
          name: 'Orphan Episode',
          episodeNumber: 3,
          season: { seasonNumber: 1 },
          contentType: 'episode'
        };

        const mapped = mapApiItem(apiItem);
        expect(mapped).toMatchObject({
          title: 'Orphan Episode',
          originalTitle: '',
          year: null,
          type: 'series',
          season: 'S1:E3',
          slug: null,
          poster: null,
          link: null
        });
      });

      it('always maps episode type to series', () => {
        const withSeries = {
          name: 'Ep',
          episodeNumber: 1,
          season: { seasonNumber: 1 },
          series: { title: 'S', slug: 's' },
          contentType: 'episode'
        };
        const withoutSeries = {
          name: 'Ep',
          episodeNumber: 1,
          season: { seasonNumber: 1 },
          contentType: 'episode'
        };
        expect(mapApiItem(withSeries).type).toBe('series');
        expect(mapApiItem(withoutSeries).type).toBe('series');
      });
    });
  });

  describe('mapApiDetail', () => {
    it('returns empty object if item is falsy', () => {
      expect(mapApiDetail(null)).toEqual({});
    });

    it('maps a movie detail correctly', () => {
      const apiDetail = {
        title: 'Interstellar',
        slug: 'interstellar',
        releaseDate: '2014-11-05',
        runtime: 169,
        overview: 'A team of explorers travel through a wormhole...',
        posterPath: '/interstellar.jpg',
        backdropPath: '/interstellar_bg.jpg',
        genres: [{ name: 'Adventure' }, { name: 'Drama' }, { name: 'Science Fiction' }],
        country: 'United States',
        originalLanguage: 'en',
        director: 'Christopher Nolan',
        cast: [
          { name: 'Matthew McConaughey', character: 'Cooper', profilePath: '/matt.jpg' }
        ],
        trailerUrl: 'https://youtube.com/watch?v=zSWdZVtXT7E',
        keywords: [{ name: 'space travel' }]
      };

      const mapped = mapApiDetail(apiDetail);
      expect(mapped).toMatchObject({
        title: 'Interstellar',
        year: 2014,
        type: 'movie',
        runtime: 'PT169M',
        runtimeMinutes: 169,
        overview: 'A team of explorers travel through a wormhole...',
        poster: 'https://image.tmdb.org/t/p/w300/interstellar.jpg',
        backdrop: 'https://image.tmdb.org/t/p/w1280/interstellar_bg.jpg',
        logo: null,
        backdrops: null,
        genres: ['Adventure', 'Drama', 'Science Fiction'],
        country: 'United States',
        language: 'en',
        director: { name: 'Christopher Nolan', url: null },
        trailer: 'https://youtube.com/watch?v=zSWdZVtXT7E',
        keywords: ['space travel'],
        seasons: null
      });
      expect(mapped.cast).toHaveLength(1);
      expect(mapped.cast[0]).toEqual({
        name: 'Matthew McConaughey',
        character: 'Cooper',
        image: 'https://image.tmdb.org/t/p/w185/matt.jpg'
      });
    });

    it('maps a series detail correctly with seasons', () => {
      const apiDetail = {
        title: 'Game of Thrones',
        slug: 'game-of-thrones',
        numberOfSeasons: 8,
        firstAirDate: '2011-04-17',
        seasons: [
          {
            name: 'Season 1',
            seasonNumber: 1,
            episodeCount: 10,
            episodes: [
              { episodeNumber: 1, title: 'Winter Is Coming', overview: 'Ned Stark...' }
            ]
          }
        ]
      };

      const mapped = mapApiDetail(apiDetail);
      expect(mapped).toMatchObject({
        title: 'Game of Thrones',
        year: 2011,
        type: 'series',
        logo: null,
        backdrops: null,
        seasons: [
          {
            name: 'Season 1',
            seasonNumber: 1,
            episodeCount: 10,
            episodes: [
              { episodeNumber: 1, title: 'Winter Is Coming', overview: 'Ned Stark...' }
            ]
          }
        ]
      });
    });

    it('maps logoPath and backdrops on detail correctly', () => {
      const apiDetail = {
        title: 'Movie with Logo',
        slug: 'movie-with-logo',
        overview: 'Test',
        posterPath: '/poster.jpg',
        backdropPath: '/bg.jpg',
        logoPath: '/logo.png',
        backdrops: ['/bg1.jpg', '/bg2.jpg'],
      };

      const mapped = mapApiDetail(apiDetail);
      expect(mapped.logo).toBe('https://image.tmdb.org/t/p/w500/logo.png');
      expect(mapped.backdrops).toEqual([
        'https://image.tmdb.org/t/p/w1280/bg1.jpg',
        'https://image.tmdb.org/t/p/w1280/bg2.jpg',
      ]);
    });
  });
});
