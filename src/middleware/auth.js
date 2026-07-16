'use strict';

const env = require('../config/env');

/**
 * Bearer token authentication middleware.
 *
 * Reads the `Authorization: Bearer <token>` header and rejects requests
 * that don't carry the configured API_KEY.
 *
 * The API is private — consumed only by Layar+ frontend (via BFF) and
 * admin app. Public access is not permitted.
 */
function authMiddleware(req, res, next) {
  // If no API_KEY is configured, skip auth for local development
  if (!env.API_KEY) {
    return next();
  }

  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Missing or malformed Authorization header' });
  }

  const token = header.slice(7);
  if (token !== env.API_KEY) {
    return res.status(403).json({ success: false, message: 'Invalid API key' });
  }

  next();
}

module.exports = authMiddleware;
