'use strict';

const pino = require('pino');

/**
 * Structured logger using Pino.
 *
 * - Production: JSON to stdout (Docker logs)
 * - Dev/test: pretty-print to stderr for readability
 */
const logger = pino({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  transport: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'test'
    ? undefined
    : { target: 'pino/file', options: { destination: 2 } },
});

module.exports = logger;
