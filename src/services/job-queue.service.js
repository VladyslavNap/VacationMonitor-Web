import { ServiceBusClient } from '@azure/service-bus';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const logger = require('../logger.cjs');

/**
 * Azure Service Bus integration for job queue management
 */
class JobQueueService {
  constructor() {
    this.client = null;
    this.sender = null;
    this.receiver = null;
    this.queueName = process.env.AZURE_SERVICE_BUS_QUEUE_NAME || 'price-monitor-jobs';
  }

  /**
   * Initialize Service Bus client
   */
  async initialize() {
    try {
      const connectionString = process.env.AZURE_SERVICE_BUS_CONNECTION_STRING;

      if (!connectionString) {
        throw new Error('Missing required environment variable: AZURE_SERVICE_BUS_CONNECTION_STRING');
      }

      this.client = new ServiceBusClient(connectionString);
      this.sender = this.client.createSender(this.queueName);

      logger.info('Service Bus client initialized successfully', { queueName: this.queueName });
    } catch (error) {
      logger.error('Failed to initialize Service Bus client', { error: error.message });
      throw error;
    }
  }

  /**
   * Enqueue a job to the queue
   * @param {Object} job - Job data { searchId, userId, scheduleType }
   */
  async enqueueJob(job) {
    try {
      if (!this.sender) {
        await this.initialize();
      }

      const message = {
        body: job,
        contentType: 'application/json',
        messageId: `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        sessionId: job.searchId // Group messages by searchId
      };

      await this.sender.sendMessages(message);

      logger.info('Job enqueued successfully', {
        messageId: message.messageId,
        searchId: job.searchId,
        userId: job.userId,
        scheduleType: job.scheduleType
      });

      return message.messageId;
    } catch (error) {
      logger.error('Failed to enqueue job', {
        searchId: job.searchId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Enqueue multiple jobs in batch
   * @param {Array} jobs - Array of job objects
   */
  async enqueueBatch(jobs) {
    try {
      if (!this.sender) {
        await this.initialize();
      }

      if (!jobs || jobs.length === 0) {
        return [];
      }

      const messages = jobs.map(job => ({
        body: job,
        contentType: 'application/json',
        messageId: `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        sessionId: job.searchId
      }));

      await this.sender.sendMessages(messages);

      logger.info('Batch jobs enqueued successfully', { count: messages.length });

      return messages.map(m => m.messageId);
    } catch (error) {
      logger.error('Failed to enqueue batch jobs', {
        count: jobs.length,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Create a receiver for processing messages
   * @param {Function} messageHandler - Function to process each message
   * @param {Function} errorHandler - Function to handle errors
   */
  async createReceiver(messageHandler, errorHandler) {
    try {
      if (!this.client) {
        await this.initialize();
      }

      this.receiver = this.client.createReceiver(this.queueName, {
        receiveMode: 'peekLock', // Messages are locked and must be completed/abandoned
        maxAutoLockRenewalDurationInMs: 5 * 60 * 1000 // Auto-renew lock for up to 5 minutes
      });

      // Subscribe to messages
      this.receiver.subscribe(
        {
          processMessage: async (message) => {
            try {
              logger.info('Processing message', {
                messageId: message.messageId,
                searchId: message.body.searchId
              });

              await messageHandler(message.body);

              // Complete the message (remove from queue)
              await this.receiver.completeMessage(message);

              logger.info('Message processed successfully', {
                messageId: message.messageId
              });
            } catch (error) {
              logger.error('Failed to process message', {
                messageId: message.messageId,
                error: error.message
              });

              // Abandon the message (return to queue for retry)
              await this.receiver.abandonMessage(message);
            }
          },
          processError: async (error) => {
            logger.error('Message processing error', {
              error: error.message,
              stack: error.stack
            });

            if (errorHandler) {
              await errorHandler(error);
            }
          }
        },
        {
          autoCompleteMessages: false // We'll complete messages manually
        }
      );

      logger.info('Service Bus receiver started', { queueName: this.queueName });

      return this.receiver;
    } catch (error) {
      logger.error('Failed to create receiver', { error: error.message });
      throw error;
    }
  }

  /**
   * Close connections
   */
  async close() {
    try {
      if (this.receiver) {
        await this.receiver.close();
      }
      if (this.sender) {
        await this.sender.close();
      }
      if (this.client) {
        await this.client.close();
      }

      logger.info('Service Bus connections closed');
    } catch (error) {
      logger.error('Failed to close Service Bus connections', { error: error.message });
    }
  }
}

// Singleton instance
const jobQueueService = new JobQueueService();

export default jobQueueService;
