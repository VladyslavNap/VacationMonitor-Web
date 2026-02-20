import { createRequire } from 'module';
import cosmosDBService from './cosmos-db.service.js';

const require = createRequire(import.meta.url);
const logger = require('../logger.cjs');

/**
 * Distributed Lock Service for multi-instance coordination
 * 
 * Uses Cosmos DB to store a lock document. Only the instance that holds
 * the lease can run the scheduler. Other instances wait or skip.
 * 
 * Lock document structure:
 * {
 *   id: "scheduler-lock",
 *   partitionKey: "scheduler",
 *   leasedBy: "instance-id",
 *   leaseExpiresAt: "2026-02-20T10:15:00.000Z",
 *   lastRenewed: "2026-02-20T10:10:00.000Z"
 * }
 */
class DistributedLockService {
  constructor() {
    this.lockId = 'scheduler-lock';
    this.lockPartition = 'scheduler';
    this.instanceId = `instance-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    this.lockDurationSeconds = 360; // 6 minutes - longer than poll interval (5 min)
    this.container = null;
    this.lockHeld = false;
  }

  /**
   * Initialize the lock service (creates container if needed)
   */
  async initialize() {
    try {
      // We'll use the 'jobs' container to store the lock document
      // This avoids creating a new container and keeps it simple
      logger.info('Distributed lock service initialized', {
        instanceId: this.instanceId,
        lockDurationSeconds: this.lockDurationSeconds
      });
    } catch (error) {
      logger.error('Failed to initialize distributed lock service', { error: error.message });
      throw error;
    }
  }

  /**
   * Attempt to acquire the lock
   * Returns true if lock was acquired, false if already held by another instance
   */
  async acquireLock() {
    try {
      const container = cosmosDBService.getJobsContainer();
      if (!container) {
        logger.warn('Cosmos DB not initialized, skipping lock acquisition');
        return true; // Allow scheduler to run if DB unavailable
      }

      const now = new Date();
      const expiresAt = new Date(now.getTime() + this.lockDurationSeconds * 1000);

      // Try to read existing lock
      let lockDoc;
      try {
        const response = await container.item(this.lockId, this.lockPartition).read();
        lockDoc = response.resource;
      } catch (error) {
        if (error.code === 404) {
          // Lock doesn't exist, create it
          lockDoc = null;
        } else {
          throw error;
        }
      }

      // If lock exists and is still valid, check if it's ours
      if (lockDoc) {
        const lockExpiry = new Date(lockDoc.leaseExpiresAt);
        
        if (lockExpiry > now) {
          // Lock is still valid
          if (lockDoc.leasedBy === this.instanceId) {
            // We already have the lock
            logger.debug('Lock already held by this instance', { instanceId: this.instanceId });
            this.lockHeld = true;
            return true;
          } else {
            // Another instance has the lock
            logger.debug('Lock held by another instance', { 
              currentLeaseholder: lockDoc.leasedBy,
              thisInstance: this.instanceId
            });
            this.lockHeld = false;
            return false;
          }
        }
      }

      // Lock is expired or doesn't exist - try to acquire
      const newLockDoc = {
        id: this.lockId,
        partitionKey: this.lockPartition,
        leasedBy: this.instanceId,
        leaseExpiresAt: expiresAt.toISOString(),
        lastRenewed: now.toISOString(),
        createdAt: lockDoc?.createdAt || now.toISOString()
      };

      try {
        // Try to create or update with conditional check
        await container.items.upsert(newLockDoc);
        
        logger.info('✅ Scheduler lock acquired', {
          instanceId: this.instanceId,
          expiresAt: expiresAt.toISOString()
        });
        
        this.lockHeld = true;
        return true;
      } catch (error) {
        logger.warn('Failed to acquire lock', { error: error.message, instanceId: this.instanceId });
        this.lockHeld = false;
        return false;
      }
    } catch (error) {
      logger.error('Error acquiring lock', { error: error.message });
      // Don't throw - allow scheduler to run if lock service fails
      return true;
    }
  }

  /**
   * Renew the lock if we hold it
   * Call this periodically to prevent expiry
   */
  async renewLock() {
    if (!this.lockHeld) {
      return;
    }

    try {
      const container = cosmosDBService.getJobsContainer();
      if (!container) {
        logger.warn('Cosmos DB not available, cannot renew lock');
        this.lockHeld = false;
        return;
      }

      const now = new Date();
      const expiresAt = new Date(now.getTime() + this.lockDurationSeconds * 1000);

      let lockDoc;
      try {
        const response = await container.item(this.lockId, this.lockPartition).read();
        lockDoc = response.resource;
      } catch (error) {
        if (error.code === 404) {
          logger.warn('Scheduler lock document not found, reacquiring...');
          this.lockHeld = false;
          return;
        }
        throw error;
      }

      // Only renew if we still hold it
      if (lockDoc.leasedBy === this.instanceId) {
        lockDoc.leaseExpiresAt = expiresAt.toISOString();
        lockDoc.lastRenewed = now.toISOString();

        await container.items.upsert(lockDoc);

        logger.debug('✅ Scheduler lock renewed', {
          instanceId: this.instanceId,
          expiresAt: expiresAt.toISOString()
        });
      } else {
        // Lock was taken by another instance
        logger.warn('Lost scheduler lock to another instance', {
          previousHolder: this.instanceId,
          newHolder: lockDoc.leasedBy
        });
        this.lockHeld = false;
      }
    } catch (error) {
      logger.warn('Failed to renew lock', { error: error.message });
      this.lockHeld = false;
    }
  }

  /**
   * Release the lock when done
   */
  async releaseLock() {
    if (!this.lockHeld) {
      return;
    }

    try {
      const container = cosmosDBService.getJobsContainer();
      if (!container) {
        logger.warn('Cosmos DB not available, cannot release lock');
        return;
      }

      const response = await container.item(this.lockId, this.lockPartition).read();
      const lockDoc = response.resource;

      if (lockDoc.leasedBy === this.instanceId) {
        // Delete the lock document to release it
        await container.item(this.lockId, this.lockPartition).delete();

        logger.info('✅ Scheduler lock released', { instanceId: this.instanceId });
        this.lockHeld = false;
      }
    } catch (error) {
      logger.warn('Failed to release lock', { error: error.message });
    }
  }

  /**
   * Check if this instance currently holds the lock
   */
  isLockHeld() {
    return this.lockHeld;
  }

  /**
   * Get lock status for monitoring
   */
  async getLockStatus() {
    try {
      const container = cosmosDBService.getJobsContainer();
      if (!container) {
        return { status: 'disabled', reason: 'Cosmos DB not available' };
      }

      const response = await container.item(this.lockId, this.lockPartition).read();
      const lockDoc = response.resource;
      const now = new Date();
      const expiryTime = new Date(lockDoc.leaseExpiresAt);

      return {
        status: 'active',
        leasedBy: lockDoc.leasedBy,
        isOurLock: lockDoc.leasedBy === this.instanceId,
        leaseExpiresAt: lockDoc.leaseExpiresAt,
        secondsUntilExpiry: Math.round((expiryTime - now) / 1000),
        lastRenewed: lockDoc.lastRenewed
      };
    } catch (error) {
      if (error.code === 404) {
        return { status: 'available', reason: 'No active lock' };
      }
      return { status: 'unknown', error: error.message };
    }
  }
}

// Singleton instance
const distributedLockService = new DistributedLockService();

export default distributedLockService;
