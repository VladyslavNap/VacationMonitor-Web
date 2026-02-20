import cosmosDBService from './cosmos-db.service.js';
import jobQueueService from './job-queue.service.js';
import distributedLockService from './distributed-lock.service.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const logger = require('../logger.cjs');

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

  /**
   * Manually trigger a search to run immediately
   * @param {string} searchId - Search ID to run
   * @param {string} userId - User ID who owns the search
   */
  async triggerManualRun(searchId, userId) {
    try {
      // Verify search exists
      const search = await cosmosDBService.getSearch(searchId, userId);
      if (!search) {
        throw new Error('Search not found');
      }

      // Enqueue job with manual type
      const messageId = await jobQueueService.enqueueJob({
        searchId: searchId,
        userId: userId,
        scheduleType: 'manual'
      });

      logger.info('Manual run triggered', { searchId, userId, messageId });

      return messageId;
    } catch (error) {
      logger.error('Failed to trigger manual run', {
        searchId,
        userId,
        error: error.message
      });
      throw error;
    }
  }
}

// Singleton instance
const schedulerService = new SchedulerService();

export default schedulerService;
