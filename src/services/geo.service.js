'use strict';

const geoip = require('geoip-lite');

const VALID_COUNTRY = /^[A-Z]{2}$/;

function resolve(req) {
  if (process.env.ENABLE_GEO_TRENDING === 'false') {
    return { country: 'US', detectedBy: 'feature-disabled' };
  }

  const cf = req.headers['cf-ipcountry'];
  if (cf && VALID_COUNTRY.test(cf.toUpperCase())) {
    return { country: cf.toUpperCase(), detectedBy: 'cf-header' };
  }

  const forwarded = req.headers['x-forwarded-for'];
  const ip = (forwarded ? forwarded.split(',')[0].trim() : null) || req.ip || req.connection?.remoteAddress;
  if (ip) {
    const geo = geoip.lookup(ip);
    if (geo && VALID_COUNTRY.test(geo.country)) {
      return { country: geo.country, detectedBy: 'geoip' };
    }
  }

  return { country: 'US', detectedBy: 'fallback' };
}

module.exports = { resolve };
