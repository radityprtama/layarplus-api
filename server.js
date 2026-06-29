'use strict';

require('dotenv').config();

const createApp        = require('./src/app');
const { PORT, CACHE_BACKEND, REDIS_URL } = require('./src/config/env');
const redis = require('./src/lib/redis');

const app = createApp();

const server = app.listen(PORT, () => {
  console.log(`Listening on PORT ${PORT}`);
  console.log(`Cache backend: ${CACHE_BACKEND}`);
  if (CACHE_BACKEND === 'redis') {
    console.log(`Redis target: ${REDIS_URL}`);
  }
});

function shutdown(signal) {
  console.log(`Received ${signal}, shutting down gracefully...`);
  let httpClosed = false;
  let redisClosed = false;
  function maybeExit() {
    if (httpClosed && redisClosed) process.exit(0);
  }
  server.close(() => {
    console.log('HTTP server closed');
    httpClosed = true;
    maybeExit();
  });
  redis.disconnect().then(() => {
    redisClosed = true;
    maybeExit();
  }).catch(() => { redisClosed = true; maybeExit(); });
  setTimeout(() => {
    console.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});
