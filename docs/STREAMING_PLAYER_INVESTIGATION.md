# Streaming Player — Investigation & Architecture Proposal

> **Status:** Investigation + architecture only. No code has been changed.
> **Target:** A production-quality player (Netflix / Disney+ / Prime / Apple TV+ / Max class) built on **Vidstack** (latest stable, `@vidstack/react`), maximizing built-in capabilities and minimizing custom code.
> **Scope of repos inspected:** backend `IDLIX-API`, frontend `layarplus`, upstream `z2.idlixku.com` (+ `majorplay.net`), Vidstack docs (via Context7).

---

## 1. Upstream Capabilities (z2.idlixku.com → majorplay.net)

The backend does **not** call upstream directly — requests are tunneled through a "Silentium" Go microservice (`SILENTIUM_API_URL`) to defeat Cloudflare. The playback chain lives entirely in `src/lib/streamClient.js`:

```
1. GET  /api/movies/{slug}                 → content UUID
2. POST /api/views/track                   → analytics (best-effort)
3. GET  /api/watch/play-info/{type}/{uuid} → gateToken + countdown (kind/viewerTier/unlockAt/serverNow)
4. wait (unlockAt − serverNow) ≈ 15s       → anti-scrape delay
5. POST /api/watch/session/claim           → claim JWT + redeemUrl + videoId/title/durationSec/maxHeight
6. POST {redeemUrl} (majorplay.net/api/play) → stream config + subtitles
```

> ⚠️ Upstream response shapes are **inferred from field names the backend reads**, not from captured fixtures. Where uncertain it is noted.

| # | Capability | Upstream reality |
|---|---|---|
| 1 | **How stream URL is obtained** | Only from **step 6** (`majorplay.net/api/play`), field `playData.url`. Mapped at `streamClient.js:314`. |
| 2 | **Stream format** | **HLS `.m3u8` only**, a **single master URL**. No DASH, no MP4, no array of URLs. Adaptive bitrate is handled *inside* the HLS master (standard), but the backend never parses variants. |
| 3 | **Subtitles** | **Yes — WebVTT (`.vtt`)**, multi-language. Array `playData.subtitles[]`, per-track fields **`lang`, `label`, `path`** only (`streamClient.js:305-309`, `path`→`url`). **No `forced`, `default`, `format`, or `kind` flags** — dropped if upstream sends them. |
| 4 | **Multiple audio tracks** | **Not exposed.** No audio-track field read anywhere. Alternate audio renditions (if any) are opaque inside the HLS master. |
| 5 | **Quality info** | **No quality menu.** Only a single scalar `maxHeight` (e.g. `1080`). Catalog items carry a separate cosmetic `quality` badge ("HD"). Quality selection must come from the HLS master playlist. |
| 6 | **Thumbnails (seek/storyboard)** | **Absent.** No sprite/storyboard/timeline-preview field. The only "thumbnail" is the poster image for cards. |
| 7 | **Intro / credits / chapter markers** | **Absent — confirmed.** No `introStart`, `introEnd`, `creditsStart`, `chapters`, `markers`, or timestamps anywhere in the consumed responses. |
| 8 | **Playback metadata** | `title`, `durationSec`, `videoId`, `expiresAt` (URLs are short-lived), `maxHeight`. Season/episode structure comes from the **catalog** API (`/api/series/{slug}/season/{n}`), each episode has `episodeNumber`+`id`. **No next/prev pointers** — adjacency must be derived client-side. |

**Two fragility flags:**
- Stream chain gates on `playInfo.kind === 'gate'` (`streamClient.js:284`), but a live log shows `kind=pentos` — possibly stale.
- Every uncached stream depends on the external Silentium service **plus** an enforced ~15s anti-scrape delay (cache TTL 15 min).

---

## 2. Backend Capabilities

Standard envelope `{ success, data, ... }`. Route prefix `/api`.

| Capability | Route | Source | Notes |
|---|---|---|---|
| Movie detail | `GET /api/movie/:slug` | `movie.controller.js:35` → `mapApiDetail` | `streamUrl` is **null placeholder** in detail |
| Series detail | `GET /api/series/:slug` | `series.controller.js:26` → `mapApiDetail` | `seasons[].episodes[].{episodeNumber,title,overview}` |
| **Episode detail** | **None** | — | Only embedded in series detail |
| Movie stream | `GET /api/movie/:slug/stream` | `movie.service.js:171` | `{ streamUrl, subtitles[], videoId, title, durationSec, maxHeight, expiresAt }` |
| Series stream (first ep) | `GET /api/series/:slug/stream` | `series.service.js:143` | back-compat |
| Episode stream | `GET /api/series/:slug/season/:season/episode/:episode/stream` | `series.service.js:168` | same shape + `season`/`episode` |
| Subtitle URLs | **inline on stream endpoints** | `streamClient.js:305-309` | `[{ lang, label, url }]` |
| Logo / Backdrops / Trailer | **inline on detail** | `scraper.js` | `logo` (TMDB w500), `backdrop`+`backdrops[]` (w1280), `trailer` (passthrough YouTube URL) |

**Mapping layers:** `src/lib/scraper.js` (`mapApiItem`/`mapApiDetail`) for catalog/detail; `src/lib/streamClient.js:305-321` for stream. The stream mapper **whitelists** fields, dropping anything upstream sends that isn't in `{lang,label,url}` / `{streamUrl,subtitles,videoId,title,durationSec,maxHeight,expiresAt}`.

### Backend changes needed (all additive, isolated, backward-compatible)

None are blocking for MVP. The following are *enhancements*, gated behind new optional fields so existing clients are unaffected:

1. **Widen the subtitle mapper** (`streamClient.js:305`) to pass through `forced` and `default` flags *if present upstream* — purely additive to each subtitle object. **Low effort, zero risk.**
2. **Pass through any intro/credits markers if upstream ever provides them.** Currently absent, so this is a no-op placeholder; document that markers are client-derived for now.
3. **(Optional) Episode-detail endpoint** `GET /api/series/:slug/season/:s/episode/:e` returning a single episode + computed `nextEpisode`/`prevEpisode` slugs. Removes client-side adjacency logic. **Medium effort, additive.**
4. **(Optional) Continue-watching persistence** if you want cross-device resume (needs auth + a small progress table). Otherwise resume is localStorage-only on the client. **Defer to roadmap.**

Everything else the player needs is already served. **Do not redesign existing APIs.**

---

## 3. Frontend Architecture Review (layarplus)

**Stack:** Turborepo (Bun) · Next.js **16.2.6 App Router** · React **19.2.4** · TypeScript · Tailwind v4 · shadcn (`@workspace/ui`) · TanStack Query v5 · framer-motion · better-auth/Prisma (auth/comments only).

**Video deps: NONE** — no hls.js/video.js/plyr/vidstack/dash.js.

**Current player = bare native `<video controls src={m3u8}>`**, duplicated in two route files:
- `app/(main)/movie/[slug]/watch/page.tsx:30-46`
- `app/(main)/series/[slug]/episode/[ep-number]/page.tsx:46-62`

```jsx
<video controls className="h-full w-full" src={stream.streamUrl}>
  {stream.subtitles?.map((sub) => (
    <track key={sub.lang} kind="subtitles" src={sub.url} srcLang={sub.lang} label={sub.label} />
  ))}
</video>
```

> 🔴 **Critical existing bug:** `streamUrl` is an HLS `.m3u8`. A raw `<video src>` only plays HLS natively on **Safari**. On Chrome/Firefox/Edge it **does not play** without an MSE library. The current player is effectively broken on most desktop browsers. **Vidstack fixes this on day one** (it bundles hls.js for non-Safari).

**Data layer (reusable as-is):** `lib/api-client.ts` (`fetchApi`), `hooks/use-media.ts` (`useMovieStream`, `useEpisodeStream`), and `types/media.ts` (`StreamResult`, `Subtitle`) already give exactly what Vidstack needs.

**Routing:**
| Purpose | URL |
|---|---|
| Movie detail / watch | `/movie/{slug}` · `/movie/{slug}/watch` |
| Series detail | `/series/{slug}` |
| Episode watch | `/series/{slug}/episode/{ep-number}` |

**Known frontend limitations to fix during the rebuild (pre-existing):**
- Episode watch page is **season-1-only** (`item.seasons[0]`), ignores season in URL.
- Episode selector capped at `.slice(0, 20)`.
- "Next Episode" exists; **no previous-episode**.
- Page navigations remount the player every episode (no in-player playlist/auto-advance).

**Continue Watching:** non-functional but **scaffolding exists** — `ContentCard` has a `progress?` prop + red bar (`content-card.tsx:179-187`), `ContentRow` has `progressMap?` — never wired. The localStorage hook pattern (`use-watchlist.ts` etc.: key + custom event + `storage` listener) is a clean template for `use-watch-progress`.

**Migration verdict: low-to-moderate disruption, additive.** Blast radius = two watch route files + one new player component. Routing, detail pages, API client, and data hooks need **no change**. Only new dep: `@vidstack/react`.

---

## 4. Vidstack Capability Review (via Context7)

Latest Vidstack (`@vidstack/react`) covers nearly the entire wishlist natively:

| Feature | Vidstack native? | How |
|---|---|---|
| HLS playback | ✅ | `<MediaPlayer src="...m3u8">` auto-loads hls.js on non-Safari |
| DASH | ✅ | same provider model (not needed — upstream is HLS) |
| Adaptive + manual quality | ✅ | reads HLS variant levels; `useVideoQualityOptions` / quality menu |
| Subtitle/caption tracks | ✅ | `<Track kind="subtitles">` + `useCaptionOptions` menu |
| Audio tracks | ✅ | `useAudioOptions` (only if HLS master has them) |
| PiP | ✅ | normalized PiP API + button |
| Fullscreen | ✅ | normalized fullscreen API + button |
| AirPlay | ✅ | `useMediaStore` → `canAirPlay`/`isAirPlayConnected` + AirPlay button |
| Google Cast | ✅ | `canGoogleCast`/`isGoogleCastConnected` + Google Cast button |
| Keyboard shortcuts | ✅ | built-in keyboard controls |
| Playback speed | ✅ | built-in rate menu |
| Chapter markers | ✅ | chapters `<Track kind="chapters">` (VTT cues) |
| Thumbnail previews | ✅ | storyboard VTT (`thumbnails` prop) |
| Mobile gestures / double-tap seek | ✅ | gesture controls |
| **Persistence (volume, rate, captions, quality, resume time)** | ✅ | **`storage` option** — saves language, volume, mute, caption visibility, **playback time** across sessions. *This replaces most custom localStorage work.* |
| React / Next.js App Router | ✅ | first-class React components, SSR-safe; client component |
| Lazy loading | ✅ | load strategies + `dynamic()` import |
| Accessibility | ✅ | built-in ARIA, focus, captions styling |

**Key insight:** Vidstack's **`storage` option** natively persists volume, mute, caption visibility, **and playback time** — covering "resume playback," "volume persistence," "subtitle preference persistence," and most of "continue watching" without bespoke code. Use the default layout (`DefaultVideoLayout`) for production-grade controls out of the box, then customize.

---

## 5. Recommended MVP Feature Set (V1)

Legend: **U**=upstream provides · **V**=Vidstack native · **B**=backend work · **Cx**=complexity · **UX**=impact.

| Feature | U | V | B | Cx | UX | In V1? |
|---|---|---|---|---|---|---|
| **HLS playback (cross-browser)** | ✅ | ✅ | – | Low | 🔥🔥🔥 | ✅ (fixes the core bug) |
| Auto quality | ✅(HLS) | ✅ | – | Low | High | ✅ |
| Manual quality selection | ✅(HLS) | ✅ | – | Low | High | ✅ |
| Subtitle selection | ✅ | ✅ | – | Low | 🔥🔥🔥 | ✅ |
| Playback speed | – | ✅ | – | Low | Med | ✅ |
| PiP | – | ✅ | – | Low | Med | ✅ |
| Fullscreen | – | ✅ | – | Low | High | ✅ |
| Keyboard shortcuts | – | ✅ | – | Low | Med | ✅ |
| Mobile gestures / double-tap seek | – | ✅ | – | Low | High | ✅ |
| Resume playback | – | ✅(storage) | – | Low | 🔥🔥 | ✅ |
| Volume persistence | – | ✅(storage) | – | Low | Med | ✅ |
| Playback-speed persistence | – | ✅(storage) | – | Low | Low | ✅ |
| Subtitle-language persistence | – | ✅(storage) | – | Low | Med | ✅ |
| Theater mode | – | layout | – | Low | Med | ✅ |
| Continue Watching integration | – | ✅(storage)+UI | opt. | Med | 🔥🔥 | ✅ (localStorage; wires existing `progressMap` UI) |
| Auto Next Episode | – | events | opt. | Med | High | ✅ |
| Previous Episode | – | UI | opt. | Low | Med | ✅ |
| Episode selector (fix season+20 cap) | catalog | UI | – | Med | High | ✅ |
| AirPlay | – | ✅ | – | Low | Med | ✅ (free) |
| Chromecast / Google Cast | – | ✅ | – | Med | Med | ✅ (free-ish; needs cast button + testing) |
| **Intro Skip** | ❌ | ✅(chapters) | needs data | Med | High | ⚠️ Deferred — **no upstream markers** |
| **Credits Skip** | ❌ | ✅(chapters) | needs data | Med | Med | ⚠️ Deferred — no upstream markers |
| **Timeline thumbnails** | ❌ | ✅(storyboard) | needs data | High | High | ⚠️ Deferred — **no upstream storyboard** |
| **Audio track selection** | ❌ | ✅ | – | Low | Med | ⚠️ Only if HLS master carries audio renditions (likely none) |
| Mini player | – | partial | – | High | Med | ⚠️ Roadmap (cross-route persistence is hard) |

**V1 = everything Vidstack + upstream already support with low/medium effort.** Intro/credits skip, timeline thumbnails, and audio-track menus are **blocked on missing upstream data**, not on Vidstack — so they're roadmap, not MVP.

---

## 6. Recommended Architecture

Avoid a monolithic `<Player>`. Separate by responsibility; let Vidstack own playback, let thin adapters own data/persistence/navigation.

```
app/(main)/movie/[slug]/watch/page.tsx
app/(main)/series/[slug]/episode/[ep-number]/page.tsx   (server/client route shells)
        │  fetch via existing useMovieStream / useEpisodeStream
        ▼
<PlayerPage> (client)                     ── orchestrates: stream data + media metadata + nav context
        │
        ▼
<MediaPlayerProvider>                      ── wraps Vidstack <MediaPlayer>; injects `storage` (persistence)
        │                                     and `src`; handles expiresAt re-fetch/retry
        ▼
<VidstackPlayer>                           ── <MediaPlayer><MediaProvider><DefaultVideoLayout/>
        │                                     thin; mostly Vidstack defaults
        ├── <SubtitleTracks>               ── maps StreamResult.subtitles[] → <Track kind="subtitles">
        ├── <ChapterTracks> (roadmap)      ── intro/credits when data exists
        ├── <StoryboardThumbnails>(roadmap)── thumbnails prop when data exists
        │
        ▼ (sibling managers, not children of the video element)
PlaybackManager (hook)                     ── timeupdate → progress; resume on load (uses Vidstack storage)
ContinueWatchingService (hook)             ── use-watch-progress (localStorage, mirrors use-watchlist pattern)
EpisodeNavigator (hook/component)          ── next/prev/auto-advance; episode+season selector
AnalyticsAdapter (hook)                    ── optional play/seek/complete events
```

**Responsibility split:**
- **Vidstack** owns: rendering, controls, HLS, quality, captions UI, PiP/fullscreen/AirPlay/Cast, keyboard, gestures, and **settings/time persistence via `storage`**.
- **`MediaPlayerProvider`** owns: turning `StreamResult` into a Vidstack source, wiring the `storage` key (per-title for resume), and handling `expiresAt` expiry → re-call the `/stream` hook and reload.
- **`use-watch-progress`** owns: continue-watching list (feeds the dormant `progressMap` UI on home rows).
- **`EpisodeNavigator`** owns: deriving prev/next from the season `episodes[]`, auto-advance on `ended`, and the episode/season selector (fixing the season-1-only + slice(20) bugs).
- Route files stay thin — fetch + render `<PlayerPage>`.

**Persistence strategy:** use Vidstack's built-in `storage` (handles volume, mute, rate, caption visibility/language, playback time) keyed per media id. Layer `use-watch-progress` on top only for the *cross-title* continue-watching rail (Vidstack storage is per-player, not a catalog index).

**`expiresAt` handling:** stream URLs are signed/short-lived. The provider must catch load errors / expiry and transparently re-fetch via the existing React Query hook (`invalidate` + reload `src`). The native element has no such path today — this is new but small.

---

## 7. Future Roadmap (post-MVP)

Blocked on data or genuinely complex — defer:

- **Intro / Credits Skip** — requires markers. Either upstream adds them, you crowd-source/heuristic them, or use an ML/silence-detection pipeline. Vidstack chapter support is ready when data exists.
- **Timeline / storyboard thumbnails** — requires a sprite + VTT generation pipeline (ffmpeg job per title). Vidstack `thumbnails` prop ready when data exists.
- **Audio-track selection** — only meaningful if HLS masters carry alternate audio (currently none observed).
- **Mini player** (cross-route persistent) — hard in Next App Router; needs a portal/global player store.
- **Watch Party / synced playback** — realtime infra (WebSocket), large.
- **AI subtitle translation**, **AI scene search**, **scene bookmarks**, **timestamped comments**, **clip sharing**, **multi-profile watch history** — all net-new product features; sequence after core player is solid.
- **Cross-device continue-watching** — backend auth + progress table (additive endpoint).

---

## 8. Suggested Implementation Order (highest → lowest priority)

1. **Add `@vidstack/react`; build `VidstackPlayer` + `MediaPlayerProvider`; replace the two `<video>` blocks.** → fixes the cross-browser HLS bug (biggest single win). Includes subtitles, quality, speed, PiP, fullscreen, keyboard, gestures — all near-free.
2. **Enable Vidstack `storage`** → resume playback + volume/rate/caption persistence with almost no code.
3. **`use-watch-progress` + wire the dormant `progressMap`/`progress` UI** → Continue Watching rail.
4. **`EpisodeNavigator`**: fix season-1-only + slice(20), add previous-episode, add auto-next on `ended`.
5. **AirPlay (free) + Google Cast button** → test on real devices.
6. **Backend (additive):** widen subtitle mapper for `forced`/`default`; optional episode-detail endpoint with `next/prev`.
7. **Theater mode** (layout toggle).
8. *(Roadmap)* storyboard thumbnails pipeline → intro/credits markers → mini player → watch party / AI features.

---

### Guiding principles honored
- **Maximize Vidstack reuse** — quality, captions UI, persistence, PiP, fullscreen, AirPlay, Cast, keyboard, gestures are all native; near-zero custom playback code.
- **Minimal, additive backend changes** — no API redesign; new fields/endpoints only, backward compatible.
- **Modular** — playback, persistence, continue-watching, and episode navigation are separate units, not one giant component.
- **Production-safe** — handles `expiresAt` expiry and the upstream gate/delay fragility explicitly.
