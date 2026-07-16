'use strict';

require('dotenv').config();

const createApp        = require('./src/app');
const { PORT, CACHE_BACKEND, REDIS_URL } = require('./src/config/env');
const redis = require('./src/lib/redis');
const logger = require('./src/lib/logger');

const app = createApp();

const server = app.listen(PORT, () => {
  logger.info({ port: PORT, cacheBackend: CACHE_BACKEND }, 'server started');
  if (CACHE_BACKEND === 'redis') {
    logger.info({ redisUrl: REDIS_URL }, 'redis target');
  }
});

function shutdown(signal) {
  logger.info({ signal }, 'shutting down gracefully');
  let httpClosed = false;
  let redisClosed = false;
  function maybeExit() {
    if (httpClosed && redisClosed) process.exit(0);
  }
  server.close(() => {
    logger.info('HTTP server closed');
    httpClosed = true;
    maybeExit();
  });
  redis.disconnect().then(() => {
    redisClosed = true;
    maybeExit();
  }).catch(() => { redisClosed = true; maybeExit(); });
  setTimeout(() => {
    logger.error('forced shutdown after timeout');
    process.exit(1);
  }, 10_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  logger.error({ err }, 'uncaught exception');
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'unhandled rejection');
});
