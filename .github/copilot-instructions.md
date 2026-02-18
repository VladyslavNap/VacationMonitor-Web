---
name: Workspace Instructions
version: 1.0
---

# VacationMonitor Web — Copilot Instructions

## Project Overview
- Fastify web API (ESM) that provides Google OAuth authentication, search management, price browsing, and CSV export endpoints.
- Runs a **scheduler** in the same process that polls Cosmos DB for due searches and enqueues jobs to Azure Service Bus for the separate **Worker** project to consume.
- Entry point: `src/index.js` (starts Fastify server + scheduler).

## Commands (from `package.json`)
- Start: `npm start`
- Dev (watch mode): `npm run dev`
- Initialize Cosmos DB: `npm run init-db`
- Migrate legacy data: `npm run migrate`

## Architecture & Key Files
- **Fastify server**: `src/app.js` — `buildApp()`, `startServer()`
- **Routes**: `src/routes/auth.routes.js`, `users.routes.js`, `searches.routes.js`, `prices.routes.js`
- **HTML page routes**: registered in `src/app.js` — `GET /dashboard`, `GET /search`, `GET /new-search`, `GET /settings`; `GET /` smart-redirects authenticated sessions to `/dashboard`
- **Middleware**: `src/middleware/auth.middleware.js`, `error-handler.middleware.js`
- **OAuth**: `src/auth/google-oauth.service.js`
- **URL parser**: `src/parsers/booking-url-parser.js`
- **Scheduler**: `src/services/scheduler.service.js` — polls DB, enqueues to Service Bus
- **Job queue (sender)**: `src/services/job-queue.service.js` — enqueues jobs; `createReceiver()` unused here
- **Database**: `src/services/cosmos-db.service.js` — Cosmos DB operations for users, searches, prices, conversations
- **Logging**: `src/logger.cjs` — Winston, writes to `logs/`
- **Config**: `config/search-config.json`
- **DB scripts**: `scripts/init-cosmos-db.js`, `scripts/migrate-data.js`

## UI / Frontend Files
- **Views**: `src/views/home.html`, `dashboard.html`, `search.html`, `new-search.html`, `settings.html` — preloaded at startup with `readFileSync`, served as HTML responses
- **Design system**: `public/css/styles.css` — CSS custom properties, all component styles
- **API client**: `public/js/api.js` — `window.api` fetch wrapper (get/post/patch/del); handles 401 → redirect
- **Auth guard**: `public/js/auth.js` — `window.requireAuth()` called on every protected page init
- **Static serving**: `@fastify/static` serves `public/` at prefix `/assets/`
- **Frontend stack**: Alpine.js 3 (CDN) for reactivity, Chart.js 4 (CDN) for price trend charts — no build step

## Communication with Worker
- **Web → Worker**: The scheduler enqueues job messages to Azure Service Bus (`price-monitor-jobs` queue).
- **Worker → Web**: Results are stored in Cosmos DB. The Web API reads them via its routes.
- There is **no direct function-call coupling** between Web and Worker.

## Conventions & Pitfalls
- **ESM + CJS mix**: `package.json` is `type: module`, but `logger.cjs` is CommonJS. Use `createRequire` when importing CJS from ESM.
- **Environment variables**: Cosmos DB (`COSMOS_*`), Service Bus (`AZURE_SERVICE_BUS_*`), Google OAuth (`GOOGLE_OAUTH_*`), server (`PORT`, `HOST`, `SESSION_SECRET`).
- **No scraping or email here** — those belong in the Worker project.
- **CSV export**: `prices.routes.js` uses `csv-writer` to generate CSV download responses from DB data (no file-based CSV).
- **HTML views pattern**: Views are plain HTML files in `src/views/`, loaded once at startup with `readFileSync`. No templating engine. Add new pages by creating the file and registering a `app.get(...)` route in `src/app.js`.
- **Static assets**: Served from `public/` at `/assets/` via `@fastify/static`. CSS goes in `public/css/`, JS in `public/js/`.
- **Frontend auth**: HTML page routes are unauthenticated at the Fastify level; each page calls `window.requireAuth()` on Alpine.js `init()` which hits `GET /auth/status` and redirects to `/` if not authenticated. This keeps auth logic client-side and consistent.
- **CSP disabled**: `contentSecurityPolicy: false` globally in `app.js`, which allows Alpine.js and Chart.js to load from `cdn.jsdelivr.net`. Tighten in production with explicit CDN source allowlists.

## Development Guidance
- Prefer updating config in `config/search-config.json` rather than hardcoding.
- Keep logs informative; `logger.cjs` writes to both console and `logs/`.
- When editing routes, keep request/response schemas up to date.
