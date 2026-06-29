<p align="center">
  <img src="https://shieldcn.dev/header/dots.svg?title=LayarPlus%20API&subtitle=A%20REST%20API%20for%20streaming%20content%20discovery%20with%20Cloudflare%20bypass&theme=zinc" alt="LayarPlus API" />
</p>

<p align="center">
  <a href="https://github.com/radityprtama/layarplus-api/blob/main/LICENSE"><img src="https://shieldcn.dev/github/license/radityprtama/layarplus-api.svg?split=true&size=xs" alt="License" /></a>
  <a href="https://github.com/radityprtama/layarplus-api/releases"><img src="https://shieldcn.dev/github/release/radityprtama/layarplus-api.svg?split=true&size=xs" alt="Release" /></a>
  <a href="https://github.com/radityprtama/layarplus-api/actions/workflows/ci.yml"><img src="https://shieldcn.dev/github/ci/radityprtama/layarplus-api.svg?workflow=CI&branch=main&split=true&size=xs" alt="CI" /></a>
  <a href="https://github.com/radityprtama/layarplus-api/actions/workflows/codeql-analysis.yml"><img src="https://shieldcn.dev/github/ci/radityprtama/layarplus-api.svg?workflow=CodeQL&branch=main&label=CodeQL&split=true&size=xs" alt="CodeQL" /></a>
  <a href="https://github.com/radityprtama/layarplus-api/stargazers"><img src="https://shieldcn.dev/github/stars/radityprtama/layarplus-api.svg?split=true&size=xs" alt="Stars" /></a>
  <a href="https://quay.io/repository/radityprtama/layarplus-api"><img src="https://shieldcn.dev/badge/Docker-quay.io%2Fradityprtama%2Flayarplus-api-CC0000.svg?logo=docker&split=true&size=xs" alt="Quay.io" /></a>
  <a href="https://github.com/radityprtama/layarplus-api"><img src="https://shieldcn.dev/badge/Node-20-339933.svg?logo=nodedotjs&split=true&size=xs" alt="Node" /></a>
  <a href="https://github.com/radityprtama/layarplus-api/commits/main"><img src="https://shieldcn.dev/github/last-commit/radityprtama/layarplus-api.svg?split=true&size=xs" alt="Last Commit" /></a>
</p>

---

## Quick Start

```bash
curl -O https://raw.githubusercontent.com/radityprtama/layarplus-api/main/docker-compose.yml
docker compose up -d
```

The API is available at `http://localhost:3000`. Interactive API docs at [`http://localhost:3000/docs`](http://localhost:3000/docs).

---

## VPS Deployment Guide

This section covers production deployment on a VPS. The API consists of two containers:
- **api** (`layarplus-api``) — Express server that proxies upstream content
- **silentium** — Headless Chromium microservice that bypasses Cloudflare challenges

### Prerequisites

| Requirement | Version |
|-------------|---------|
| Docker | 24+ |
| Docker Compose | v2 (plugin) |
| CPU | 2+ cores (Silentium needs CPU for Chromium) |
| RAM | 2 GB+ |
| Disk | 20 GB+ |
| Domain | Pointed to VPS IP for TLS |

### 1. Clone & Configure

```bash
git clone https://github.com/radityprtama/layarplus-api.git
cd layarplus-api
cp .env.example .env
```

**Critical env vars to set:**

```bash
# Silentium URL — depends on deployment topology (see table below)
SILENTIUM_API_URL=http://silentium:8191

# API port (do not expose directly to the internet — use Nginx)
PORT=3001
```

### 2. Silentium URL Reference

`SILENTIUM_API_URL` must match how the API container can reach Silentium:

| Topology | `SILENTIUM_API_URL` | When to use |
|----------|---------------------|-------------|
| Docker Compose (same compose file) | `http://silentium:8191` | **Default** — Docker DNS resolves the container name |
| API standalone on host, Silentium on same host | `http://localhost:8191` | Manual `npm start`, or Docker run with `--network host` |
| API on host A, Silentium on host B | `http://<host-b-ip>:8191` | Cross-machine setup |
| API in Docker, Silentium on host | `http://host.docker.internal:8191` | Linux requires `--add-host host.docker.internal:host-gateway` |

### 3. Start Services

```bash
docker compose up -d
```

Verify both containers are running:

```bash
docker compose ps
```

Expected output:

```
NAME                IMAGE                                          STATUS
idlix-api           quay.io/radityprtama/layarplus-api:latest      Up (healthy)
silentium           quay.io/radityprtama/silentium:latest          Up
```

### 4. Verify the Pipeline

Run these **four checks** to validate the entire chain:

```bash
# Check 1: API is alive
curl -s http://localhost:3001/api/
# Expected: {"success":true,"message":"LayarPlus API v3"}

# Check 2: Silentium is reachable
curl -s http://localhost:8191/v1/request \
  -X POST -H "Content-Type: application/json" \
  -d '{"url":"https://z2.idlixku.com","method":"GET","disableMedia":true}'
# Expected: {"status":"ok","solution":{...}} with cf_clearance cookie

# Check 3: API returns real data via Silentium
curl -s http://localhost:3001/api/featured
# Expected: {"success":true,"data":[...]} — non-empty array

# Check 4: Movie detail works
curl -s "http://localhost:3001/api/movie/spirited-2022"
# Expected: {"success":true,"data":{"title":"Spirited",...}}
```

If Check 1 passes but Check 3 returns `{"success":true,"data":[]}`, the API cannot reach Silentium (Check 2 will also fail). See [Silentium Configuration](#silentium-configuration).

### 5. Nginx Reverse Proxy

Do **not** expose port 3001 directly. Use Nginx with SSL.

```nginx
# /etc/nginx/sites-available/api.your-domain.com
server {
    listen 80;
    server_name api.your-domain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name api.your-domain.com;

    ssl_certificate     /etc/letsencrypt/live/api.your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.your-domain.com/privkey.pem;

    # Pass through the original client IP for GeoIP trending
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Host $host;
    proxy_set_header CF-IPCountry $http_cf_ipcountry;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
    }
}
```

```bash
# Obtain SSL cert
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d api.your-domain.com

# Test config
sudo nginx -t

# Reload
sudo systemctl reload nginx
```

### 6. Firewall

```bash
# Allow only HTTP/HTTPS and internal Docker networking
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw deny 3001/tcp   # API — block external access
sudo ufw deny 8191/tcp   # Silentium — block external access
sudo ufw enable
```

If Silentium needs to be exposed externally (debugging only), bind to loopback:
```yaml
# docker-compose.yml
silentium:
  ports:
    - "127.0.0.1:8191:8191"
```

### 7. Docker Health Checks

The API container includes a `HEALTHCHECK` that pings `/api/` every 30s. Monitor with:

```bash
docker inspect --format='{{json .State.Health}}' idlix-api
```

### 8. Logs

```bash
# API logs
docker compose logs -f api

# Silentium logs
docker compose logs -f silentium

# API-only: check for [silentiumClient] warnings (connection issues)
docker compose logs api | grep silentiumClient
```

---

## Troubleshooting

### Symptom: API returns `{"success":true,"data":[]}` on all endpoints

**Cause:** API cannot reach Silentium. The upstream `z2.idlixku.com` requires Cloudflare bypass — without Silentium, every upstream request returns empty/blocked.

**Check Silentium connectivity:**

```bash
# From the VPS host, call Silentium directly
curl -s http://localhost:8191/v1/request \
  -X POST -H "Content-Type: application/json" \
  -d '{"url":"https://z2.idlixku.com","method":"GET","disableMedia":true}'
```

If this fails (connection refused, timeout), Silentium is not running:

```bash
docker compose up -d silentium
docker compose logs silentium
```

If this succeeds but the API still returns empty data:

```bash
# Verify the API's SILENTIUM_API_URL is correct
docker compose exec api env | grep SILENTIUM

# Restart both containers to clear stale in-memory cache
docker compose restart
```

**Cache poisoning:** When Silentium was offline, the API cached empty results in memory. Restarting clears the cache and forces fresh fetches.

### Symptom: Silentium returns `"status":"error"`

Chromium OOM or crash. Check logs:

```bash
docker compose logs silentium
```

**Fix:** Increase VPS RAM or restrict Chrome headless flags. Add to `docker-compose.yml`:

```yaml
silentium:
  environment:
    - HEADLESS=true
    # Optional: limit Chrome memory
    - PUPPETEER_CHROMIUM_FLAGS=--disable-dev-shm-usage --no-sandbox
```

### Symptom: `docker compose up -d` fails with "no matching manifest"

The Silentium image URL `quay.io/radityprtama/silentium:latest` may not exist or be private. Verify:

```bash
docker pull quay.io/radityprtama/silentium:latest
```

If unavailable, you can build Silentium from source: [`radityprtama/silentium`](https://github.com/radityprtama/silentium)

### Symptom: API returns 404 for `/api/movie/spirited-2022`

The slug exists upstream as a movie, but the upstream `/api/movies/{slug}` returned 404. First check if Silentium is working (verification steps above). If Silentium is healthy, the upstream may have removed the title.

### Symptom: Stream extraction fails or returns no URL

Streams go through a complex pipeline (UUID → gate token → 15s delay → session claim → .m3u8). This can fail if:
- The upstream gate token flow changed
- The 15s countdown timeout is exceeded
- The upstream blocks the Silentium browser fingerprint

Check logs:

```bash
docker compose logs api | grep stream
```

### Symptom: CORS errors from frontend

The API uses `cors()` with default options (allows all origins). If you added Nginx, ensure it's not stripping CORS headers. Test:

```bash
curl -s -I -X OPTIONS https://api.your-domain.com/api/ \
  -H "Origin: https://your-frontend.vercel.app" \
  -H "Access-Control-Request-Method: GET"
```

Expected: `access-control-allow-origin: *`

### Reset everything

```bash
# Stop and reset
docker compose down -v
docker compose up -d

# Clear Docker cache if images are stale
docker compose pull
docker compose up -d --force-recreate
```

## Features

| Feature | Description |
|---------|-------------|
| **Cloudflare Bypass** | External Silentium Go microservice handles TLS fingerprinting — no Puppeteer in the API process |
| **Stream Extraction** | 6-step pipeline resolves gate tokens, enforces anti-scraping delays, and returns `.m3u8` + `.vtt` |
| **Resilient JSON Mapping** | Direct upstream API mapping (`/api/movies`, `/api/series`) — no Cheerio HTML parsing |
| **In-Memory TTL Cache** | Per-endpoint configurable caching (Map-based, L1; optional Redis L2) |
| **Location-Aware Trending** | GeoIP detection via `CF-IPCountry` header, `x-forwarded-for`, or fallback to `US` |
| **Interactive API Docs** | OpenAPI 3.0.0 via Scalar at `/docs` |
| **Consistent Response Envelope** | Standardized `{ success, data, pagination, filters }` across all endpoints |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Runtime** | Node.js 20+ |
| **Framework** | Express 5 |
| **Testing** | Jest + Supertest |
| **Container** | Docker + Docker Compose |
| **Registry** | Quay.io — `quay.io/radityprtama/layarplus-api` |
| **CI/CD** | GitHub Actions (CI, Release, CodeQL) |
| **Cache** | In-memory Map (L1), Upstash Redis (L2 — planned) |
| **API Docs** | Scalar (OpenAPI 3.0.0 autogenerated) |

---

## Architecture

```
Client
  │
  ▼
LayarPlus API (Express, port 3000)
  │
  ├── CacheService (L1: memory → L2: Redis)
  │
  ├── Upstream API (direct JSON: /api/movies, /api/series, /api/search)
  │
  └── Silentium Microservice (port 8191)
        │
        └── Puppeteer (headless Chromium)
              │
              └── Cloudflare-bypassed requests → majorplay.net

Stream extraction: UUID → gate token → 15s delay → session claim → .m3u8
```

---

## Prerequisites

- **Node.js 20+** (for manual mode)
- **Docker + Docker Compose** (recommended)
- **Silentium microservice** — [`radityprtama/silentium`](https://github.com/radityprtama/silentium) (required for Cloudflare bypass)

---

## Installation

### Docker (recommended)

```bash
docker pull quay.io/radityprtama/layarplus-api:latest
docker compose up -d
```

### Manual

```bash
git clone https://github.com/radityprtama/layarplus-api.git
cd layarplus-api
npm install
cp .env.example .env
# Edit .env with your Silentium service URL
npm start
```

---

## Configuration

Copy `.env.example` to `.env` and adjust:

```bash
cp .env.example .env
```

See [Environment Variables](#environment-variables) for all options.

---

## Running the Project

```bash
# Production
npm start

# Development with auto-reload
npm run dev
```

The server listens on `http://localhost:3000`.

---

## Development

```bash
npm run dev           # Nodemon auto-reload
npm test              # Run tests
npm run test:coverage # With coverage report
npm run docs:gen      # Regenerate OpenAPI spec
```

---

## Docker

### Build

```bash
docker build -t layarplus-api .
```

### Multi-platform build

```bash
docker buildx build --platform linux/amd64,linux/arm64 -t quay.io/radityprtama/layarplus-api:latest .
```

### Docker Compose

```yaml
services:
  api:
    image: quay.io/radityprtama/layarplus-api:latest
    ports:
      - "3000:3000"
    environment:
      - SILENTIUM_API_URL=http://silentium:8191
    depends_on:
      - silentium

  silentium:
    image: radityprtama/silentium:latest
    ports:
      - "8191:8191"
```

---

## Environment Variables

All configurable via `.env` or direct environment variables.

| Variable | Default | Description |
|----------|---------|-------------|
| `IDLIX_BASE_URL` | `https://z2.idlixku.com` | Upstream site URL |
| `PORT` | `3000` | API server port |
| `SILENTIUM_API_URL` | `http://localhost:8191` | Silentium microservice URL |
| `CACHE_TTL_DETAIL` | `2` | Detail page cache TTL (hours) |
| `CACHE_TTL_STREAM` | `0.25` | Stream URL cache TTL (hours) |
| `CACHE_TTL_SEARCH` | `0.5` | Search cache TTL (hours) |
| `ENABLE_GEO_TRENDING` | `true` | Enable GeoIP location-aware trending |
| `REDIS_ENABLED` | `false` | Enable Upstash Redis L2 cache (planned) |

---

## Project Structure

```text
layarplus-api/
├── server.js                 # Entry point
├── src/
│   ├── app.js                # Express app setup, middleware, routes
│   ├── config/
│   │   └── env.js            # Centralised runtime configuration
│   ├── controllers/          # Request handlers
│   │   ├── movie.controller.js
│   │   ├── series.controller.js
│   │   ├── search.controller.js
│   │   ├── homepage.controller.js
│   │   ├── category.controller.js
│   │   ├── trending.controller.js
│   │   └── leaderboard.controller.js
│   ├── services/             # Business logic
│   │   ├── movie.service.js
│   │   ├── series.service.js
│   │   ├── search.service.js
│   │   ├── homepage.service.js
│   │   ├── catalog.service.js
│   │   ├── trending.service.js
│   │   ├── leaderboard.service.js
│   │   └── geo.service.js
│   ├── lib/
│   │   ├── httpClient.js     # Upstream HTTP client with Silentium fallback
│   │   ├── scraper.js        # JSON mapping helpers
│   │   ├── cacheService.js   # TTL cache abstraction (L1)
│   │   ├── streamClient.js   # Stream extraction logic
│   │   ├── responseHelper.js # Response envelope formatting
│   │   └── cfBypass/         # Cloudflare cookie harvesting
│   ├── middleware/
│   │   ├── validate.js       # Request validation
│   │   └── errorHandler.js   # Global error handler
│   └── routes/               # Route definitions
│       ├── index.js
│       ├── movie.routes.js
│       ├── series.routes.js
│       ├── search.routes.js
│       ├── general.routes.js
│       ├── category.routes.js
│       ├── trending.routes.js
│       └── leaderboard.routes.js
├── tests/
│   ├── integration/          # API integration tests
│   │   ├── movie.test.js
│   │   ├── series.test.js
│   │   ├── search.test.js
│   │   ├── homepage.test.js
│   │   ├── catalog.test.js
│   │   ├── genre.test.js
│   │   └── trending.test.js
│   └── fixtures/             # Test fixtures
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── jest.config.js
└── swagger.js                # OpenAPI spec generator
```

---

## API Documentation

Interactive docs available at [`http://localhost:3000/docs`](http://localhost:3000/docs) (OpenAPI 3.0.0 via Scalar).

**Base URL:** `http://localhost:3000/api`

### General

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | API status |
| GET | `/home` | All homepage content (flat array) |
| GET | `/home/sections` | Homepage grouped by section |
| GET | `/featured` | Trending now |
| GET | `/cinemaxxi` | Recently added |

### Search

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/search?q={query}` | Search movies & series |

### Movies

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/movie?page=&limit=&sort=` | Browse movies (paginated) |
| GET | `/movie/trending` | Trending movies |
| GET | `/movie/trending/:page` | Trending by page |
| GET | `/movie/:slug` | Movie detail |
| GET | `/movie/:slug/stream` | Stream URL + subtitles |

### TV Series

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/series?page=&limit=&sort=` | Browse series (paginated) |
| GET | `/series/trending` | Trending series |
| GET | `/series/:slug` | Series detail |
| GET | `/series/:slug/season/:season/episode/:episode/stream` | Stream URL + subtitles |

### Browse by Category

| Method | Endpoint |
|--------|----------|
| GET | `/genre` |
| GET | `/genre/:genre?type=movie\|series` |
| GET | `/country` |
| GET | `/country/:country?type=movie\|series` |
| GET | `/year` |
| GET | `/year/:year` |
| GET | `/network` |
| GET | `/network/:network?type=series` |

### Trending

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/trending/near-you` | Country-aware trending (movies + series, merged by score) |

### Leaderboard

| Method | Endpoint |
|--------|----------|
| GET | `/leaderboard` |

<details>
<summary><b>Response Format</b></summary>

```json
{
  "success": true,
  "data": [ ... ],
  "pagination": {
    "currentPage": 1,
    "totalPages": 5,
    "hasNext": true
  },
  "filters": {
    "type": "movie",
    "genre": "action"
  }
}
```

**List fields:**

| Field | Type | Description |
|-------|------|-------------|
| `title` | string | Media title |
| `originalTitle` | string | Original title |
| `year` | number/null | Release year |
| `type` | string | `"movie"` or `"series"` |
| `poster` | string/null | TMDB poster (w300) |
| `backdrop` | string/null | TMDB backdrop (w1280) |
| `logo` | string/null | TMDB logo/title treatment (w500) |
| `slug` | string | URL identifier |
| `rating` | number/null | Vote average |
| `quality` | string/null | Video quality |

**Detail fields (adds to list fields):**

| Field | Type | Description |
|-------|------|-------------|
| `runtime` | string/null | ISO 8601 duration |
| `runtimeMinutes` | number/null | Minutes |
| `overview` | string/null | Plot |
| `genres` | string[] | Genre names |
| `country` | string/null | Country |
| `language` | string/null | Language |
| `backdrops` | string[]/null | TMDB backdrops (w1280) |
| `director` | object/null | `{ name, url }` |
| `cast` | array | `{ name, character, image }` |
| `trailer` | string/null | YouTube URL |
| `watchUrl` | string | Watch page |
| `streamUrl` | string/null | Stream (separate endpoint) |
| `keywords` | string[] | Keywords |
| `seasons` | array/null | Episode data (series only) |
</details>

---

## Testing

```bash
npm test                # Run all tests
npm run test:coverage   # With coverage report
npm run test:watch      # Watch mode
```

Tests are located in `tests/integration/` and use Jest + Supertest against the running API.

---

## CI/CD

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| [CI](.github/workflows/ci.yml) | PR + push to `main`/`develop` | Syntax check, tests, Docker build verification |
| [Release](.github/workflows/release.yml) | Git tag `v*.*.*` or release published | Build multi-platform image, push to Quay.io, create GitHub Release |
| [CodeQL](.github/workflows/codeql-analysis.yml) | PR + push to `main` + schedule | Static security analysis |

### CI Pipeline

```
Syntax check → Tests (with coverage) → Docker build check
```

### Release Pipeline

```
Tests → Version verification → Build multi-platform image (amd64 + arm64)
  → Push to Quay.io (semver + latest tags) → Create GitHub Release

Attestations: SLSA Provenance + SPDX SBOM
Cache: Registry-based (shared across runners)
```

---

## Security

- **Environment variables** for all secrets — never hardcoded
- **CodeQL analysis** runs on every PR and push to `main`
- **Minimal CI permissions** — `contents: read` by default, escalated only when needed
- **Dependency scanning** via Dependabot (configured in GitHub)
- **Supply-chain attestations** — Docker images include SLSA provenance and SBOM
- **Input validation** middleware on all endpoints

---

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Commit your changes (`git commit -am 'feat: add my feature'`)
4. Push to the branch (`git push origin feat/my-feature`)
5. Open a Pull Request

```bash
npm test          # Ensure tests pass
npm run lint      # Lint if configured
```

PRs are welcome. Open an issue first for significant changes.

---

## License

[MIT](LICENSE) &mdash; &copy; 2025 Raditya Pratama
