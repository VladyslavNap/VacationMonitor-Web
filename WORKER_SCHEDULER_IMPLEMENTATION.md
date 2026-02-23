# Implementing Scheduler in VacationMonitor Worker

## Overview
This document provides instructions for implementing the scheduler functionality in the **VacationMonitor Worker** project. The scheduler was previously running in the Web process but has been moved to the Worker for better separation of concerns and scalability.

## What the Scheduler Does

The scheduler:
1. **Polls Cosmos DB** every N minutes (configurable) to find searches that are due to run
2. **Enqueues jobs** to Azure Service Bus for each due search
3. **Updates timestamps** in Cosmos DB (`nextRun` and `lastRunAt`)
4. **Supports multi-instance deployment** using a distributed lock mechanism
5. **Handles errors gracefully** with consecutive error tracking and auto-shutdown

---

## Files to Create/Migrate

### 1. `src/services/scheduler.service.js` (from Web project)

**Location:** Create this file in your Worker project at `src/services/scheduler.service.js`

**Source:** See the file content below (migrated from Web)

```javascript
import cosmosDBService from './cosmos-db.service.js';
import jobQueueService from './job-queue.service.js';
import distributedLockService from './distributed-lock.service.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const logger = require('../logger.cjs'); // Adjust path if needed

/**
 * Job Scheduler Service
 * Polls database for due searches and enqueues them to Service Bus
 */
class SchedulerService {
  constructor() {
    this.isRunning = false;
    this.intervalId = null;
    this.pollIntervalMs = parseInt(process.env.SCHEDULER_INTERVAL_MINUTES || '5', 10) * 60 * 1000;
    this.consecutiveErrors = 0;
    this.maxConsecutiveErrors = 10;
    this.lastTickTime = null;
  }

  /**
   * Start the scheduler
   */
  async start() {
    if (this.isRunning) {
      logger.warn('Scheduler is already running');
      return;
    }

    // Check if scheduler is disabled via environment variable
    if (process.env.SCHEDULER_ENABLED === 'false') {
      logger.info('Scheduler is disabled via SCHEDULER_ENABLED environment variable');
      return;
    }

    logger.info('Starting job scheduler...', { intervalMinutes: this.pollIntervalMs / 60000 });

    try {
      // Initialize Cosmos DB first
      logger.info('Initializing Cosmos DB connection for scheduler...');
      await cosmosDBService.initialize();

      // Initialize Service Bus
      logger.info('Initializing Service Bus connection for scheduler...');
      await jobQueueService.initialize();

      // Initialize distributed lock for multi-instance support
      logger.info('Initializing distributed lock for multi-instance support...');
      await distributedLockService.initialize();

      // Mark as running ONLY after all services successfully initialized
      this.isRunning = true;
      this.consecutiveErrors = 0;

      // Run immediately on start
      await this.tick();

      // Then run on interval
      this.intervalId = setInterval(() => {
        this.tick().catch(error => {
          logger.error('Scheduler tick failed', { error: error.message, consecutiveErrors: this.consecutiveErrors });
        });
      }, this.pollIntervalMs);

      logger.info('✅ Job scheduler started successfully', { pollIntervalMinutes: this.pollIntervalMs / 60000 });
    } catch (error) {
      logger.error('❌ Failed to start scheduler', { error: error.message, stack: error.stack });
      this.isRunning = false;
      throw error;
    }
  }

  /**
   * Stop the scheduler
   */
  async stop() {
    if (!this.isRunning) {
      logger.info('Scheduler is not running, skipping stop');
      return;
    }

    logger.info('Stopping job scheduler...');

    try {
      this.isRunning = false;

      if (this.intervalId) {
        clearInterval(this.intervalId);
        this.intervalId = null;
        logger.info('Cleared scheduler interval');
      }

      // Release the distributed lock
      try {
        await distributedLockService.releaseLock();
        logger.info('Released distributed lock');
      } catch (lockError) {
        logger.warn('Error releasing distributed lock', { error: lockError.message });
      }

      // Close Service Bus connections
      try {
        await jobQueueService.close();
        logger.info('Closed Service Bus connections');
      } catch (closeError) {
        logger.warn('Error closing Service Bus connections', { error: closeError.message });
      }

      logger.info('✅ Job scheduler stopped gracefully');
    } catch (error) {
      logger.error('Error during scheduler shutdown', { error: error.message });
      this.isRunning = false;
    }
  }

  /**
   * Execute one scheduler tick
   * Finds due searches and enqueues them
   */
  async tick() {
    if (!this.isRunning) {
      return;
    }

    const tickStartTime = Date.now();
    
    try {
      // Try to acquire the distributed lock
      // In multi-instance scenarios, only the instance holding the lock runs the scheduler
      const hasLock = await distributedLockService.acquireLock();
      
      if (!hasLock) {
        logger.debug('Another instance holds the scheduler lock, skipping this tick');
        return;
      }

      logger.info('Scheduler tick: checking for due searches...');

      // Get searches that are due to run
      const dueSearches = await cosmosDBService.getDueSearches(50);

      if (dueSearches.length === 0) {
        logger.debug('No due searches found');
        this.lastTickTime = new Date().toISOString();
        this.consecutiveErrors = 0;
        
        // Renew the lock to keep it active
        await distributedLockService.renewLock();
        return;
      }

      logger.info('Found due searches', { count: dueSearches.length });

      // Prepare jobs for enqueue
      const jobs = dueSearches.map(search => ({
        searchId: search.id,
        userId: search.userId,
        scheduleType: 'scheduled'
      }));

      // Enqueue jobs in batch
      const messageIds = await jobQueueService.enqueueBatch(jobs);

      // Update nextRun timestamp for each search
      const now = new Date();
      const updatePromises = dueSearches.map(search => {
        const nextRun = new Date(now.getTime() + search.schedule.intervalHours * 60 * 60 * 1000);
        
        return cosmosDBService.updateSearch(search.id, search.userId, {
          'schedule.nextRun': nextRun.toISOString(),
          lastRunAt: now.toISOString()
        });
      });

      await Promise.all(updatePromises);

      logger.info('Scheduler tick completed', {
        enqueued: messageIds.length,
        updated: updatePromises.length,
        durationMs: Date.now() - tickStartTime
      });

      // Reset error counter on successful tick
      this.consecutiveErrors = 0;
      this.lastTickTime = new Date().toISOString();
      
      // Renew the lock to keep it active
      await distributedLockService.renewLock();
    } catch (error) {
      this.consecutiveErrors += 1;
      logger.error('Scheduler tick error', {
        error: error.message,
        stack: error.stack,
        consecutiveErrors: this.consecutiveErrors,
        maxConsecutiveErrors: this.maxConsecutiveErrors,
        durationMs: Date.now() - tickStartTime
      });

      // Stop scheduler if too many consecutive failures
      if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
        logger.error('❌ Scheduler stopping due to too many consecutive failures', {
          consecutiveErrors: this.consecutiveErrors
        });
        this.isRunning = false;
        if (this.intervalId) {
          clearInterval(this.intervalId);
          this.intervalId = null;
        }
        
        // Release the lock so another instance can take over
        try {
          await distributedLockService.releaseLock();
        } catch (releaseError) {
          logger.warn('Error releasing lock during shutdown', { error: releaseError.message });
        }
      }
    }
  }

  /**
   * Get scheduler status for monitoring
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      lastTickTime: this.lastTickTime,
      consecutiveErrors: this.consecutiveErrors,
      maxConsecutiveErrors: this.maxConsecutiveErrors,
      pollIntervalMinutes: this.pollIntervalMs / 60000,
      isDisabled: process.env.SCHEDULER_ENABLED === 'false',
      distributedLock: {
        instanceId: distributedLockService.instanceId,
        isLocked: distributedLockService.isLockHeld()
      }
    };
  }
}

// Singleton instance
const schedulerService = new SchedulerService();

export default schedulerService;
```

---

### 2. `src/services/distributed-lock.service.js` (from Web project)

**Location:** Create this file in your Worker project at `src/services/distributed-lock.service.js`

**Purpose:** Ensures only one Worker instance runs the scheduler at a time (important for multi-instance deployments)

**Source:** Copy the entire file from the Web project's `src/services/distributed-lock.service.js`

---

## Integration Steps

### Step 1: Copy Files to Worker Project

1. Copy `scheduler.service.js` from Web to Worker's `src/services/`
2. Copy `distributed-lock.service.js` from Web to Worker's `src/services/`
3. Adjust import paths if your Worker has a different folder structure

### Step 2: Update Worker Entry Point

In your Worker's main entry file (e.g., `src/index.js` or `src/worker.js`), add the scheduler startup:

```javascript
import schedulerService from './services/scheduler.service.js';

async function main() {
  try {
    logger.info('='.repeat(60));
    logger.info('VacationMonitor Worker — Job Processor + Scheduler');
    logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
    logger.info('='.repeat(60));

    // Start the job queue receiver (existing functionality)
    await jobQueueService.startReceiver();

    // Start the scheduler
    try {
      await schedulerService.start();
      logger.info('✅ Scheduler started successfully');
    } catch (error) {
      logger.warn('Scheduler failed to start', { error: error.message });
      logger.info('Worker is processing jobs but scheduler is offline');
    }

    logger.info('✅ Worker started successfully');
  } catch (error) {
    logger.error('Worker failed to start', { error: error.message, stack: error.stack });
    process.exit(1);
  }
}

// Graceful shutdown
let gracefulShutdownInProgress = false;

async function handleShutdown(signal) {
  if (gracefulShutdownInProgress) {
    logger.warn(`${signal} received again, forcing exit`);
    process.exit(1);
  }

  gracefulShutdownInProgress = true;
  logger.info(`${signal} received, initiating graceful shutdown...`);

  const shutdownTimeout = setTimeout(() => {
    logger.error('Graceful shutdown timeout exceeded (30s), forcing exit');
    process.exit(1);
  }, 30000);

  try {
    // Stop scheduler first
    await schedulerService.stop();
    
    // Stop job receiver
    await jobQueueService.close();

    logger.info('✅ Graceful shutdown completed');
    clearTimeout(shutdownTimeout);
    process.exit(0);
  } catch (error) {
    logger.error('Error during graceful shutdown', { error: error.message });
    clearTimeout(shutdownTimeout);
    process.exit(1);
  }
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

main();
```

### Step 3: Environment Variables

Add these to your Worker's environment configuration (`.env`, Azure App Service settings, etc.):

```bash
# Scheduler Settings
SCHEDULER_ENABLED=true                    # Set to 'false' to disable scheduler
SCHEDULER_INTERVAL_MINUTES=5              # How often to poll for due searches

# Existing variables (already in Web project)
COSMOS_ENDPOINT=                          # Same as Web
COSMOS_KEY=                               # Same as Web
COSMOS_DATABASE_NAME=                     # Same as Web
AZURE_SERVICE_BUS_CONNECTION_STRING=      # Same as Web
```

### Step 4: Verify Dependencies

Ensure your Worker's `package.json` includes:

```json
{
  "dependencies": {
    "@azure/service-bus": "^7.x.x",
    "@azure/cosmos": "^4.x.x",
    "winston": "^3.x.x",
    "dotenv": "^16.x.x"
  }
}
```

### Step 5: Update CosmosDB Service

Ensure your Worker's `cosmos-db.service.js` includes the `getDueSearches()` method:

```javascript
/**
 * Get searches that are due to run
 * @param {number} limit - Maximum number of searches to return
 * @returns {Promise<Array>} - Array of due searches
 */
async getDueSearches(limit = 50) {
  try {
    const now = new Date().toISOString();
    
    const { resources } = await this.searchesContainer.items
      .query({
        query: `
          SELECT TOP @limit * FROM c 
          WHERE c.schedule.enabled = true 
          AND c.schedule.nextRun <= @now
          ORDER BY c.schedule.nextRun ASC
        `,
        parameters: [
          { name: '@limit', value: limit },
          { name: '@now', value: now }
        ]
      })
      .fetchAll();

    return resources;
  } catch (error) {
    logger.error('Failed to get due searches', { error: error.message });
    throw error;
  }
}
```

---

## Testing

### Local Testing

1. **Start Worker with environment variables:**
   ```bash
   SCHEDULER_ENABLED=true SCHEDULER_INTERVAL_MINUTES=1 npm start
   ```

2. **Check logs for scheduler activity:**
   ```
   ✅ Job scheduler started successfully
   Scheduler tick: checking for due searches...
   Found due searches { count: 3 }
   ```

3. **Manually create a due search in Cosmos DB** to test:
   ```json
   {
     "id": "test-search-123",
     "userId": "test-user",
     "schedule": {
       "enabled": true,
       "nextRun": "2026-02-23T10:00:00.000Z",
       "intervalHours": 24
     }
   }
   ```

### Multi-Instance Testing

1. **Deploy multiple Worker instances** (2+ instances in Azure Container Apps or App Service)
2. **Verify only one instance acquires the lock:**
   ```
   Instance A: Scheduler tick: checking for due searches...
   Instance B: Another instance holds the scheduler lock, skipping this tick
   ```

---

## Monitoring & Health Checks

### Add Health Endpoint (Optional)

If your Worker has an HTTP health endpoint, expose scheduler status:

```javascript
app.get('/health', async (request, reply) => {
  const schedulerStatus = schedulerService.getStatus();
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    scheduler: schedulerStatus
  };
});
```

### Azure Application Insights

Add custom metrics:

```javascript
const { TelemetryClient } = require('applicationinsights');
const appInsights = new TelemetryClient(process.env.APPLICATIONINSIGHTS_CONNECTION_STRING);

// In scheduler tick():
appInsights.trackMetric({ name: 'Scheduler.DueSearchesCount', value: dueSearches.length });
appInsights.trackMetric({ name: 'Scheduler.TickDuration', value: Date.now() - tickStartTime });
```

---

## Deployment Considerations

### Azure App Service / Container Apps

1. **Set environment variables** in Azure Portal or via CLI
2. **Use at least 2 instances** for high availability
3. **Monitor logs** via Azure Portal → Log Stream or Application Insights

### Docker

Update your `Dockerfile` if needed:

```dockerfile
FROM node:20-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY . .

# Environment variables will be provided at runtime
ENV NODE_ENV=production
ENV SCHEDULER_ENABLED=true
ENV SCHEDULER_INTERVAL_MINUTES=5

CMD ["node", "src/index.js"]
```

---

## Troubleshooting

### Scheduler Not Starting

**Symptom:** Logs show "Scheduler is disabled"

**Fix:** Check `SCHEDULER_ENABLED` environment variable is not set to `'false'`

### Multiple Instances Running Scheduler

**Symptom:** Duplicate jobs being enqueued

**Fix:** 
- Verify `distributed-lock.service.js` is working correctly
- Check Cosmos DB connection is shared across instances
- Ensure `lockDurationSeconds` is longer than `pollIntervalMs`

### High Consecutive Errors

**Symptom:** Scheduler stops after 10 consecutive failures

**Fix:**
- Check Cosmos DB connectivity
- Check Service Bus connectivity
- Review error logs for root cause
- Restart Worker to reset error counter

---

## Rollback Plan

If issues occur:

1. **Disable scheduler in Worker:**
   ```bash
   SCHEDULER_ENABLED=false
   ```

2. **Web project can be reverted** by re-adding the scheduler (this was removed as part of the separation)

---

## Summary

✅ **Scheduler moved to Worker** → Better separation of concerns  
✅ **Multi-instance support** → Distributed lock prevents duplicate jobs  
✅ **Graceful shutdown** → Releases locks and closes connections  
✅ **Environment-driven** → Easy to enable/disable and configure intervals  
✅ **Error resilience** → Auto-stops after 10 consecutive failures  

The Worker is now responsible for **both** job processing (receiving from Service Bus) and job scheduling (polling Cosmos DB).
