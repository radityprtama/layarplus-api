'use strict';

const catalogService = require('../services/catalog.service');
const { success }    = require('../lib/responseHelper');

exports.index = async (req, res, next) => {
  try {
    const data = await catalogService.getCategoryIndex(req.category);
    success(res, data);
  } catch (err) {
    next(err);
  }
};

exports.browse = async (req, res, next) => {
  try {
    const { value } = req.params;
    const page  = Number(req.query.page)  || Number(req.params.page) || 1;
    const limit = req.query.limit;
    const sort  = req.query.sort || undefined;
    const type  = req.query.type === 'movie' || req.query.type === 'series' ? req.query.type : undefined;
    const result = await catalogService.getCategoryBrowse(req.category, value, type, page, limit, sort);
    success(res, result.items, { pagination: result.pagination, filters: { [req.category]: value, type: type || 'all', page } });
  } catch (err) {
    next(err);
  }
};

exports.browseSeries = async (req, res, next) => {
  try {
    const { value } = req.params;
    const page  = Number(req.query.page)  || Number(req.params.page) || 1;
    const limit = req.query.limit;
    const sort  = req.query.sort || undefined;
    const result = await catalogService.getCategoryBrowse(req.category, value, 'series', page, limit, sort);
    success(res, result.items, { pagination: result.pagination, filters: { [req.category]: value, type: 'series', page } });
  } catch (err) {
    next(err);
  }
};

exports.browseMovie = async (req, res, next) => {
  try {
    const { value } = req.params;
    const page  = Number(req.query.page)  || Number(req.params.page) || 1;
    const limit = req.query.limit;
    const sort  = req.query.sort || undefined;
    const result = await catalogService.getCategoryBrowse(req.category, value, 'movie', page, limit, sort);
    success(res, result.items, { pagination: result.pagination, filters: { [req.category]: value, type: 'movie', page } });
  } catch (err) {
    next(err);
  }
};
