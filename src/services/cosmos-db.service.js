import { CosmosClient } from '@azure/cosmos';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const logger = require('../logger.cjs');

/**
 * Cosmos DB Service for VacationMonitor
 * Manages all database operations for users, searches, prices, conversations, and jobs
 */
class CosmosDBService {
  constructor() {
    this.client = null;
    this.database = null;
    this.containers = {
      users: null,
      searches: null,
      prices: null,
      conversations: null,
      jobs: null
    };
  }

  /**
   * Initialize connection to Cosmos DB
   */
  async initialize() {
    try {
      const endpoint = process.env.COSMOS_ENDPOINT;
      const key = process.env.COSMOS_KEY;
      const databaseName = process.env.COSMOS_DATABASE_NAME;

      if (!endpoint || !key || !databaseName) {
        throw new Error('Missing required Cosmos DB environment variables (COSMOS_ENDPOINT, COSMOS_KEY, COSMOS_DATABASE_NAME)');
      }

      this.client = new CosmosClient({ endpoint, key });
      this.database = this.client.database(databaseName);

      // Initialize container references
      this.containers.users = this.database.container('users');
      this.containers.searches = this.database.container('searches');
      this.containers.prices = this.database.container('prices');
      this.containers.conversations = this.database.container('conversations');
      this.containers.jobs = this.database.container('jobs');

      logger.info('Cosmos DB service initialized successfully', { databaseName });
    } catch (error) {
      logger.error('Failed to initialize Cosmos DB service', { error: error.message });
      throw error;
    }
  }

  // ==================== USERS OPERATIONS ====================

  /**
   * Create or update a user
   * @param {Object} user - User object with id, email, displayName, googleId, etc.
   */
  async upsertUser(user) {
    try {
      const userDoc = {
        id: user.id,
        userId: user.id, // Partition key
        email: user.email,
        displayName: user.displayName,
        googleId: user.googleId,
        photoURL: user.photoURL || null,
        emailPreferences: user.emailPreferences || { enabled: true },
        createdAt: user.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      const { resource } = await this.containers.users.items.upsert(userDoc);
      logger.info('User upserted successfully', { userId: resource.id });
      return resource;
    } catch (error) {
      logger.error('Failed to upsert user', { userId: user.id, error: error.message });
      throw error;
    }
  }

  /**
   * Get user by ID
   * @param {string} userId
   */
  async getUser(userId) {
    try {
      const { resource } = await this.containers.users.item(userId, userId).read();
      return resource;
    } catch (error) {
      if (error.code === 404) {
        return null;
      }
      logger.error('Failed to get user', { userId, error: error.message });
      throw error;
    }
  }

  /**
   * Get user by Google ID
   * @param {string} googleId
   */
  async getUserByGoogleId(googleId) {
    try {
      const querySpec = {
        query: 'SELECT * FROM c WHERE c.googleId = @googleId',
        parameters: [{ name: '@googleId', value: googleId }]
      };
      const { resources } = await this.containers.users.items.query(querySpec).fetchAll();
      return resources.length > 0 ? resources[0] : null;
    } catch (error) {
      logger.error('Failed to get user by Google ID', { googleId, error: error.message });
      throw error;
    }
  }

  /**
   * Delete a user
   * @param {string} userId
   */
  async deleteUser(userId) {
    try {
      await this.containers.users.item(userId, userId).delete();
      logger.info('User deleted successfully', { userId });
    } catch (error) {
      logger.error('Failed to delete user', { userId, error: error.message });
      throw error;
    }
  }

  // ==================== SEARCHES OPERATIONS ====================

  /**
   * Create a new search
   * @param {Object} search - Search object with userId, searchUrl, criteria, schedule, etc.
   */
  async createSearch(search) {
    try {
      const searchDoc = {
        id: search.id,
        userId: search.userId, // Partition key
        searchName: search.searchName || search.criteria.cityName,
        searchUrl: search.searchUrl, // Original Booking.com URL
        criteria: search.criteria, // Parsed search criteria JSON
        schedule: search.schedule || {
          enabled: true,
          intervalHours: 6,
          nextRun: new Date().toISOString()
        },
        emailRecipients: search.emailRecipients || [],
        isActive: search.isActive !== undefined ? search.isActive : true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastRunAt: null
      };

      const { resource } = await this.containers.searches.items.create(searchDoc);
      logger.info('Search created successfully', { searchId: resource.id, userId: search.userId });
      return resource;
    } catch (error) {
      logger.error('Failed to create search', { userId: search.userId, error: error.message });
      throw error;
    }
  }

  /**
   * Get search by ID
   * @param {string} searchId
   * @param {string} userId - Partition key
   */
  async getSearch(searchId, userId) {
    try {
      const { resource } = await this.containers.searches.item(searchId, userId).read();
      return resource;
    } catch (error) {
      if (error.code === 404) {
        return null;
      }
      logger.error('Failed to get search', { searchId, userId, error: error.message });
      throw error;
    }
  }

  /**
   * Get all searches for a user
   * @param {string} userId
   * @param {Object} options - Filtering and pagination options
   */
  async getSearchesByUser(userId, options = {}) {
    try {
      const { isActive, limit = 100, continuationToken } = options;
      
      let query = 'SELECT * FROM c WHERE c.userId = @userId';
      const parameters = [{ name: '@userId', value: userId }];

      if (isActive !== undefined) {
        query += ' AND c.isActive = @isActive';
        parameters.push({ name: '@isActive', value: isActive });
      }

      query += ' ORDER BY c.createdAt DESC';

      const querySpec = { query, parameters };
      const queryIterator = this.containers.searches.items.query(querySpec, {
        maxItemCount: limit,
        continuationToken
      });

      const { resources, continuationToken: nextToken } = await queryIterator.fetchNext();
      return { searches: resources, continuationToken: nextToken };
    } catch (error) {
      logger.error('Failed to get searches for user', { userId, error: error.message });
      throw error;
    }
  }

  /**
   * Get searches that are due to run
   * @param {number} limit - Max number of searches to return
   */
  async getDueSearches(limit = 50) {
    try {
      const now = new Date().toISOString();
      const querySpec = {
        query: `SELECT * FROM c 
                WHERE c.isActive = true 
                AND c.schedule.enabled = true 
                AND c.schedule.nextRun <= @now
                ORDER BY c.schedule.nextRun ASC
                OFFSET 0 LIMIT @limit`,
        parameters: [
          { name: '@now', value: now },
          { name: '@limit', value: limit }
        ]
      };

      const { resources } = await this.containers.searches.items.query(querySpec).fetchAll();
      return resources;
    } catch (error) {
      logger.error('Failed to get due searches', { error: error.message });
      throw error;
    }
  }

  /**
   * Update search
   * @param {string} searchId
   * @param {string} userId - Partition key
   * @param {Object} updates - Fields to update
   */
  async updateSearch(searchId, userId, updates) {
    try {
      const existing = await this.getSearch(searchId, userId);
      if (!existing) {
        throw new Error('Search not found');
      }

      const updated = {
        ...existing,
        ...updates,
        updatedAt: new Date().toISOString()
      };

      const { resource } = await this.containers.searches.items.upsert(updated);
      logger.info('Search updated successfully', { searchId, userId });
      return resource;
    } catch (error) {
      logger.error('Failed to update search', { searchId, userId, error: error.message });
      throw error;
    }
  }

  /**
   * Delete search (soft delete - mark as inactive)
   * @param {string} searchId
   * @param {string} userId - Partition key
   */
  async deleteSearch(searchId, userId) {
    try {
      await this.updateSearch(searchId, userId, { isActive: false, 'schedule.enabled': false });
      logger.info('Search deleted successfully', { searchId, userId });
    } catch (error) {
      logger.error('Failed to delete search', { searchId, userId, error: error.message });
      throw error;
    }
  }

  // ==================== PRICES OPERATIONS ====================

  /**
   * Bulk create price records
   * @param {Array} prices - Array of price objects
   */
  async createPrices(prices) {
    try {
      if (!prices || prices.length === 0) {
        return [];
      }

      // Cosmos DB bulk operations are more efficient than individual inserts
      const operations = prices.map(price => ({
        operationType: 'Create',
        resourceBody: {
          id: price.id,
          searchId: price.searchId, // Partition key
          userId: price.userId,
          hotelName: price.hotelName,
          rating: price.rating,
          location: price.location,
          cityName: price.cityName,
          originalPriceText: price.originalPriceText,
          parsedPrice: price.parsedPrice,
          numericPrice: price.numericPrice,
          currency: price.currency,
          hotelUrl: price.hotelUrl,
          extractedAt: price.extractedAt,
          searchDestination: price.searchDestination,
          searchDate: price.searchDate
        }
      }));

      // Note: Cosmos DB Node.js SDK doesn't have built-in bulk operations yet
      // We'll use Promise.all for concurrent inserts (good performance for <100 items)
      const results = await Promise.all(
        prices.map(price => 
          this.containers.prices.items.create({
            id: price.id,
            searchId: price.searchId,
            userId: price.userId,
            hotelName: price.hotelName,
            rating: price.rating,
            location: price.location,
            cityName: price.cityName,
            originalPriceText: price.originalPriceText,
            parsedPrice: price.parsedPrice,
            numericPrice: price.numericPrice,
            currency: price.currency,
            hotelUrl: price.hotelUrl,
            extractedAt: price.extractedAt,
            searchDestination: price.searchDestination,
            searchDate: price.searchDate
          })
        )
      );

      logger.info('Prices created successfully', { count: results.length, searchId: prices[0].searchId });
      return results.map(r => r.resource);
    } catch (error) {
      logger.error('Failed to create prices', { count: prices.length, error: error.message });
      throw error;
    }
  }

  /**
   * Get prices for a search
   * @param {string} searchId
   * @param {Object} options - Filtering and pagination options
   */
  async getPricesBySearch(searchId, options = {}) {
    try {
      const { startDate, endDate, hotelName, limit = 1000, continuationToken } = options;

      let query = 'SELECT * FROM c WHERE c.searchId = @searchId';
      const parameters = [{ name: '@searchId', value: searchId }];

      if (startDate) {
        query += ' AND c.extractedAt >= @startDate';
        parameters.push({ name: '@startDate', value: startDate });
      }

      if (endDate) {
        query += ' AND c.extractedAt <= @endDate';
        parameters.push({ name: '@endDate', value: endDate });
      }

      if (hotelName) {
        query += ' AND CONTAINS(LOWER(c.hotelName), @hotelName)';
        parameters.push({ name: '@hotelName', value: hotelName.toLowerCase() });
      }

      query += ' ORDER BY c.extractedAt DESC';

      const querySpec = { query, parameters };
      const queryIterator = this.containers.prices.items.query(querySpec, {
        maxItemCount: limit,
        continuationToken
      });

      const { resources, continuationToken: nextToken } = await queryIterator.fetchNext();
      return { prices: resources, continuationToken: nextToken };
    } catch (error) {
      logger.error('Failed to get prices', { searchId, error: error.message });
      throw error;
    }
  }

  /**
   * Get latest prices for a search (most recent extraction)
   * @param {string} searchId
   */
  async getLatestPrices(searchId) {
    try {
      const querySpec = {
        query: `SELECT TOP 1 c.extractedAt as timestamp FROM c 
                WHERE c.searchId = @searchId 
                ORDER BY c.extractedAt DESC`,
        parameters: [{ name: '@searchId', value: searchId }]
      };

      const { resources } = await this.containers.prices.items.query(querySpec).fetchAll();
      
      if (resources.length === 0) {
        return [];
      }

      const latestTimestamp = resources[0].timestamp;

      const pricesQuery = {
        query: 'SELECT * FROM c WHERE c.searchId = @searchId AND c.extractedAt = @timestamp',
        parameters: [
          { name: '@searchId', value: searchId },
          { name: '@timestamp', value: latestTimestamp }
        ]
      };

      const { resources: prices } = await this.containers.prices.items.query(pricesQuery).fetchAll();
      return prices;
    } catch (error) {
      logger.error('Failed to get latest prices', { searchId, error: error.message });
      throw error;
    }
  }

  // ==================== CONVERSATIONS OPERATIONS ====================

  /**
   * Get conversation for a search
   * @param {string} searchId
   */
  async getConversation(searchId) {
    try {
      const { resource } = await this.containers.conversations.item(searchId, searchId).read();
      return resource;
    } catch (error) {
      if (error.code === 404) {
        // Return empty conversation if not exists
        return {
          id: searchId,
          searchId: searchId,
          messages: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
      }
      logger.error('Failed to get conversation', { searchId, error: error.message });
      throw error;
    }
  }

  /**
   * Update conversation (save messages)
   * @param {string} searchId
   * @param {Array} messages - Array of { role, content } objects
   */
  async updateConversation(searchId, messages) {
    try {
      const existing = await this.getConversation(searchId);
      
      const conversationDoc = {
        id: searchId,
        searchId: searchId, // Partition key
        messages: messages,
        createdAt: existing.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      const { resource } = await this.containers.conversations.items.upsert(conversationDoc);
      logger.info('Conversation updated successfully', { searchId, messageCount: messages.length });
      return resource;
    } catch (error) {
      logger.error('Failed to update conversation', { searchId, error: error.message });
      throw error;
    }
  }

  // ==================== JOBS OPERATIONS ====================

  /**
   * Create a job record
   * @param {Object} job - Job object with searchId, userId, status, etc.
   */
  async createJob(job) {
    try {
      const jobDoc = {
        id: job.id,
        status: job.status || 'pending', // Partition key: pending, running, completed, failed
        searchId: job.searchId,
        userId: job.userId,
        scheduleType: job.scheduleType || 'scheduled', // scheduled | manual
        createdAt: new Date().toISOString(),
        startedAt: null,
        completedAt: null,
        error: null,
        result: null
      };

      const { resource } = await this.containers.jobs.items.create(jobDoc);
      logger.info('Job created successfully', { jobId: resource.id, searchId: job.searchId });
      return resource;
    } catch (error) {
      logger.error('Failed to create job', { searchId: job.searchId, error: error.message });
      throw error;
    }
  }

  /**
   * Update job status
   * @param {string} jobId
   * @param {string} oldStatus - Current status (partition key)
   * @param {Object} updates - Fields to update
   */
  async updateJob(jobId, oldStatus, updates) {
    try {
      const existing = await this.containers.jobs.item(jobId, oldStatus).read();
      
      if (!existing.resource) {
        throw new Error('Job not found');
      }

      const updated = {
        ...existing.resource,
        ...updates,
        updatedAt: new Date().toISOString()
      };

      // If status changed, we need to delete old and create new (partition key changed)
      if (updates.status && updates.status !== oldStatus) {
        await this.containers.jobs.item(jobId, oldStatus).delete();
        const { resource } = await this.containers.jobs.items.create(updated);
        logger.info('Job status updated', { jobId, oldStatus, newStatus: updates.status });
        return resource;
      } else {
        const { resource } = await this.containers.jobs.items.upsert(updated);
        logger.info('Job updated successfully', { jobId });
        return resource;
      }
    } catch (error) {
      logger.error('Failed to update job', { jobId, error: error.message });
      throw error;
    }
  }

  /**
   * Get job by ID
   * @param {string} jobId
   * @param {string} status - Partition key
   */
  async getJob(jobId, status) {
    try {
      const { resource } = await this.containers.jobs.item(jobId, status).read();
      return resource;
    } catch (error) {
      if (error.code === 404) {
        return null;
      }
      logger.error('Failed to get job', { jobId, status, error: error.message });
      throw error;
    }
  }
}

// Singleton instance
const cosmosDBService = new CosmosDBService();

export default cosmosDBService;
