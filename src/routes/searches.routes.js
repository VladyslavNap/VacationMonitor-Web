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
   * Get all searches for current user (owned + shared)
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
      const userId = request.user.id;

      // Fetch owned searches and shares in parallel
      const [ownedResult, shares] = await Promise.all([
        cosmosDBService.getSearchesByUser(userId, {
          isActive: isActive,
          limit: limit || 20,
          continuationToken: continuationToken
        }),
        cosmosDBService.getSharesByUser(userId)
      ]);

      // Fetch shared searches
      const sharedSearches = await Promise.all(
        shares.map(async (share) => {
          try {
            const search = await cosmosDBService.getSearch(share.searchId, share.ownerId);
            if (search && (isActive === undefined || search.isActive === isActive)) {
              return {
                ...search,
                _isShared: true,
                _permission: share.permission,
                _sharedBy: share.ownerDisplayName || share.ownerEmail || 'Unknown',
                _sharedByEmail: share.ownerEmail
              };
            }
            return null;
          } catch (error) {
            logger.warn('Failed to fetch shared search', { searchId: share.searchId, error: error.message });
            return null;
          }
        })
      );

      // Combine and filter nulls
      const allSearches = [
        ...ownedResult.searches.map(s => ({ ...s, _isShared: false, _permission: 'owner' })),
        ...sharedSearches.filter(s => s !== null)
      ];

      // Sort by lastRunAt or createdAt descending
      allSearches.sort((a, b) => {
        const aTime = new Date(a.lastRunAt || a.createdAt || 0);
        const bTime = new Date(b.lastRunAt || b.createdAt || 0);
        return bTime - aTime;
      });

      // Apply limit
      const limitValue = limit || 20;
      const paginatedSearches = allSearches.slice(0, limitValue);

      // Fetch latest prices for each search
      const searchesWithPrices = await Promise.all(
        paginatedSearches.map(async (search) => ({
          ...search,
          latestPrices: await cosmosDBService.getLatestPrices(search.id)
        }))
      );

      return reply.send({
        searches: searchesWithPrices,
        continuationToken: null, // TODO: Implement proper pagination for combined results
        hasMore: allSearches.length > limitValue
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
      // Allow access for owner or shared users
      const search = await cosmosDBService.getSearchIfAccessible(id, request.user.id);

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
   * Includes owned and shared searches
   */
  fastify.get('/api/searches/summary/all-prices', {
    preHandler: authenticate
  }, async (request, reply) => {
    try {
      const userId = request.user.id;

      // Fetch owned searches and shares in parallel
      const [ownedResult, shares] = await Promise.all([
        cosmosDBService.getSearchesByUser(userId, {
          isActive: true,
          limit: 100
        }),
        cosmosDBService.getSharesByUser(userId)
      ]);

      // Fetch shared searches
      const sharedSearches = await Promise.all(
        shares.map(async (share) => {
          try {
            const search = await cosmosDBService.getSearch(share.searchId, share.ownerId);
            if (search && search.isActive) {
              return {
                ...search,
                _isShared: true,
                _sharedBy: share.ownerDisplayName || share.ownerEmail || 'Unknown',
                _sharedByEmail: share.ownerEmail
              };
            }
            return null;
          } catch (error) {
            logger.warn('Failed to fetch shared search for all-prices', { searchId: share.searchId, error: error.message });
            return null;
          }
        })
      );

      // Combine owned and shared searches
      const allSearches = [
        ...ownedResult.searches.map(s => ({ ...s, _isShared: false })),
        ...sharedSearches.filter(s => s !== null)
      ];

      if (allSearches.length === 0) {
        return reply.send({
          searches: [],
          totalSearches: 0,
          totalPrices: 0
        });
      }

      // Fetch latest prices for each search
      const searchesWithPrices = await Promise.all(
        allSearches.map(async (search) => {
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
              })),
              _isShared: search._isShared,
              _sharedBy: search._sharedBy || null,
              _sharedByEmail: search._sharedByEmail || null
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
              prices: [],
              _isShared: search._isShared,
              _sharedBy: search._sharedBy || null,
              _sharedByEmail: search._sharedByEmail || null
            };
          }
        })
      );

      // Calculate totals
      const totalPrices = searchesWithPrices.reduce((sum, s) => sum + s.priceCount, 0);

      logger.info('All-prices summary fetched', {
        userId,
        ownedSearchCount: ownedResult.searches.length,
        sharedSearchCount: sharedSearches.filter(s => s !== null).length,
        totalSearchCount: allSearches.length,
        totalPrices
      });

      return reply.send({
        searches: searchesWithPrices,
        totalSearches: allSearches.length,
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

  // ==================== SHARE MANAGEMENT ROUTES ====================

  /**
   * POST /api/searches/:id/shares
   * Share a search with another user
   */
  fastify.post('/api/searches/:id/shares', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'object',
        required: ['email'],
        properties: {
          email: { type: 'string', format: 'email' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { id } = request.params;
      const { email } = request.body;
      const userId = request.user.id;

      // Verify search exists and user owns it
      const search = await cosmosDBService.getSearch(id, userId);
      if (!search) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'Search not found'
        });
      }

      // Prevent sharing with self
      if (email.toLowerCase() === request.user.email.toLowerCase()) {
        return reply.code(400).send({
          error: 'Bad Request',
          message: 'You cannot share a search with yourself'
        });
      }

      // Look up recipient by email
      const recipient = await cosmosDBService.getUserByEmail(email);
      if (!recipient) {
        return reply.code(404).send({
          error: 'User Not Found',
          message: 'No user found with that email address'
        });
      }

      // Create share
      try {
        const share = await cosmosDBService.createShare(
          id,
          userId,
          recipient.id,
          recipient.email,
          {
            displayName: request.user.displayName,
            email: request.user.email
          }
        );

        logger.info('Search shared successfully', {
          searchId: id,
          ownerId: userId,
          sharedWithUserId: recipient.id
        });

        return reply.code(201).send({
          success: true,
          message: `Search shared with ${recipient.displayName || recipient.email}`,
          share: {
            id: share.id,
            searchId: share.searchId,
            sharedWithEmail: share.sharedWithEmail,
            sharedWithUserId: share.sharedWithUserId,
            permission: share.permission,
            sharedAt: share.sharedAt
          }
        });
      } catch (error) {
        if (error.message.includes('already shared')) {
          return reply.code(409).send({
            error: 'Already Shared',
            message: error.message
          });
        }
        throw error;
      }
    } catch (error) {
      logger.error('Failed to share search', {
        searchId: request.params.id,
        userId: request.user.id,
        error: error.message
      });
      throw error;
    }
  });

  /**
   * GET /api/searches/:id/shares
   * List all shares for a search (owner only)
   */
  fastify.get('/api/searches/:id/shares', {
    preHandler: authenticate
  }, async (request, reply) => {
    try {
      const { id } = request.params;
      const userId = request.user.id;

      // Verify search exists and user owns it
      const search = await cosmosDBService.getSearch(id, userId);
      if (!search) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'Search not found'
        });
      }

      // Get all shares for this search
      const shares = await cosmosDBService.getSharesBySearch(id);

      // Format response
      const formattedShares = shares.map(share => ({
        id: share.id,
        email: share.sharedWithEmail,
        userId: share.sharedWithUserId,
        permission: share.permission,
        sharedAt: share.sharedAt
      }));

      return reply.send({
        searchId: id,
        shares: formattedShares,
        count: formattedShares.length
      });
    } catch (error) {
      logger.error('Failed to get shares', {
        searchId: request.params.id,
        userId: request.user.id,
        error: error.message
      });
      throw error;
    }
  });

  /**
   * DELETE /api/searches/:id/shares/:shareId
   * Revoke a share (owner only)
   */
  fastify.delete('/api/searches/:id/shares/:shareId', {
    preHandler: authenticate
  }, async (request, reply) => {
    try {
      const { id, shareId } = request.params;
      const userId = request.user.id;

      // Verify search exists and user owns it
      const search = await cosmosDBService.getSearch(id, userId);
      if (!search) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'Search not found'
        });
      }

      // Delete the share
      await cosmosDBService.deleteShare(shareId, id);

      logger.info('Share revoked successfully', {
        searchId: id,
        shareId: shareId,
        userId: userId
      });

      return reply.send({
        success: true,
        message: 'Share access revoked successfully'
      });
    } catch (error) {
      logger.error('Failed to revoke share', {
        searchId: request.params.id,
        shareId: request.params.shareId,
        userId: request.user.id,
        error: error.message
      });
      throw error;
    }
  });
}
