# VacationMonitor Web

Fastify REST API for managing hotels price monitoring searches. Provides Google OAuth authentication, search CRUD, price history browsing, CSV export, and a built-in scheduler that enqueues scraping jobs to Azure Service Bus.

## Architecture

```
┌───────────────────────────────────────────────┐
│  VacationMonitor-Web                          │
│                                               │
│  Fastify API (/api/...)                       │
│  ├── Google OAuth (/auth/google)              │
│  ├── User management (/api/users)             │
│  ├── Search CRUD (/api/searches)              │
│  ├── Price history (/api/searches/:id/prices) │
│  └── CSV export (/api/searches/:id/export)    │
│                                               │
│  Scheduler (polls DB every 5 min)             │
│  └── Enqueues jobs → Azure Service Bus ───────┼──► VacationMonitor-Worker
│                                               │
│  Cosmos DB (users, searches, prices, ...)     │
└───────────────────────────────────────────────┘
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
| `GET` | `/api/searches/:id` | Get search details + latest prices |
| `PATCH` | `/api/searches/:id` | Update search |
| `DELETE` | `/api/searches/:id` | Delete search |
| `POST` | `/api/searches/:id/run` | Trigger manual run (enqueue job) |
| `GET` | `/api/searches/:id/prices` | Price history (with filters) |
| `GET` | `/api/searches/:id/prices/latest` | Latest prices |
| `GET` | `/api/searches/:id/insights` | AI insights |
| `GET` | `/api/searches/:id/export` | Download CSV |

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
