'use strict';

const searchService = require('../services/search.service');
const { success }   = require('../lib/responseHelper');

exports.search = async (req, res, next) => {
  try {
    const q = req.query.q;
    const page  = req.query.page  ? parseInt(req.query.page, 10)  : undefined;
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : undefined;
    const sort  = req.query.sort  || undefined;

    const { items, total } = await searchService.search(q, { page, limit, sort });

    const perPage = limit || 20;
    const currentPage = page || 1;
    const totalPages = Math.ceil(total / perPage);

    success(res, items, {
      pagination: {
        currentPage,
        totalPages,
        hasNext: currentPage < totalPages,
      },
      meta: { query: q, count: items.length, total },
    });
  } catch (err) {
    next(err);
  }
};
