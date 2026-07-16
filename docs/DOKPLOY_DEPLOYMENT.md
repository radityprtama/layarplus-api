# Dokploy Deployment Guide — LayarPlus API

> **Stack**: Node.js 20 (Express 5) + Silentium (headless Chromium) + Redis 7  
> **Images**: `quay.io/radityprtama/layarplus-api` · `quay.io/radityprtama/silentium` · `redis:7-alpine`  
> **Dokploy provides**: Git integration, Docker build, Traefik reverse proxy, Let's Encrypt TLS, health-based routing, logs, and resource monitoring.

---

## Architecture

Dokploy runs the same 3-service stack defined in `docker-compose.dokploy.yml`:

```
Internet
   │
   ▼
┌───────────────────────────────────────────┐
│  Dokploy (VPS)                            │
│                                           │
│  ┌────────────┐   ┌──────────────┐        │
│  │  Traefik   │──▶│  layarplus-  │        │
│  │  (built-in)│   │  api:3001    │        │
│  └────────────┘   └──────┬───────┘        │
│                          │                │
│              ┌───────────┼───────────┐    │
│              ▼           ▼           │    │
│  ┌─────────────────┐ ┌──────────┐   │    │
│  │  silentium:8191  │ │  redis   │   │    │
│  │  (Cloudflare     │ │  :6379   │   │    │
│  │   bypass)        │ │          │   │    │
│  └─────────────────┘ └──────────┘   │    │
└───────────────────────────────────────────┘
```

- **Traefik** terminates TLS at the edge, routes `https://api.your-domain.com` → `api:3001`
- **Silentium** and **Redis** stay on the private bridge network — no host ports exposed
- All three services have Docker `HEALTHCHECK` — Dokploy won't route traffic until `api` reports healthy

---

## Prerequisites

| Requirement | Minimum | Notes |
|-------------|---------|-------|
| **Dokploy server** | v0.14+ | Any VPS — DigitalOcean, Hetzner, Linode, etc. |
| **CPU** | 2 cores | Silentium runs Chromium — 1 core is too slow |
| **RAM** | 2 GB | 1 GB reserved for Chromium |
| **Disk** | 20 GB | Docker images + logs |
| **Domain** | — | `api.your-domain.com` pointed to VPS IP (A record) |
| **Git repo** | — | Public or private GitHub repo with the API source |

---

## Step 1: Prepare the Docker Compose

The project already ships a **Dokploy-specific** compose file at `docker-compose.dokploy.yml`. This is the file you will paste into Dokploy's Compose editor.

**Do not** use the root `docker-compose.yml` — it exposes host ports and lacks health checks. Use `docker-compose.dokploy.yml`.

Key differences from the generic compose:

| Feature | `docker-compose.yml` | `docker-compose.dokploy.yml` |
|---------|----------------------|------------------------------|
| Port exposure | Host ports for all 3 services | Only `api` published — Traefik handles ingress |
| Health checks | None | All 3 services have `HEALTHCHECK` |
| Dependency ordering | `depends_on` (no condition) | `condition: service_healthy` — waits for Silentium + Redis |
| Network | Default | Named `layarplus-net` bridge |
| CACHE_BACKEND | `redis` (hardcoded) | `${CACHE_BACKEND:-redis}` — overridable via env |
| TMDB_API_KEY | Missing | Included as optional env var |

---

## Step 2: Create a Dokploy Project

### 2.1 New Project

1. Log in to your Dokploy dashboard
2. Click **New Project** → name it `layarplus-api`
3. Choose **Docker Compose** as the deployment type (not "Dockerfile" — the compose manages all 3 services)
4. **Source**: Connect your GitHub repo (`radityprtama/layarplus-api`)

### 2.2 Paste the Compose File

In the **Docker Compose** editor, paste the contents of `docker-compose.dokploy.yml`. If you need to customise (e.g. change the domain port, add env vars), edit here.

**Important edits to make** (customise per your environment):

```yaml
api:
  image: quay.io/radityprtama/layarplus-api:latest
  ports:
    - "3001:3001"          # <-- Dokploy Traefik will route to this port
  environment:
    - PORT=3001
    - IDLIX_BASE_URL=${IDLIX_BASE_URL:-https://z2.idlixku.com}
    - SILENTIUM_API_URL=http://silentium:8191
    - CACHE_BACKEND=${CACHE_BACKEND:-redis}
    - REDIS_URL=redis://redis:6379
    - REDIS_KEY_PREFIX=${REDIS_KEY_PREFIX:-idlc:}
    - ENABLE_GEO_TRENDING=${ENABLE_GEO_TRENDING:-true}
    - TMDB_API_KEY=${TMDB_API_KEY:-}
```

### 2.3 Set Environment Variables

Dokploy has a dedicated **Environment** tab per project. Use it to set these variables:

| Variable | Recommended Value | Purpose |
|----------|-------------------|---------|
| `IDLIX_BASE_URL` | `https://z2.idlixku.com` | Upstream site URL (change if upstream moves) |
| `CACHE_BACKEND` | `redis` | Use Redis for cache — survives restarts, shared across replicas |
| `REDIS_KEY_PREFIX` | `idlc:` | Key namespace in Redis |
| `ENABLE_GEO_TRENDING` | `true` | Location-aware trending via GeoIP |
| `TMDB_API_KEY` | *your TMDB key* | Optional — metadata enrichment for networks/companies |

Get a TMDB API key free at https://www.themoviedb.org/settings/api (skip if not needed).

> Dangling env vars (`${VAR_NAME:-default}`) in the compose file are resolved from Dokploy's environment. If an env var is missing, the default in the compose is used.

### 2.4 Domain & TLS

1. In Dokploy project settings, add your domain: `api.your-domain.com`
2. Dokploy automatically provisions a Let's Encrypt certificate via Traefik
3. TLS termination is handled by Traefik — your app receives plain HTTP on port 3001
4. Ensure the `app.set('trust proxy', 1)` in `src/app.js` is present (it already is) — this makes `req.ip` return the real client IP, which GeoIP trending depends on

That's it. No Nginx, no certbot, no manual SSL renewal.

---

## Step 3: Deploy

### First Deploy

1. Click **Deploy** in the Dokploy dashboard
2. Dokploy will **not** build from source (the compose uses prebuilt images from Quay.io) — it simply pulls `quay.io/radityprtama/layarplus-api:latest`, `quay.io/radityprtama/silentium:latest`, and `redis:7-alpine`
3. Wait for all 3 services to pass their HEALTHCHECK

> If you forked the repo and want Dokploy to build images from source instead, change the `image:` field to `build: .` in the compose. But the prebuilt Quay.io images are preferred — faster deploy, no build dependency in your VPS.

### Verify Deploy

From the Dokploy dashboard, open the **Logs** tab for each service:

```
silentium  → "Listening on port 8191"
redis      → "Ready to accept connections"  
api        → "Listening on PORT 3001"
            "Cache backend: redis"
```

Then hit your domain:

```bash
# Health check endpoint
curl https://api.your-domain.com/api/
# → {"success":true,"message":"LayarPlus API v3"}

# Featured content (exercises the full pipeline: API → Silentium → upstream)
curl https://api.your-domain.com/api/featured
# → {"success":true,"data":[...]}
```

### Redeploy on Updates

When you push new code or a new `layarplus-api` image is published:

1. If the compose uses `image: quay.io/radityprtama/layarplus-api:latest`:
   - Dokploy does **not** auto-pull `:latest` — you must trigger a redeploy
   - In Dokploy, go to the project → **Deployments** → **Redeploy**
   - Or use the **"Update"** button to trigger a fresh pull
2. If the compose pins a specific tag (e.g. `:v3.0.0`):
   - Edit the tag version, save, and redeploy

---

## Step 4: Health Checks

All 3 services have Docker `HEALTHCHECK`. Dokploy monitors these automatically.

| Service | Health Check | Start Period | Interval |
|---------|-------------|--------------|----------|
| api | `GET /api/` returns 200 | 25s | 30s |
| silentium | `GET http://localhost:8191/` returns 200 | 30s | 30s |
| redis | `redis-cli ping` returns PONG | 5s | 15s |

If a service fails its health check, Docker restarts it (`restart: unless-stopped`). Dokploy will show the container as "Unhealthy" and won't route traffic to it.

### Check health from CLI (SSH into VPS):

```bash
docker inspect --format='{{json .State.Health}}' layarplus-api
```

---

## Step 5: Resource Allocation (Recommended)

Dokploy lets you set CPU/memory limits per service. **Silentium (Chromium) is the resource-heavy component.** Recommend these limits:

| Service | Memory Limit | CPU Limit | Reason |
|---------|-------------|-----------|--------|
| `api` | 256 MB | 0.5 core | Express + cache — lightweight |
| `silentium` | 1 GB | 1.0 core | Puppeteer/Chromium — the bottleneck |
| `redis` | 128 MB | 0.25 core | In-memory cache — minimal |

Set these via the `deploy` section in your compose, or in the Dokploy UI under each service's resource tab.

Example compose addition:

```yaml
api:
  deploy:
    resources:
      limits:
        memory: 256M
        cpus: "0.5"

silentium:
  deploy:
    resources:
      limits:
        memory: 1G
        cpus: "1.0"
    environment:
      - HEADLESS=true
      # Reduce Chromium memory pressure
      - PUPPETEER_CHROMIUM_FLAGS=--disable-dev-shm-usage --no-sandbox --disable-gpu

redis:
  deploy:
    resources:
      limits:
        memory: 128M
        cpus: "0.25"
```

---

## Step 6: Monitoring & Logs

### Built-in Dokploy

| Feature | How to Access |
|---------|---------------|
| **Live logs** | Dashboard → Project → Service → **Logs** tab |
| **Container status** | Dashboard → service cards show green/red health |
| **CPU / RAM / Disk** | Server-level metrics in Dokploy sidebar |
| **Deployment history** | Dashboard → **Deployments** tab |

### Application-level logging

The API logs to stdout with these prefixes you can grep for:

```
[silentiumClient]   → Silentium connectivity issues
[cacheService]      → Cache hits/misses
[streamClient]      → Stream extraction diagnostics
```

From the Dokploy logs UI, you can filter by these strings.

### Metrics endpoint

If you use Prometheus/Grafana, note that the API does **not** expose a `/metrics` endpoint. Silentium is the only service with a health-bearing HTTP endpoint.

---

## Step 7: Scaling (Dokploy Replicas)

If the API becomes a bottleneck:

1. In the Dokploy dashboard, increase the `api` service **Replicas** to 2+ 
2. Ensure `CACHE_BACKEND=redis` is set (shared L2 cache) — otherwise each replica has its own cold in-memory Map
3. Traefik (built into Dokploy) load-balances across replicas automatically

Silentium and Redis are **not** designed to be replicated (they are stateful / single-writer). Silentium handles one page load at a time and is fast enough for most workloads.

---

## Step 8: Database / Persistent Data

LayarPlus API has **no persistent database**. All data comes from the upstream site via Silentium. Redis is purely a cache and can be recreated from scratch — it stores nothing irrecoverable.

> **Backup**: None needed. The API is stateless. Upstream is the source of truth.

---

## Step 9: Full Environment Reference

All env vars accepted by the `api` service:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Listen port (must match compose `ports:`) |
| `IDLIX_BASE_URL` | `https://z2.idlixku.com` | Upstream site base URL |
| `SILENTIUM_API_URL` | `http://localhost:8191` | Silentium address (internal DNS: `http://silentium:8191`) |
| `CACHE_BACKEND` | `memory` | `memory` or `redis` |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string (internal: `redis://redis:6379`) |
| `REDIS_KEY_PREFIX` | `idlc:` | Redis key namespace |
| `ENABLE_GEO_TRENDING` | `true` | Enable GeoIP-aware trending |
| `TMDB_API_KEY` | *(empty)* | TMDB API key for metadata enrichment |
| `CACHE_TTL_*` | varies | Per-endpoint cache TTLs (in hours) — see `.env.example` |

---

## Troubleshooting

### Symptom: `api` health check fails repeatedly

```bash
# Exec into the container and test
docker exec -it layarplus-api wget -qO- http://localhost:3001/api/
```

Common causes:
- **Silentium not ready**: `api` waits for `silentium` to be healthy first. Check Silentium logs.
- **Port mismatch**: `PORT` env var must match the compose `ports:` mapping. The compose uses `3001`.
- **OOM**: Chromium consumed all memory. Check resource limits. Increase VPS RAM or reduce Silentium limits.

### Symptom: API returns `{"success":true,"data":[]}` on all endpoints

Silentium is unreachable or failing. From the VPS:

```bash
# Test Silentium directly (from within the Docker network)
docker exec layarplus-api wget -qO- http://silentium:8191/

# Or exec into the api container and test the upstream
docker exec layarplus-api wget -qO- "http://silentium:8191/v1/request" \
  --post-data='{"url":"https://z2.idlixku.com","method":"GET","disableMedia":true}' \
  --header="Content-Type: application/json"
```

If Silentium responds but the API still returns empty data:
- **Cache poisoning**: Silentium was offline briefly and the API cached empty results. Redeploy to restart.
- **Wrong `SILENTIUM_API_URL`**: Verify it's `http://silentium:8191` (Docker DNS, not `localhost`).

### Symptom: CSS/JS blocked in Scalar API docs (`/docs`)

The Scalar docs page loads CDN scripts that may be blocked by helmet CSP. The compose uses the prebuilt `swagger_output.json` that ships with the Docker image. If needed, generate it:

```bash
npm run docs:gen
# Then rebuild/repush the Docker image
```

### Symptom: `ENOENT: no such file or directory, open 'swagger_output.json'`

The prebuilt image already includes `swagger_output.json`. If building from source, run `npm run docs:gen` before building.

### Symptom: GeoIP trending always returns US results

The API needs the real client IP. Ensure:
- `app.set('trust proxy', 1)` is present in `src/app.js` (it is)
- Traefik forwards the `X-Forwarded-For` header (Dokploy's Traefik does this automatically)

---

## Updating the API

### Option A: Use latest tag (auto-pull on redeploy)

1. A new release is published on Quay.io (`quay.io/radityprtama/layarplus-api:latest`)
2. In Dokploy: Project → **Redeploy**
3. Dokploy pulls the fresh `:latest` and restarts with zero-downtime

### Option B: Pin a specific version

Change the `api` image tag in the compose:

```yaml
api:
  image: quay.io/radityprtama/layarplus-api:v3.0.0  # pinned
```

Update the tag and redeploy when you want to upgrade.

---

## Security Notes

- **No host ports for Silentium or Redis**: They sit on the private `layarplus-net` bridge. Only `api:3001` is published.
- **Helmet middleware**: Enabled in `src/app.js` — sets secure HTTP headers (CSP, X-Frame-Options, etc.).
- **Traefik TLS**: Dokploy handles Let's Encrypt renewal automatically.
- **TMDB API key**: Stored as a Dokploy environment variable, never committed to git.
- **CORS**: The API allows all origins (`cors()` with no options). If you need to restrict, add an explicit `cors({ origin: 'https://your-frontend.com' })` in `src/app.js`.
- **Input validation**: The Express middleware validates query params on all endpoints.

---

## Reference: `docker-compose.dokploy.yml` (as of v3.0.0)

```yaml
services:
  silentium:
    image: quay.io/radityprtama/silentium:latest
    container_name: layarplus-silentium
    environment:
      - HEADLESS=true
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:8191/ >/dev/null 2>&1 || exit 1"]
      interval: 30s
      timeout: 5s
      retries: 5
      start_period: 30s
    restart: unless-stopped
    networks: [layarplus-net]

  redis:
    image: redis:7-alpine
    container_name: layarplus-redis
    command: ["redis-server", "--save", "60", "1", "--loglevel", "warning"]
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 15s
      timeout: 3s
      retries: 5
      start_period: 5s
    restart: unless-stopped
    networks: [layarplus-net]

  api:
    image: quay.io/radityprtama/layarplus-api:latest
    container_name: layarplus-api
    ports:
      - "3001:3001"
    environment:
      - PORT=3001
      - IDLIX_BASE_URL=${IDLIX_BASE_URL:-https://z2.idlixku.com}
      - SILENTIUM_API_URL=http://silentium:8191
      - CACHE_BACKEND=${CACHE_BACKEND:-redis}
      - REDIS_URL=redis://redis:6379
      - REDIS_KEY_PREFIX=${REDIS_KEY_PREFIX:-idlc:}
      - ENABLE_GEO_TRENDING=${ENABLE_GEO_TRENDING:-true}
      - TMDB_API_KEY=${TMDB_API_KEY:-}
    depends_on:
      silentium:
        condition: service_healthy
      redis:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:3001/api/ >/dev/null 2>&1 || exit 1"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 25s
    restart: unless-stopped
    networks: [layarplus-net]

networks:
  layarplus-net:
    driver: bridge
```

---

## Quick Reference — Dokploy Checklist

```
[ ] Dokploy server running (v0.14+)
[ ] Domain A record pointed to VPS IP
[ ] GitHub repo connected in Dokploy
[ ] docker-compose.dokploy.yml pasted in Compose editor
[ ] Environment variables set (TMDB_API_KEY optional)
[ ] Domain added in Dokploy project settings
[ ] TLS provisioned automatically (Let's Encrypt)
[ ] Deploy triggered
[ ] All 3 services healthy (green)
[ ] curl https://api.your-domain.com/api/ → 200 OK
[ ] curl https://api.your-domain.com/api/featured → non-empty data
```
