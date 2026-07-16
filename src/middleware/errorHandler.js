'use strict';

const logger = require('../lib/logger');

// eslint-disable-next-line no-unused-vars
module.exports = (err, req, res, next) => {
  const status  = err.status  || 500;
  const message = err.message || 'Internal Server Error';

  if (status >= 500) {
    logger.error({ err, path: req.path, method: req.method }, err.message);
  }

  res.status(status).json({ success: false, message });
};
