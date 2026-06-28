'use strict';

jest.mock('geoip-lite');

const geoip = require('geoip-lite');
const geoService = require('../../src/services/geo.service');

const makeReq = (headers = {}, ip) => ({
  headers,
  ip,
  connection: {},
});

describe('GeoService', () => {
  beforeEach(() => {
    delete process.env.ENABLE_GEO_TRENDING;
    jest.clearAllMocks();
  });

  describe('resolve()', () => {
    it('returns US with feature-disabled when ENABLE_GEO_TRENDING is false', () => {
      process.env.ENABLE_GEO_TRENDING = 'false';
      expect(geoService.resolve(makeReq())).toEqual({
        country: 'US',
        detectedBy: 'feature-disabled',
      });
    });

    it('returns country from CF-IPCountry header', () => {
      const result = geoService.resolve(makeReq({ 'cf-ipcountry': 'ID' }));
      expect(result).toEqual({ country: 'ID', detectedBy: 'cf-header' });
    });

    it('lowercases CF-IPCountry header value before validation', () => {
      const result = geoService.resolve(makeReq({ 'cf-ipcountry': 'jp' }));
      expect(result).toEqual({ country: 'JP', detectedBy: 'cf-header' });
    });

    it('skips invalid CF-IPCountry (3+ chars) and falls through', () => {
      geoip.lookup.mockReturnValue(null);
      const result = geoService.resolve(makeReq({ 'cf-ipcountry': 'USA' }));
      expect(result).toEqual({ country: 'US', detectedBy: 'fallback' });
    });

    it('resolves via geoip-lite when no CF header present', () => {
      geoip.lookup.mockReturnValue({ country: 'JP' });
      const req = makeReq({}, '8.8.8.8');
      expect(geoService.resolve(req)).toEqual({
        country: 'JP',
        detectedBy: 'geoip',
      });
      expect(geoip.lookup).toHaveBeenCalledWith('8.8.8.8');
    });

    it('extracts IP from x-forwarded-for header for geoip lookup', () => {
      geoip.lookup.mockReturnValue({ country: 'DE' });
      const req = makeReq({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' });
      expect(geoService.resolve(req).country).toBe('DE');
      expect(geoip.lookup).toHaveBeenCalledWith('1.2.3.4');
    });

    it('returns fallback US when geoip-lite returns null for the IP', () => {
      geoip.lookup.mockReturnValue(null);
      const req = makeReq({}, '10.0.0.1');
      expect(geoService.resolve(req)).toEqual({
        country: 'US',
        detectedBy: 'fallback',
      });
    });

    it('returns fallback US when geoip-lite returns an invalid country code', () => {
      geoip.lookup.mockReturnValue({ country: 'USA' });
      const req = makeReq({}, '8.8.8.8');
      expect(geoService.resolve(req)).toEqual({
        country: 'US',
        detectedBy: 'fallback',
      });
    });

    it('returns fallback US for private Docker IP (172.x.x.x)', () => {
      geoip.lookup.mockReturnValue(null);
      const req = makeReq({}, '172.17.0.1');
      expect(geoService.resolve(req)).toEqual({
        country: 'US',
        detectedBy: 'fallback',
      });
    });

    it('returns fallback US when no IP is available at all', () => {
      const req = { headers: {}, ip: null, connection: {} };
      expect(geoService.resolve(req)).toEqual({
        country: 'US',
        detectedBy: 'fallback',
      });
    });
  });
});
