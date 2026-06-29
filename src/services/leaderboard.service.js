'use strict';

const httpClient = require('../lib/httpClient');
const cache      = require('../lib/cacheService');
const { CACHE_TTL } = require('../config/env');
const { mapApiItem } = require('../lib/scraper');

/**
 * Fetch the leaderboard from the upstream native JSON API.
 * Returns an object containing multiple leaderboard categories.
 *
 * @returns {Promise<Object>}
 */
async function getLeaderboard() {
  return cache.readThrough('leaderboard', CACHE_TTL.leaderboard, 'leaderboard', async () => {
    const data = await httpClient.getJson('/api/leaderboard');
    if (!data) return {};

    return {
      month: data.month,
      updatedAt: data.updatedAt,
      topMovies: (data.topMovies || []).map(mapApiItem),
      topSeries: (data.topSeries || []).map(mapApiItem),
      topWatchlisted: (data.topWatchlisted || []).map(mapApiItem),
      topFavourited: (data.topFavourited || []).map(mapApiItem),
      // Pass through reviews and comments directly if they exist
      topReviews: data.topReviews || [],
      topComments: data.topComments || []
    };
  });
}

module.exports = { getLeaderboard };
