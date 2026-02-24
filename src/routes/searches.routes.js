import { nanoid } from 'nanoid';
import cosmosDBService from '../services/cosmos-db.service.js';
import { authenticate } from '../middleware/auth.middleware.js';
import BookingURLParser from '../parsers/booking-url-parser.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const logger = require('../logger.cjs');

const urlParser = new BookingURLParser();

/**
 * Search routes
 */
export default async function searchRoutes(fastify, options) {

  /**
   * POST /api/searches
   * Create a new search from URL or manual criteria
   */
  fastify.post('/api/searches', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'object',
        properties: {
          searchUrl: { type: 'string' },
          searchName: { type: 'string' },
          criteria: { type: 'object' },
          emailRecipients: {
            type: 'array',
            items: { type: 'string', format: 'email' }
          },
          schedule: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean' },
              intervalHours: { type: 'number', minimum: 1, maximum: 168 }
            }
          }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { searchUrl, searchName, criteria, emailRecipients, schedule } = request.body;
      let parsedCriteria = criteria;

      // If URL provided, parse it
      if (searchUrl) {
        const normalizedSearchUrl = searchUrl.trim();
        const parseResult = urlParser.parse(normalizedSearchUrl);
        if (!parseResult.success) {
          return reply.code(400).send({
            error: 'Invalid URL',
            message: parseResult.error
          });
        }
        parsedCriteria = {
          ...parseResult.criteria,
          sourceUrl: normalizedSearchUrl
        };
      }

      // Validate criteria
      if (!parsedCriteria) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'Either searchUrl or criteria must be provided'
        });
      }

      const validation = urlParser.validate(parsedCriteria);
      if (!validation.valid) {
        return reply.code(400).send({
          error: 'Invalid Criteria',
          message: 'Search criteria validation failed',
          details: validation.errors
        });
      }

      // Use user's email as default recipient if none provided
      const recipients = emailRecipients && emailRecipients.length > 0 
        ? emailRecipients 
        : [request.user.email];

      // Ensure schedule always has nextRun in UTC time
      const scheduleObject = {
        enabled: true,
        intervalHours: 6,
        nextRun: new Date().toISOString(),
        ...schedule
      };

      // Create search
      const searchId = `search_${nanoid(16)}`;
      const search = await cosmosDBService.createSearch({
        id: searchId,
        userId: request.user.id,
        searchName: searchName || parsedCriteria.cityName || 'My Search',
        searchUrl: parsedCriteria.sourceUrl || urlParser.buildUrl(parsedCriteria),
        criteria: parsedCriteria,
        emailRecipients: recipients,
        schedule: scheduleObject,
        isActive: true
      });

      logger.info('Search created', { 
        searchId: search.id, 
        userId: request.user.id,
        destination: parsedCriteria.cityName
      });

      return reply.code(201).send(search);
    } catch (error) {
      logger.error('Failed to create search', { userId: request.user.id, error: error.message });
      throw error;
    }
  });

  /**
   * GET /api/searches
   * Get all searches for current user
   */
  fastify.get('/api/searches', {
    preHandler: authenticate,
    schema: {
      querystring: {
        type: 'object',
        properties: {
          isActive: { type: 'boolean' },
          limit: { type: 'number', minimum: 1, maximum: 100 },
          continuationToken: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { isActive, limit, continuationToken } = request.query;

      const result = await cosmosDBService.getSearchesByUser(request.user.id, {
        isActive: isActive,
        limit: limit || 20,
        continuationToken: continuationToken
      });

      return reply.send({
        searches: result.searches,
        continuationToken: result.continuationToken,
        hasMore: !!result.continuationToken
      });
    } catch (error) {
      logger.error('Failed to get searches', { userId: request.user.id, error: error.message });
      throw error;
    }
  });

  /**
   * GET /api/searches/:id
   * Get a specific search by ID
   */
  fastify.get('/api/searches/:id', {
    preHandler: authenticate
  }, async (request, reply) => {
    try {
      const { id } = request.params;
      const search = await cosmosDBService.getSearch(id, request.user.id);

      if (!search) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'Search not found'
        });
      }

      // Get latest prices for this search
      const latestPrices = await cosmosDBService.getLatestPrices(id);

      return reply.send({
        ...search,
        latestPrices: latestPrices,
        summary: urlParser.getSummary(search.criteria)
      });
    } catch (error) {
      logger.error('Failed to get search', { 
        searchId: request.params.id, 
        userId: request.user.id, 
        error: error.message 
      });
      throw error;
    }
  });

  /**
   * PATCH /api/searches/:id
   * Update a search
   */
  fastify.patch('/api/searches/:id', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'object',
        properties: {
          searchName: { type: 'string' },
          emailRecipients: {
            type: 'array',
            items: { type: 'string', format: 'email' }
          },
          schedule: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean' },
              intervalHours: { type: 'number', minimum: 1, maximum: 168 }
            }
          },
          isActive: { type: 'boolean' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { id } = request.params;
      const updates = request.body;

      // Verify search exists and belongs to user
      const existing = await cosmosDBService.getSearch(id, request.user.id);
      if (!existing) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'Search not found'
        });
      }

      // Apply updates
      const updatedSearch = await cosmosDBService.updateSearch(id, request.user.id, updates);

      logger.info('Search updated', { 
        searchId: id, 
        userId: request.user.id 
      });

      return reply.send(updatedSearch);
    } catch (error) {
      logger.error('Failed to update search', { 
        searchId: request.params.id, 
        userId: request.user.id, 
        error: error.message 
      });
      throw error;
    }
  });

  /**
   * DELETE /api/searches/:id
   * Delete (soft delete) a search
   */
  fastify.delete('/api/searches/:id', {
    preHandler: authenticate
  }, async (request, reply) => {
    try {
      const { id } = request.params;

      // Verify search exists and belongs to user
      const existing = await cosmosDBService.getSearch(id, request.user.id);
      if (!existing) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'Search not found'
        });
      }

      await cosmosDBService.deleteSearch(id, request.user.id);

      logger.info('Search deleted', { 
        searchId: id, 
        userId: request.user.id 
      });

      return reply.send({
        success: true,
        message: 'Search deleted successfully'
      });
    } catch (error) {
      logger.error('Failed to delete search', { 
        searchId: request.params.id, 
        userId: request.user.id, 
        error: error.message 
      });
      throw error;
    }
  });

  /**
   * POST /api/searches/:id/run
   * Manually trigger a search to run immediately
   */
  fastify.post('/api/searches/:id/run', {
    preHandler: authenticate
  }, async (request, reply) => {
    try {
      const { id } = request.params;

      // Verify search exists and belongs to user
      const search = await cosmosDBService.getSearch(id, request.user.id);
      if (!search) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'Search not found'
        });
      }

      // Trigger manual run by enqueuing job directly
      const jobQueueService = (await import('../services/job-queue.service.js')).default;
      const messageId = await jobQueueService.enqueueJob({
        searchId: id,
        userId: request.user.id,
        scheduleType: 'manual'
      });

      logger.info('Manual search run triggered', { 
        searchId: id, 
        userId: request.user.id,
        messageId 
      });

      return reply.code(202).send({
        success: true,
        message: 'Search run queued. You will receive an email with results shortly.',
        searchId: id,
        jobId: messageId
      });
    } catch (error) {
      logger.error('Failed to trigger manual run', { 
        searchId: request.params.id, 
        userId: request.user.id, 
        error: error.message 
      });
      throw error;
    }
  });

  /**
   * GET /api/searches/summary/all-prices
   * Get latest prices for all active searches (for the all-prices page)
   */
  fastify.get('/api/searches/summary/all-prices', {
    preHandler: authenticate
  }, async (request, reply) => {
    try {
      const userId = request.user.id;

      // Get all active searches for user
      const { searches: activeSearches } = await cosmosDBService.getSearchesByUser(userId, {
        isActive: true,
        limit: 100
      });

      if (activeSearches.length === 0) {
        return reply.send({
          searches: [],
          totalSearches: 0,
          totalPrices: 0
        });
      }

      // Fetch latest prices for each search
      const searchesWithPrices = await Promise.all(
        activeSearches.map(async (search) => {
          try {
            const prices = await cosmosDBService.getLatestPrices(search.id);
            const latestExtractedAt = prices.length > 0 ? prices[0].extractedAt : null;

            // Deduplicate prices by hotelName (keep first occurrence)
            const dedupedPrices = [];
            const seenHotels = new Set();
            for (const price of prices) {
              if (!seenHotels.has(price.hotelName)) {
                seenHotels.add(price.hotelName);
                dedupedPrices.push(price);
              }
            }

            return {
              id: search.id,
              searchName: search.searchName,
              destination: search.criteria?.cityName || 'Unknown',
              checkIn: search.criteria?.checkIn || null,
              checkOut: search.criteria?.checkOut || null,
              reviewScore: search.criteria?.reviewScore || null,
              lastRunAt: search.lastRunAt,
              extractedAt: latestExtractedAt,
              priceCount: dedupedPrices.length,
              prices: dedupedPrices.map(p => ({
                ...p,
                hotelUrl: p.hotelUrl || null
              }))
            };
          } catch (error) {
            logger.warn('Failed to fetch prices for search', {
              searchId: search.id,
              error: error.message
            });
            // Return search with empty prices on error
            return {
              id: search.id,
              searchName: search.searchName,
              destination: search.criteria?.cityName || 'Unknown',
              checkIn: search.criteria?.checkIn || null,
              checkOut: search.criteria?.checkOut || null,
              reviewScore: search.criteria?.reviewScore || null,
              lastRunAt: search.lastRunAt,
              extractedAt: null,
              priceCount: 0,
              prices: []
            };
          }
        })
      );

      // Calculate totals
      const totalPrices = searchesWithPrices.reduce((sum, s) => sum + s.priceCount, 0);

      logger.info('All-prices summary fetched', {
        userId,
        activeSearchCount: activeSearches.length,
        totalPrices
      });

      return reply.send({
        searches: searchesWithPrices,
        totalSearches: activeSearches.length,
        totalPrices
      });
    } catch (error) {
      logger.error('Failed to get all-prices summary', {
        userId: request.user.id,
        error: error.message
      });
      throw error;
    }
  });
}
