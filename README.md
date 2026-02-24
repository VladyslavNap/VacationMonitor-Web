# VacationMonitor Web

Fastify web server providing a full-stack hotel price monitoring application. Includes Google OAuth authentication, a multi-page modern UI, search CRUD, price history with charts, AI insights, CSV export, and a built-in scheduler that enqueues scraping jobs to Azure Service Bus.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  VacationMonitor-Web                                         │
│                                                              │
│  Web UI (Alpine.js + Chart.js, served by Fastify)            │
│  ├── Landing page          GET /                             │
│  ├── Dashboard             GET /dashboard                    │
│  ├── All Prices            GET /all-prices                   │
│  ├── Search detail         GET /search?id=                   │
│  ├── Create / Edit search  GET /new-search                   │
│  └── Settings              GET /settings                     │
│                                                              │
│  Static assets             GET /assets/...                   │
│  ├── public/css/styles.css  — Design system                  │
│  ├── public/js/api.js       — Fetch wrapper                  │
│  └── public/js/auth.js      — Client-side auth guard         │
│                                                              │
│  Fastify API (/api/...)                                      │
│  ├── Google OAuth (/auth/google)                             │
│  ├── User management (/api/users)                            │
│  ├── Search CRUD (/api/searches)                             │
│  ├── All-prices summary (/api/searches/summary/all-prices)   │
│  ├── Price history (/api/searches/:id/prices)                │
│  ├── CSV export (/api/searches/:id/export)                   │
│  └── Excel export (/api/searches/export-all-latest-prices)   │
│                                                              │
│  Scheduler (polls DB every 5 min)                            │
│  └── Enqueues jobs → Azure Service Bus ──────────────────────┼──► VacationMonitor-Worker
│                                                              │
│  Cosmos DB (users, searches, prices, conversations, ...)     │
└──────────────────────────────────────────────────────────────┘
```

## Prerequisites

- Node.js 18+
- Azure Cosmos DB account
- Azure Service Bus namespace + queue (`price-monitor-jobs`)
- Google OAuth credentials (Cloud Console)

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy and fill environment variables
cp .env.example .env
# Edit .env with your Cosmos DB, Service Bus, Google OAuth credentials

# 3. Initialize database containers
npm run init-db

# 4. (Optional) Migrate data from the old monolith
npm run migrate

# 5. Start the server
npm start
# Server starts on http://localhost:3000
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm start` | Start web server + scheduler |
| `npm run dev` | Start with `--watch` for auto-reload |
| `npm run init-db` | Create Cosmos DB database and containers |
| `npm run migrate` | Migrate legacy CSV/JSON data to Cosmos DB |

## UI Pages

| Page | Route | Description |
|------|-------|-------------|
| Landing | `GET /` | Sign-in hero (redirects to `/dashboard` if already authenticated) |
| Dashboard | `GET /dashboard` | All searches overview — run, pause, edit, delete |
| All Prices | `GET /all-prices` | Aggregated latest prices from all active searches with filtering, sorting, and Excel export |
| Search detail | `GET /search?id=` | Price trend chart, latest prices table with unit details, bedroom filter, AI insights |
| Create / Edit | `GET /new-search[?id=]` | URL-paste or manual criteria form; `?id=` enables edit mode |
| Settings | `GET /settings` | Profile, email notifications toggle, account deletion |

The UI is powered by **Alpine.js** and **Chart.js** (both loaded from CDN). Static assets are served from `public/` at the `/assets/` prefix.

### Unit Details Display

Price results now include property unit information when available:

- **Unit cards** display below each property showing available room types (apartments, studios, etc.)
- **Unit specs** include bedrooms, bathrooms, living rooms, kitchens, area (m²), and bed count
- **Bedroom filter** allows filtering properties by minimum bedroom count (client-side)
- **Units data** comes from the Worker's Booking.com scraper and is stored in the `units` array field on each price document
- Properties without unit data display normally without the unit section

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/auth/google` | Initiate Google OAuth |
| `GET` | `/auth/google/callback` | OAuth callback |
| `POST` | `/auth/logout` | Logout |
| `GET` | `/auth/status` | Check auth status |
| `GET` | `/api/users/me` | Get current user profile |
| `PATCH` | `/api/users/me` | Update user profile |
| `DELETE` | `/api/users/me` | Delete account |
| `POST` | `/api/searches` | Create a search (from URL or criteria) |
| `GET` | `/api/searches` | List user's searches |
| `GET` | `/api/searches/summary/all-prices` | Get latest prices from all active searches |
| `GET` | `/api/searches/:id` | Get search details + latest prices |
| `PATCH` | `/api/searches/:id` | Update search |
| `DELETE` | `/api/searches/:id` | Delete search |
| `POST` | `/api/searches/:id/run` | Trigger manual run (enqueue job) |
| `GET` | `/api/searches/:id/prices` | Price history (with filters) |
| `GET` | `/api/searches/:id/prices/latest` | Latest prices |
| `GET` | `/api/searches/:id/insights` | AI insights |
| `GET` | `/api/searches/:id/export` | Download CSV |
| `POST` | `/api/searches/export-all-latest-prices` | Export latest prices from all active searches as Excel (.xlsx) |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `COSMOS_ENDPOINT` | ✅ | Cosmos DB endpoint URL |
| `COSMOS_KEY` | ✅ | Cosmos DB access key |
| `COSMOS_DATABASE_NAME` | ✅ | Cosmos DB database name |
| `AZURE_SERVICE_BUS_CONNECTION_STRING` | ✅ | Service Bus connection string |
| `AZURE_SERVICE_BUS_QUEUE_NAME` | ✅ | Service Bus queue name |
| `GOOGLE_OAUTH_CLIENT_ID` | ✅ | Google OAuth client ID |
| `GOOGLE_OAUTH_CLIENT_SECRET` | ✅ | Google OAuth client secret |
| `GOOGLE_OAUTH_CALLBACK_URL` | ✅ | OAuth callback URL |
| `PORT` | | Server port (default: 3000) |
| `HOST` | | Server host (default: 0.0.0.0) |
| `NODE_ENV` | | Environment (default: development) |
| `SESSION_SECRET` | ✅ | Secure session secret (min 32 chars) |
| `FRONTEND_URL` | | Frontend URL for OAuth redirects |
| `LOG_LEVEL` | | Winston log level (default: info) |

## Related

- **[VacationMonitor-Worker](../VacationMonitor-Worker/)** — Background job processor that consumes Service Bus messages, scrapes Booking.com, and emails reports.
