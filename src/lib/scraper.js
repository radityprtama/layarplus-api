'use strict';

const { BASE_URL } = require('../config/env');

/**
 * Maps a native JSON API item from the upstream into our standardized schema.
 *
 * Handles two upstream shapes:
 *   Flat:  { title, slug, posterPath, backdropPath, releaseDate, contentType, ... }
 *   Nested (featured/hero):  { contentType, content: { title, slug, posterPath, backdropPath, ... }, ... }
 *
 * @param {Object} item - The raw JSON item from /api/movies or /api/homepage
 * @returns {Object|null} Standardized media item
 */
function mapApiItem(item) {
  if (!item) return null;

  // Featured/hero items nest the actual content under .content
  const src = item.content || item;
  if (!src) return null;

  const rawContentType = item.contentType || src.contentType || '';
  const isEpisode = rawContentType === 'episode';
  const isSeries = isEpisode || rawContentType === 'series' || rawContentType === 'tv_series';
  const epSeries = isEpisode ? (src.series || {}) : {};

  const slug = isEpisode ? (epSeries.slug || null) : src.slug;
  const endpoint = slug ? `${isSeries ? 'series' : 'movie'}/${slug}` : null;

  let year = null;
  const dateStr = isEpisode ? epSeries.firstAirDate : (src.releaseDate || src.firstAirDate);
  if (dateStr) {
    year = parseInt(String(dateStr).substring(0, 4), 10) || null;
  }
  if (!isEpisode && year === null && slug) {
    const match = slug.match(/-(\d{4})$/);
    if (match) year = parseInt(match[1], 10);
  }

  const posterUrl = isEpisode
    ? (src.stillPath
        ? `https://image.tmdb.org/t/p/w300${src.stillPath}`
        : epSeries.posterPath
          ? `https://image.tmdb.org/t/p/w300${epSeries.posterPath}`
          : null)
    : (src.posterPath
        ? `https://image.tmdb.org/t/p/w300${src.posterPath}`
        : null);
  const backdropUrl = src.backdropPath
    ? `https://image.tmdb.org/t/p/w1280${src.backdropPath}`
    : null;
  const logoUrl = src.logoPath
    ? `https://image.tmdb.org/t/p/w500${src.logoPath}`
    : null;

  let season = null;
  if (isEpisode) {
    const sn = src.season && src.season.seasonNumber;
    const en = src.episodeNumber;
    if (sn != null && en != null) season = `S${sn}:E${en}`;
  }

  return {
    title: isEpisode ? (src.name || '') : (src.title || ''),
    originalTitle: isEpisode ? (epSeries.title || '') : (src.title || ''),
    year,
    type: isSeries ? 'series' : 'movie',
    quality: src.quality || null,
    rating: src.voteAverage ? parseFloat(src.voteAverage) : null,
    season,
    poster: posterUrl,
    backdrop: backdropUrl,
    logo: logoUrl,
    slug,
    link: endpoint
      ? {
          endpoint,
          url: `${BASE_URL}/${endpoint}`,
          thumbnail: posterUrl,
        }
      : null,
  };
}

/**
 * Maps a native JSON API detail item from the upstream into our standardized schema.
 * @param {Object} item - The raw JSON item from /api/movies/:slug or /api/series/:slug
 * @returns {Object} Standardized detail item
 */
/**
 * Maps a single upstream episode object into our standardized Episode DTO.
 *
 * Resolves the final thumbnail URL with this fallback chain:
 *   episode stillPath → season poster → series backdrop → series poster → null
 *
 * Forward-looking: also exposes runtime, airDate, and voteAverage so the
 * frontend can render richer episode cards without another backend change.
 *
 * @param {Object} ep - Raw upstream episode from the season endpoint
 * @param {Object} [context]
 * @param {string} [context.seasonPosterPath]  - TMDB path for the season poster
 * @param {string} [context.seriesBackdropPath] - TMDB path for the series backdrop
 * @param {string} [context.seriesPosterPath]   - TMDB path for the series poster
 * @returns {Object} Standardized episode DTO
 */
function mapEpisode(ep, context = {}) {
  const { seasonPosterPath, seriesBackdropPath, seriesPosterPath } = context;

  const stillUrl = ep.stillPath
    ? `https://image.tmdb.org/t/p/w300${ep.stillPath}`
    : null;
  const seasonPosterUrl = seasonPosterPath
    ? `https://image.tmdb.org/t/p/w300${seasonPosterPath}`
    : null;
  const seriesBackdropUrl = seriesBackdropPath
    ? `https://image.tmdb.org/t/p/w1280${seriesBackdropPath}`
    : null;
  const seriesPosterUrl = seriesPosterPath
    ? `https://image.tmdb.org/t/p/w300${seriesPosterPath}`
    : null;

  return {
    episodeNumber: ep.episodeNumber,
    title: ep.name || ep.title || `Episode ${ep.episodeNumber}`,
    overview: ep.overview || null,
    thumbnail: stillUrl || seasonPosterUrl || seriesBackdropUrl || seriesPosterUrl || null,
    runtime: ep.runtime ? parseInt(ep.runtime, 10) : null,
    airDate: ep.airDate || null,
    voteAverage: ep.voteAverage ? parseFloat(ep.voteAverage) : null,
  };
}

function mapApiDetail(item) {
  if (!item) return {};
  const isSeries = !!item.numberOfSeasons;
  const endpoint = `${isSeries ? 'series' : 'movie'}/${item.slug}`;

  let year = null;
  const dateStr = item.releaseDate || item.firstAirDate;
  if (dateStr) {
    year = parseInt(String(dateStr).substring(0, 4), 10) || null;
  }

  const posterUrl = item.posterPath ? `https://image.tmdb.org/t/p/w300${item.posterPath}` : null;
  const backdropUrl = item.backdropPath ? `https://image.tmdb.org/t/p/w1280${item.backdropPath}` : null;
  const logoUrl = item.logoPath ? `https://image.tmdb.org/t/p/w500${item.logoPath}` : null;

  const backdrops = Array.isArray(item.backdrops)
    ? item.backdrops.filter(Boolean).map(p => `https://image.tmdb.org/t/p/w1280${p}`)
    : null;

  let runtime = null;
  let runtimeMinutes = null;
  if (item.runtime) {
    runtimeMinutes = parseInt(item.runtime, 10);
    runtime = `PT${runtimeMinutes}M`;
  }

  return {
    title: item.title || '',
    slug: item.slug || null,
    year,
    type: isSeries ? 'series' : 'movie',
    runtime,
    runtimeMinutes,
    overview: item.overview || null,
    tagline: item.tagline || null,
    poster: posterUrl,
    backdrop: backdropUrl,
    logo: logoUrl,
    backdrops,
    genres: (item.genres || []).map(g => g.name).filter(Boolean),
    country: item.country || null,
    countryCode: null,
    language: item.originalLanguage || null,
    director: item.director ? { name: item.director, url: null } : null,
    cast: (item.cast || []).map(c => ({
      name: c.name,
      character: c.character,
      image: c.profilePath ? `https://image.tmdb.org/t/p/w185${c.profilePath}` : null
    })),
    trailer: item.trailerUrl || null,
    watchUrl: `${BASE_URL}/${endpoint}?play=1`,
    streamUrl: null, // Fetched separately
    keywords: (item.keywords || []).map(k => k.name).filter(Boolean),
    recommendations: [], // Can be populated if API provides it
    seasons: isSeries ? (item.seasons || []).map(s => ({
      name: s.name,
      seasonNumber: s.seasonNumber,
      episodeCount: s.episodeCount,
      episodes: (s.episodes || []).map(e => mapEpisode(e, {
        seasonPosterPath: s.posterPath,
        seriesBackdropPath: item.backdropPath,
        seriesPosterPath: item.posterPath,
      }))
    })) : null
  };
}

module.exports = {
  mapApiItem,
  mapApiDetail,
  mapEpisode,
};