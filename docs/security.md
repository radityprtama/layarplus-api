# Security Architecture

## Overview

LayarPlus API is a **private API** — it is not intended for public or third-party
consumption. Only the Layar+ frontend (via the BFF proxy) and the admin app
should ever reach it.

The security model has four layers, evaluated in order for every request:

```
Client → [Arcjet] → [Auth] → [CORS] → [Circuit Breaker] → Upstream
```

---

## Layer 1 — Arcjet (Rate Limiting + Shield)

[Arcjet](https://docs.arcjet.com) runs first on every request. It provides:

| Feature | Mode | Config |
|---------|------|--------|
| **Shield** | LIVE / DRY_RUN | Detects SQLi, XSS, SSRF, path traversal, etc. |
| **Sliding window** | LIVE / DRY_RUN | Default: 100 req / 60s per IP |
| **Bot detection** | Optional | Off by default; enable via `ARCJET_BOT_DETECTION=true` |

**Arcjet never denies a request on error** — if Arcjet is unreachable or throws,
the request passes through. This prevents Arcjet downtime from breaking the API.

**Env vars:**

- `ARCJET_KEY` — Arcjet API key (get one at https://app.arcjet.com)
- `ARCJET_SHIELD_MODE` — `LIVE` (default) or `DRY_RUN`
- `ARCJET_RATE_MODE` — `LIVE` (default) or `DRY_RUN`
- `ARCJET_RATE_MAX` — max requests per interval (default: 100)
- `ARCJET_RATE_INTERVAL` — interval string (default: `60s`)
- `ARCJET_BOT_DETECTION` — set `true` to enable bot detection

---

## Layer 2 — Bearer Token Auth

After Arcjet passes, every request must carry a valid Bearer token.

```http
Authorization: Bearer <API_KEY>
```

Only the Layar+ BFF proxy (`/api/layarplus/[...path]`) and the admin server-side
Route Handler know this token. The browser never sees it.

**Bypass:** If `API_KEY` is empty (local development), auth is skipped
automatically. Never leave `API_KEY` unset in production.

**Env vars:**

- `API_KEY` — shared secret between BFF proxy and backend

---

## Layer 3 — CORS

The API only responds to configured origins. Requests from unknown origins are
rejected before they reach any route handler.

Default allowed origins:

- `https://layarplus.my.id`
- `https://admin.layarplus.my.id`
- `http://localhost:3000`
- `http://localhost:3001`
- `http://127.0.0.1:3000`

**Env vars:**

- `CORS_ORIGINS` — comma-separated list (e.g. `https://app.com,https://admin.com`)

---

## Layer 4 — Circuit Breaker (Silentium)

The circuit breaker wraps all calls to Silentium (the Chromium microservice).
When Silentium is unhealthy, the breaker opens and upstream requests fail fast
instead of timing out.

| State | Behavior |
|-------|----------|
| CLOSED | Normal — requests pass through |
| OPEN | Requests fail immediately with `CircuitBreakerError` |
| HALF_OPEN | Probes with limited requests; closes on success |

Defaults: 5 consecutive failures → OPEN, 30s reset time, 2 successful probes → CLOSE.

**Env vars:**

- `CIRCUIT_BREAKER_THRESHOLD` — failures before open (default: 5)
- `CIRCUIT_BREAKER_RESET_MS` — time before probe (default: 30000)
- `CIRCUIT_BREAKER_HALF_OPEN_MAX` — successes to close (default: 2)

---

## BFF Proxy Pattern (Frontend)

The Layar+ frontend **never calls the API directly**. All requests go through a
Next.js Route Handler at `/api/layarplus/[...path]` that:

1. Receives the request from the browser
2. Adds the `Authorization: Bearer <API_KEY>` header (server-side only)
3. Forwards to the backend API
4. Returns the response

This ensures:

- The backend API URL is never exposed to the browser
- The API key is never in client-side JavaScript
- CORS origin restrictions are still enforced server-side
- The browser cannot circumvent rate-limiting by calling the API directly

### Files changed for BFF

| File | Change |
|------|--------|
| `apps/web/app/api/layarplus/[...path]/route.ts` | **New** — BFF proxy Route Handler |
| `apps/web/lib/api-client.ts` | Changed `NEXT_PUBLIC_API_URL` → `/api/layarplus` |
| `apps/admin/app/api/admin/content/route.ts` | Uses `API_URL` + `API_KEY` (server-only) |
| `apps/web/lib/content-poller.ts` | Uses `API_URL` + `API_KEY` (server-only) |

---

## Env Vars Checklist

### Backend (`layarplus-api`)

| Variable | Required | Notes |
|----------|----------|-------|
| `ARCJET_KEY` | No | Without it, Arcjet protection is disabled |
| `API_KEY` | Yes in prod | Skipped when empty (dev only) |
| `CORS_ORIGINS` | No | Uses defaults if not set |
| `REQUEST_TIMEOUT_MS` | No | Default 30s |
| `MAX_BODY_SIZE` | No | Default 1mb |

### Frontend (`layarplus`)

| Variable | Required | Notes |
|----------|----------|-------|
| `API_URL` | No | Backend URL (server-only, never `NEXT_PUBLIC_*`) |
| `API_KEY` | Yes in prod | Must match backend `API_KEY` |

> **IMPORTANT:** Never prefix API credentials with `NEXT_PUBLIC_`. That prefix
> embeds the value in client-side JavaScript bundles, leaking secrets.

---

## Request Flow Diagram

```
Browser
  │
  │ GET /movie/inception
  ▼
Next.js BFF Proxy  ←── reads API_URL + API_KEY (server-only)
  │
  │ GET /api/movie/inception
  │ Authorization: Bearer sk-...  (added server-side)
  ▼
Arcjet (rate-limit + Shield)
  │
  ▼
Auth (Bearer token check)
  │
  ▼
CORS (origin validation)
  │
  ▼
Route Handler → Service → httpClient
                              │
                              ▼
                         Circuit Breaker
                              │
                              ▼
                         Silentium (Cloudflare bypass)
                              │
                              ▼
                         Upstream (z2.idlixku.com)
```

---

## Traefik / Dokploy Recommendations

The Docker Compose deploys behind Traefik on Dokploy. Recommended additional
Traefik middleware:

```yaml
# docker-compose.dokploy.yml (partial)
labels:
  - "traefik.http.routers.api.middlewares=api-ratelimit,api-headers"
  - "traefik.http.middlewares.api-ratelimit.ratelimit.average=100"
  - "traefik.http.middlewares.api-ratelimit.ratelimit.burst=200"
  - "traefik.http.middlewares.api-headers.headers.customrequestheaders.X-Forwarded-For="
```

Traefik handles TLS termination. The backend should never be directly reachable
on port 3001 from the internet.

---

## Monitoring

- **Health endpoint** (`GET /api/`): Returns cache stats, Redis readiness,
  circuit breaker state, upstream URLs, and server uptime.
- **Pino structured logs**: All requests and errors are logged as JSON to stdout
  (Docker logs). Key fields: `method`, `path`, `status`, `duration`.
- **Arcjet dashboard**: Monitor rate-limit violations and Shield attacks at
  https://app.arcjet.com.
