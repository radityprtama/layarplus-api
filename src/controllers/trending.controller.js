'use strict';

const trendingService = require('../services/trending.service');
const geoService = require('../services/geo.service');
const { success } = require('../lib/responseHelper');

/**
 * GET /api/trending/near-you
 *
 * Location-aware "Trending Near You" feed. The detected country is resolved by
 * GeoService (unchanged) and used to fetch a mixed feed of geo-filtered movies
 * AND TV series, merged and ranked by popularity. Response shape and `meta`
 * are preserved for backward compatibility.
 */
exports.nearYou = async (req, res, next) => {
  try {
    const { country, detectedBy } = geoService.resolve(req);
    const results = await trendingService.getNearYou(country);
    success(res, results, { meta: { country, detectedBy } });
  } catch (err) {
    next(err);
  }
};
