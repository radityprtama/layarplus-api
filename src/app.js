'use strict';

const express      = require('express');
const helmet       = require('helmet');
const cors         = require('cors');
const path         = require('path');
const routes       = require('./routes');
const errorHandler = require('./middleware/errorHandler');
const authMiddleware = require('./middleware/auth');
const timeoutMiddleware = require('./middleware/timeout');
const { arcjetMiddleware } = require('./lib/arcjet');
const logger = require('./lib/logger');
const env = require('./config/env');

function createApp() {
  const app = express();

  app.set('trust proxy', 1);

  // ── API Documentation (Scalar) ──────────────────────────────────────────
  try {
    const swaggerDocument = require('../swagger_output.json');
    const { apiReference } = require('@scalar/express-api-reference');
    app.use('/docs', apiReference({
      theme: 'purple',
      spec: { content: swaggerDocument },
    }));
  } catch (err) {
    if (process.env.NODE_ENV !== 'test') {
      logger.warn('Swagger output not found. Run `npm run docs:gen` to generate API docs.');
    }
  }

  // ── Security & parsing ──────────────────────────────────────────────────
  app.use(cors({ origin: env.CORS_ORIGINS, credentials: true }));
  app.use(helmet());
  app.use(express.json({ limit: env.MAX_BODY_SIZE }));

  // ── Global middleware ───────────────────────────────────────────────────
  app.use(timeoutMiddleware);
  app.use(arcjetMiddleware);
  app.use(authMiddleware);

  // ── Request logging ─────────────────────────────────────────────────────
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      logger.info({
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration: Date.now() - start,
      }, 'request');
    });
    next();
  });

  // ── API routes ──────────────────────────────────────────────────────────
  app.use('/api', routes);

  // ── Static files ────────────────────────────────────────────────────────
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ── 404 catch-all ──────────────────────────────────────────────────────
  app.use((req, res) => {
    res.status(404).json({ success: false, message: 'API not found' });
  });

  // ── Global error handler ────────────────────────────────────────────────
  app.use(errorHandler);

  return app;
}

module.exports = createApp;
