'use strict';

const env = require('../config/env');
const logger = require('./logger');

let aj = null;

/**
 * Lazily initialise Arcjet and return the instance.
 *
 * If ARCJET_KEY is not set, Arcjet is disabled and all requests pass through
 * without rate-limiting or bot detection.
 *
 * @returns {import('@arcjet/node').default|null}
 */
function getArcjet() {
  if (aj !== undefined) return aj;

  if (!env.ARCJET_KEY) {
    logger.warn('ARCJET_KEY not set — Arcjet rate-limiting disabled');
    aj = null;
    return aj;
  }

  const arcjet = require('@arcjet/node');

  aj = arcjet.default({
    key: env.ARCJET_KEY,
    rules: [
      // Shield: protect against common attacks (SQLi, XSS, SSRF, etc.)
      arcjet.shield({
        mode: env.ARCJET_SHIELD_MODE === 'DRY_RUN' ? 'DRY_RUN' : 'LIVE',
      }),
      // Sliding window rate limit per IP
      arcjet.slidingWindow({
        mode: env.ARCJET_RATE_MODE === 'DRY_RUN' ? 'DRY_RUN' : 'LIVE',
        interval: env.ARCJET_RATE_INTERVAL,
        max: env.ARCJET_RATE_MAX,
      }),
    ],
  });

  logger.info('Arcjet initialised (Shield + slidingWindow)');
  return aj;
}

/**
 * Express middleware that applies Arcjet protection.
 *
 * Detect + block attacks (Shield), rate-limit per IP (slidingWindow),
 * and optionally detect bots when ARCJET_BOT_DETECTION is enabled.
 *
 * Must be mounted BEFORE auth — we want to rate-limit even unauthenticated
 * requests.
 */
async function arcjetMiddleware(req, res, next) {
  const instance = getArcjet();
  if (!instance) return next();

  try {
    const decision = await instance.protect(req);
    if (decision.isDenied()) {
      const reason = decision.reason;
      if (reason.isRateLimit()) {
        return res.status(429).json({ success: false, message: 'Too many requests' });
      }
      if (reason.isBot()) {
        return res.status(403).json({ success: false, message: 'Bot detected' });
      }
      return res.status(403).json({ success: false, message: 'Request denied' });
    }

    // Bot detection (runs in addition to Shield + rate-limit)
    if (env.ARCJET_BOT_DETECTION) {
      const botDecision = await instance.protect(req, { bot: true });
      if (botDecision.isDenied()) {
        return res.status(403).json({ success: false, message: 'Bot detected' });
      }
    }

    next();
  } catch (err) {
    // Never fail the request if Arcjet errors — log and let through
    logger.error({ err }, 'Arcjet protection error');
    next();
  }
}

module.exports = { getArcjet, arcjetMiddleware };
