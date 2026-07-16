'use strict';

const env = require('../config/env');
const logger = require('../lib/logger');

/**
 * Request timeout middleware.
 *
 * Aborts requests that exceed REQUEST_TIMEOUT_MS (default 30s).
 * Must be mounted early so it wraps all downstream handlers.
 */
function timeoutMiddleware(req, res, next) {
  const ms = env.REQUEST_TIMEOUT_MS;
  const timer = setTimeout(() => {
    logger.warn({ path: req.path, method: req.method }, 'request timeout');
    if (!res.headersSent) {
      res.status(408).json({ success: false, message: 'Request timeout' });
    }
  }, ms);

  res.on('finish', () => clearTimeout(timer));
  res.on('close', () => clearTimeout(timer));

  next();
}

module.exports = timeoutMiddleware;
