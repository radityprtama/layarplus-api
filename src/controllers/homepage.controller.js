"use strict";

const homepageService = require("../services/homepage.service");
const { CACHE_BACKEND } = require("../config/env");
const redis = require("../lib/redis");
const { getStats } = require("../lib/metrics");
const { success } = require("../lib/responseHelper");

exports.status = (req, res) => {
  res.json({
    success: true,
    message: "LayarPlus API v3",
    repo: "radityprtama",
    cache: {
      backend: CACHE_BACKEND,
      redisReady: redis.isReady(),
    },
    metrics: getStats(),
  });
};

exports.featured = async (req, res, next) => {
  try {
    const data = await homepageService.getFeatured();
    success(res, data);
  } catch (err) {
    next(err);
  }
};

exports.cinemaxxi = async (req, res, next) => {
  try {
    const data = await homepageService.getCinemaxxi();
    success(res, data);
  } catch (err) {
    next(err);
  }
};

exports.home = async (req, res, next) => {
  try {
    const data = await homepageService.getHome();
    success(res, data);
  } catch (err) {
    next(err);
  }
};

exports.homeSections = async (req, res, next) => {
  try {
    const data = await homepageService.getHomeSections();
    success(res, data);
  } catch (err) {
    next(err);
  }
};
