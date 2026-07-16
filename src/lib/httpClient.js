'use strict';

const { BASE_URL } = require('../config/env');
const { fetchHtml, browserFetch } = require('./cfBypass/cookieHarvester');
const { getStreamData, getEpisodeStreamData } = require('./streamClient');
const { breaker } = require('./circuitBreaker');

const httpClient = {
  async get(path) {
    const url = `${BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
    const data = await breaker.call(() => fetchHtml(url));
    return { data };
  },

  async getJson(path) {
    const url = `${BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
    const res = await breaker.call(() => browserFetch(url, {
      headers: { accept: 'application/json' },
    }));
    if (!res.ok) return null;
    try { return JSON.parse(res.text); } catch (_) { return null; }
  },

  async getStreamData(slug) {
    return getStreamData(slug);
  },

  async getEpisodeStreamData(slug, season, episode) {
    return getEpisodeStreamData(slug, season, episode);
  },

  async close() {},
};

module.exports = httpClient;