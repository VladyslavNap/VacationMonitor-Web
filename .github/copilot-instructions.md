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
- **Middleware**: `src/middleware/auth.middleware.js`, `error-handler.middleware.js`
- **OAuth**: `src/auth/google-oauth.service.js`
- **URL parser**: `src/parsers/booking-url-parser.js`
- **Scheduler**: `src/services/scheduler.service.js` — polls DB, enqueues to Service Bus
- **Job queue (sender)**: `src/services/job-queue.service.js` — enqueues jobs; `createReceiver()` unused here
- **Database**: `src/services/cosmos-db.service.js` — Cosmos DB operations for users, searches, prices, conversations
- **Logging**: `src/logger.cjs` — Winston, writes to `logs/`
- **Config**: `config/search-config.json`
- **DB scripts**: `scripts/init-cosmos-db.js`, `scripts/migrate-data.js`

## Communication with Worker
- **Web → Worker**: The scheduler enqueues job messages to Azure Service Bus (`price-monitor-jobs` queue).
- **Worker → Web**: Results are stored in Cosmos DB. The Web API reads them via its routes.
- There is **no direct function-call coupling** between Web and Worker.

## Conventions & Pitfalls
- **ESM + CJS mix**: `package.json` is `type: module`, but `logger.cjs` is CommonJS. Use `createRequire` when importing CJS from ESM.
- **Environment variables**: Cosmos DB (`COSMOS_*`), Service Bus (`AZURE_SERVICE_BUS_*`), Google OAuth (`GOOGLE_OAUTH_*`), server (`PORT`, `HOST`, `SESSION_SECRET`).
- **No scraping or email here** — those belong in the Worker project.
- **CSV export**: `prices.routes.js` uses `csv-writer` to generate CSV download responses from DB data (no file-based CSV).

## Development Guidance
- Prefer updating config in `config/search-config.json` rather than hardcoding.
- Keep logs informative; `logger.cjs` writes to both console and `logs/`.
- When editing routes, keep request/response schemas up to date.
