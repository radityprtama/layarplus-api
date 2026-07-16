# LayarPlus API — AGENTS.md

## What this is

Express 5 scraper that proxies upstream content (z2.idlixku.com) through a headless Chromium microservice (Silentium) to bypass Cloudflare. Responses are cached in-memory (L1) + optionally Redis (L2).

## Architecture (3 services)

```
Traefik (Dokploy) → api:3001 → silentium:8191 → upstream
                              → redis:6379 (L2 cache)
```

- **api** — Node 20, Express 5. The only container with a published port.
- **silentium** — Go + Chromium. Cloudflare bypass. Private bridge network.
- **redis** — L2 cache. Optional; L1 (in-process Map) works without it.

## Entry points

| File | Role |
|------|------|
| `server.js` | Entrypoint. Loads dotenv, creates app, listens, graceful shutdown on SIGTERM/SIGINT |
| `src/app.js` | Express factory (`createApp()`). Mounts middleware, routes, docs, 404 handler, error handler |
| `src/config/env.js` | **Single source of truth** for all env vars. Never read `process.env` elsewhere |
| `src/routes/index.js` | Route aggregator — mounts all route modules under `/api` |

## Response envelope

Every API response follows `{ success, data, pagination?, filters?, meta? }`. Use `responseHelper.success(res, data, opts)` and `responseHelper.error(res, message, status)` — never build response objects manually.

## Routes

```
GET  /api/                               — status (cache backend, redisReady, metrics)
GET  /api/featured                       — trending now
GET  /api/home                           — homepage (flat array)
GET  /api/home/sections                  — homepage (grouped by section)
GET  /api/search?q=                      — search (movies + series)
GET  /api/movie?page=&limit=&sort=      — browse movies (paginated)
GET  /api/movie/:slug                    — movie detail
GET  /api/movie/:slug/stream             — stream URL + subtitles
GET  /api/series?page=&limit=&sort=     — browse series (paginated)
GET  /api/series/:slug                   — series detail
GET  /api/series/:slug/season/:n/episode/:n/stream
GET  /api/trending/near-you              — GeoIP-aware trending
GET  /api/leaderboard
```

## Cache architecture

Two-tier: L1 (in-process `Map`, synchronous) + L2 (Redis, async).

- `CacheService.readThrough(key, ttlHours, category, fetcher)` — use this pattern in all services. Single-flight coalesces concurrent misses on the same key.
- L1 has periodic eviction (24h cutoff, every 5 min).
- L2 is lazy-init from `redis.js`. When Redis is down, L2 failures are swallowed — L1 still works.
- Metrics exposed in `/api/` status response per category: `{ hits, misses, hitRate, avgMissLatencyMs, l2Hits, l2Misses }`.

### Known L2 caveat

`CacheService._l2Client()` distinguishes three states via `this._l2`:
- `undefined` → not yet initialized (triggers lazy init)
- `null` → explicitly disabled (test injection only)
- Redis client → enabled

The constructor does **not** default `redisClient = null` — if it did, lazy init would never run. Do not add that default back.

## Commands

```bash
npm start              # Production
npm run dev            # Nodemon auto-reload
npm test               # Jest (all tests)
npm run test:coverage  # With coverage (thresholds: branches 65%, funcs 80%, lines 80%)
npm run test:watch     # Watch mode
npm run docs:gen       # Regenerate swagger_output.json from route annotations
```

No linter or formatter config in the repo. CI runs `node --check` syntax validation instead.

## Test conventions

- **Unit tests**: `tests/unit/*.test.js` — mock cacheService, test service logic.
- **Integration tests**: `tests/integration/*.test.js` — use `supertest` against `createApp()` (no `.listen()`). Mock upstream HTTP via `cacheMock` fixture.
- **Fixtures**: `tests/fixtures/` — `builders.js` for response shapes, `cacheMock.js` for cache mocking pattern.
- All integration tests mock `cacheService` via `jest.mock('../../src/lib/cacheService', () => require('../fixtures/cacheMock')())`.
- `testTimeout: 10_000` in jest.config.js.

## Silentium dependency

The API cannot return real data without Silentium. All upstream requests route through `httpClient.js` → `cfBypass/cookieHarvester` which calls Silentium's HTTP API.

If `/api/` returns `{ success: true, data: [] }` everywhere, Silentium is unreachable. Expected `SILENTIUM_API_URL` values:

| Topology | URL |
|----------|-----|
| Docker Compose | `http://silentium:8191` |
| Standalone | `http://localhost:8191` |

## Dokploy deployment

Use **only** `docker-compose.dokploy.yml` (not the root `docker-compose.yml`). Key differences:
- No host ports for Silentium or Redis (private `layarplus-net` bridge).
- `condition: service_healthy` on depends — API waits for both deps.
- `pull_policy: always` on silentium to ensure fresh wget/curl for health checks.
- Health checks on all 3 services (30s interval, varying start periods).
- Port 3001 (not 3000) in Dokploy compose — `PORT` env and `ports` mapping match.

## Environment variables

All defined in `src/config/env.js`. Key ones:

| Variable | Default | Notes |
|----------|---------|-------|
| `IDLIX_BASE_URL` | `https://z2.idlixku.com` | Upstream site |
| `PORT` | `3000` | Express listen port |
| `SILENTIUM_API_URL` | `http://localhost:8191` | Cloudflare bypass |
| `CACHE_BACKEND` | `memory` | `redis` enables L2 |
| `REDIS_URL` | `redis://localhost:6379` | Only used when `CACHE_BACKEND=redis` |
| `ENABLE_GEO_TRENDING` | `true` | GeoIP detection |
| `TMDB_API_KEY` | `(empty)` | Metadata enrichment |

Cache TTLs default to 1h for most endpoints, 2h for details, 15min for streams, 30min for search.

## CI/CD

| Workflow | Trigger | What it does |
|----------|---------|-------------|
| CI | push/PR to main/develop | `node --check` syntax → Jest coverage → Docker build (no push) |
| Release | tag `v*.*.*` | Tests → verify version matches tag → multi-arch build → push to Quay.io → GitHub Release |
| CodeQL | push/PR + schedule | Static security analysis |

CI tests run without external services — all upstream calls are mocked.

## Docker image

- Base: `node:20-alpine`
- Non-root user `appuser` (uid not fixed).
- `HEALTHCHECK` on `GET /api/` every 30s.
- `npm ci --omit=dev` — dev deps stripped.
- Lockfile (`package-lock.json`) required for `npm ci`.

## Do's

- Route all upstream HTTP through `httpClient.js` (handles Cloudflare via Silentium).
- Use `cacheService.readThrough(key, ttl, category, fetcher)` for all cacheable data.
- Add new env vars to `src/config/env.js` only — never read `process.env` in controllers/services.
- Use `responseHelper.success()` / `responseHelper.error()` for consistent envelope.
- Add route modules to `src/routes/` and mount them in `src/routes/index.js`.
- Match the existing controller → service → lib layering.
- Use the same test mock pattern (`cacheMock.js` + `jest.mock`).

## Don'ts

- Don't read `process.env` outside `src/config/env.js`.
- Don't expose Silentium or Redis ports to the host in Dokploy compose.
- Don't add the `= null` default back to `CacheService` constructor param — breaks lazy L2 init.
- Don't run integration tests without mocking cacheService (they'll hit real upstream).
- Don't use `npm install` for production — use `npm ci`.
- Don't edit `docker-compose.dokploy.yml` port mapping without also updating `PORT` env var.
- Don't suppress errors with empty catch blocks — the error handler logs 500s.
