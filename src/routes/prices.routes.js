import cosmosDBService from '../services/cosmos-db.service.js';
import { authenticate } from '../middleware/auth.middleware.js';
import { createRequire } from 'module';
import { createObjectCsvStringifier } from 'csv-writer';

const require = createRequire(import.meta.url);
const logger = require('../logger.cjs');

/**
 * Apply hotel-type filters from search criteria to price results
 * 
 * Note: Ideally, hotel-type filtering should be applied by the Worker during scraping
 * to avoid fetching unnecessary data. This function provides client-side filtering
 * as a fallback or for compatibility.
 * 
 * Currently, price documents don't store hotel-type information, so this function
 * serves as a placeholder for future enhancement when price documents include
 * hotel property-type metadata from Booking.com.
 * 
 * @param {Array} prices - Array of price documents
 * @param {Object} hotelTypeFilters - Hotel-type filters from search.criteria.hotelTypeFilters
 * @returns {Array} Filtered prices (currently returns all prices as-is)
 */
function applyHotelTypeFilters(prices, hotelTypeFilters) {
  if (!hotelTypeFilters || Object.keys(hotelTypeFilters).length === 0) {
    return prices;
  }
  
  // TODO: Once price documents include hotel-type metadata (e.g., propertyType, amenities)
  // from Booking.com scraping, implement filtering logic here.
  // Example:
  // - If ht_beach=1, filter to only hotels with beachfront amenity
  // - If ht_city=1, filter to only hotels in city centers
  // - If ht_resort=1, filter to resort-type properties
  
  logger.debug('Hotel-type filters available but not applied at retrieval', {
    filters: Object.keys(hotelTypeFilters)
  });
  
  return prices;
}

/**
 * Price routes
 */
export default async function priceRoutes(fastify, options) {

  /**
   * GET /api/searches/:id/prices
   * Get price history for a search
   */
  fastify.get('/api/searches/:id/prices', {
    preHandler: authenticate,
    schema: {
      querystring: {
        type: 'object',
        properties: {
          startDate: { type: 'string', format: 'date-time' },
          endDate: { type: 'string', format: 'date-time' },
          hotelName: { type: 'string' },
          limit: { type: 'number', minimum: 1, maximum: 1000 },
          continuationToken: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { id } = request.params;
      const { startDate, endDate, hotelName, limit, continuationToken } = request.query;

      // Verify search exists and belongs to user
      const search = await cosmosDBService.getSearch(id, request.user.id);
      if (!search) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'Search not found'
        });
      }

      // Get prices
      const result = await cosmosDBService.getPricesBySearch(id, {
        startDate,
        endDate,
        hotelName,
        limit: limit || 100,
        continuationToken
      });

      // Apply hotel-type filters if present in search criteria
      const filteredPrices = applyHotelTypeFilters(result.prices, search.criteria?.hotelTypeFilters);

      return reply.send({
        searchId: id,
        prices: filteredPrices,
        continuationToken: result.continuationToken,
        hasMore: !!result.continuationToken
      });
    } catch (error) {
      logger.error('Failed to get prices', { 
        searchId: request.params.id, 
        userId: request.user.id, 
        error: error.message 
      });
      throw error;
    }
  });

  /**
   * GET /api/searches/:id/prices/latest
   * Get latest prices for a search
   */
  fastify.get('/api/searches/:id/prices/latest', {
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

      let prices = await cosmosDBService.getLatestPrices(id);
      
      // Apply hotel-type filters if present in search criteria
      prices = applyHotelTypeFilters(prices, search.criteria?.hotelTypeFilters);

      return reply.send({
        searchId: id,
        extractedAt: prices.length > 0 ? prices[0].extractedAt : null,
        count: prices.length,
        prices: prices
      });
    } catch (error) {
      logger.error('Failed to get latest prices', { 
        searchId: request.params.id, 
        userId: request.user.id, 
        error: error.message 
      });
      throw error;
    }
  });

  /**
   * GET /api/searches/:id/prices/outdated
   * Get outdated hotels (hotels not in latest extraction)
   */
  fastify.get('/api/searches/:id/prices/outdated', {
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

      let prices = await cosmosDBService.getOutdatedHotels(id);
      
      // Apply hotel-type filters if present in search criteria
      prices = applyHotelTypeFilters(prices, search.criteria?.hotelTypeFilters);

      return reply.send({
        searchId: id,
        count: prices.length,
        prices: prices
      });
    } catch (error) {
      logger.error('Failed to get outdated hotels', { 
        searchId: request.params.id, 
        userId: request.user.id, 
        error: error.message 
      });
      throw error;
    }
  });

  /**
   * GET /api/searches/:id/insights
   * Get latest AI insights for a search
   */
  fastify.get('/api/searches/:id/insights', {
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

      // Get conversation (which contains insights)
      const conversation = await cosmosDBService.getConversation(id);

      // Get latest assistant message (insights HTML)
      const insights = conversation.messages
        .filter(m => m.role === 'assistant')
        .pop();

      if (!insights) {
        return reply.send({
          searchId: id,
          hasInsights: false,
          message: 'No insights available yet. Run the search to generate insights.'
        });
      }

      return reply.send({
        searchId: id,
        hasInsights: true,
        content: insights.content,
        generatedAt: conversation.updatedAt
      });
    } catch (error) {
      logger.error('Failed to get insights', { 
        searchId: request.params.id, 
        userId: request.user.id, 
        error: error.message 
      });
      throw error;
    }
  });

  /**
   * GET /api/searches/:id/export
   * Export price history as CSV
   */
  fastify.get('/api/searches/:id/export', {
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

      // Get all prices for this search
      let result = await cosmosDBService.getPricesBySearch(id, {
        limit: 10000 // Max for export
      });

      // Apply hotel-type filters if present in search criteria
      result.prices = applyHotelTypeFilters(result.prices, search.criteria?.hotelTypeFilters);

      if (result.prices.length === 0) {
        return reply.code(404).send({
          error: 'No Data',
          message: 'No price data available for export'
        });
      }

      // Create CSV
      const csvStringifier = createObjectCsvStringifier({
        header: [
          { id: 'hotelName', title: 'Hotel Name' },
          { id: 'rating', title: 'Rating' },
          { id: 'location', title: 'Location' },
          { id: 'cityName', title: 'City Name' },
          { id: 'originalPriceText', title: 'Original Price Text' },
          { id: 'parsedPrice', title: 'Parsed Price' },
          { id: 'numericPrice', title: 'Numeric Price' },
          { id: 'currency', title: 'Currency' },
          { id: 'hotelUrl', title: 'Hotel URL' },
          { id: 'extractedAt', title: 'Extracted At' },
          { id: 'searchDestination', title: 'Search Destination' },
          { id: 'searchDate', title: 'Search Date' }
        ]
      });

      const csvHeader = csvStringifier.getHeaderString();
      const csvBody = csvStringifier.stringifyRecords(result.prices);
      const csv = csvHeader + csvBody;

      // Set headers for file download
      const filename = `booking-prices-${search.searchName.replace(/[^a-z0-9]/gi, '-')}-${new Date().toISOString().split('T')[0]}.csv`;
      
      reply.header('Content-Type', 'text/csv');
      reply.header('Content-Disposition', `attachment; filename="${filename}"`);
      
      return reply.send(csv);
    } catch (error) {
      logger.error('Failed to export prices', { 
        searchId: request.params.id, 
        userId: request.user.id, 
        error: error.message 
      });
      throw error;
    }
  });
}
