'use strict';

/**
 * Minimal TMDB API client for metadata enrichment.
 *
 * Used only when the upstream response lacks network/productionCompany
 * data for a title. NOT a full TMDB client — no Discover, no search.
 *
 * Requires TMDB_API_KEY env var. Returns null on any failure so
 * enrichment is always best-effort.
 */

const { TMDB_API_KEY } = require('../config/env');
const BASE = 'https://api.themoviedb.org/3';

async function getJson(path) {
  if (!TMDB_API_KEY) return null;
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${TMDB_API_KEY}`,
        accept: 'application/json',
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Fetch TV series details from TMDB, returning only the fields
 * relevant to network enrichment: networks, production_companies.
 *
 * @param {number} tmdbId
 * @returns {Promise<{networks: Array}|null>}
 */
async function getTvNetworks(tmdbId) {
  if (!tmdbId) return null;
  const data = await getJson(`/tv/${tmdbId}?append_to_response=`);
  if (!data) return null;
  // TMDB returns { networks: [{ id, name, logo_path, origin_country }] }
  return {
    networks: Array.isArray(data.networks) ? data.networks : null,
  };
}

/**
 * Fetch movie details from TMDB, returning production_companies.
 *
 * @param {number} tmdbId
 * @returns {Promise<{productionCompanies: Array}|null>}
 */
async function getMovieCompanies(tmdbId) {
  if (!tmdbId) return null;
  const data = await getJson(`/movie/${tmdbId}?append_to_response=`);
  if (!data) return null;
  return {
    productionCompanies: Array.isArray(data.production_companies)
      ? data.production_companies
      : null,
  };
}

module.exports = { getTvNetworks, getMovieCompanies };
