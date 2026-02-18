import cosmosDBService from './cosmos-db.service.js';
import jobQueueService from './job-queue.service.js';
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
    this.pollIntervalMs = 5 * 60 * 1000; // 5 minutes
  }

  /**
   * Start the scheduler
   */
  async start() {
    if (this.isRunning) {
      logger.warn('Scheduler is already running');
      return;
    }

    logger.info('Starting job scheduler...');

    try {
      // Initialize services
      await cosmosDBService.initialize();
      await jobQueueService.initialize();

      this.isRunning = true;

      // Run immediately on start
      await this.tick();

      // Then run on interval
      this.intervalId = setInterval(() => {
        this.tick().catch(error => {
          logger.error('Scheduler tick failed', { error: error.message });
        });
      }, this.pollIntervalMs);

      logger.info('Job scheduler started', { pollIntervalMinutes: this.pollIntervalMs / 60000 });
    } catch (error) {
      logger.error('Failed to start scheduler', { error: error.message });
      throw error;
    }
  }

  /**
   * Stop the scheduler
   */
  async stop() {
    if (!this.isRunning) {
      return;
    }

    logger.info('Stopping job scheduler...');

    this.isRunning = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    await jobQueueService.close();

    logger.info('Job scheduler stopped');
  }

  /**
   * Execute one scheduler tick
   * Finds due searches and enqueues them
   */
  async tick() {
    try {
      logger.info('Scheduler tick: checking for due searches...');

      // Get searches that are due to run
      const dueSearches = await cosmosDBService.getDueSearches(50);

      if (dueSearches.length === 0) {
        logger.info('No due searches found');
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
        updated: updatePromises.length
      });
    } catch (error) {
      logger.error('Scheduler tick error', { error: error.message, stack: error.stack });
      // Don't throw - allow scheduler to continue on next tick
    }
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
