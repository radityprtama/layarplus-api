"use strict";

const { BASE_URL, SILENTIUM_API_URL } = require("../../config/env");
const logger = require("../logger");

/**
 * Run a fetch() call inside the Silentium Go service.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {string} [opts.method='GET']
 * @param {string} [opts.body]           - Request body (string or JSON string)
 * @param {object} [opts.headers={}]     - Extra headers to merge in
 * @returns {Promise<{ status: number, ok: boolean, text: string }>}
 */
async function browserFetch(url, { method = "GET", body, headers = {} } = {}) {
  try {
    const payload = {
      url,
      method,
      disableMedia: true,
      headers: {
        accept: "*/*",
        "accept-language": "en-US,en;q=0.9",
        ...headers,
      },
    };
    if (body) payload.postData = body;

    const res = await fetch(`${SILENTIUM_API_URL}/v1/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      logger.warn({ status: res.status }, 'silentium HTTP error');
      return { status: res.status, ok: false, text: "" };
    }

    const data = await res.json();
    if (data.status !== "ok" || !data.solution) {
      logger.warn({ data }, 'Silentium failed to solve');
      return { status: 500, ok: false, text: "" };
    }

    return {
      status: data.solution.status,
      ok: data.solution.status >= 200 && data.solution.status < 300,
      text: data.solution.response || "",
    };
  } catch (err) {
    logger.error({ err }, 'silentium service error');
    return { status: 0, ok: false, text: err.message };
  }
}

/**
 * Fetch HTML for a given URL using the Silentium service.
 * @param {string} url
 * @returns {Promise<string>} Full page HTML
 */
async function fetchHtml(url) {
  const res = await browserFetch(url, {
    headers: {
      accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    },
  });

  if (!res.ok) {
    logger.warn({ status: res.status, url }, 'fetchHtml warning');
  }

  return res.text || "";
}

/**
 * Extract the current CF cookies as a header string.
 * Currently stubbed as it may not be necessary with the Silentium service handling cookies.
 */
async function getCookieHeader() {
  return "";
}

/**
 * Tear down the browser. (Stubbed, silentium service runs independently)
 */
async function invalidate() {
  logger.info("invalidate() called - no-op for silentium service");
}

module.exports = { browserFetch, fetchHtml, getCookieHeader, invalidate };
