import cosmosDBService from '../services/cosmos-db.service.js';
import { authenticate } from '../middleware/auth.middleware.js';
import { createRequire } from 'module';
import ExcelJS from 'exceljs';

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
  * Export price history as Excel
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

      // Create Excel workbook
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Price History');

      worksheet.columns = [
        { header: 'Hotel Name', key: 'hotelName', width: 30 },
        { header: 'Rating', key: 'rating', width: 10 },
        { header: 'Location', key: 'location', width: 20 },
        { header: 'City Name', key: 'cityName', width: 18 },
        { header: 'Original Price Text', key: 'originalPriceText', width: 18 },
        { header: 'Parsed Price', key: 'parsedPrice', width: 14 },
        { header: 'Numeric Price', key: 'numericPrice', width: 14 },
        { header: 'Currency', key: 'currency', width: 10 },
        { header: 'Hotel URL', key: 'hotelUrl', width: 45 },
        { header: 'Extracted At', key: 'extractedAt', width: 20 },
        { header: 'Search Destination', key: 'searchDestination', width: 22 },
        { header: 'Search Date', key: 'searchDate', width: 18 }
      ];

      worksheet.addRows(result.prices);

      worksheet.getRow(1).font = { bold: true };
      worksheet.getRow(1).alignment = { vertical: 'middle' };
      worksheet.views = [{ state: 'frozen', ySplit: 1 }];

      const buffer = await workbook.xlsx.writeBuffer();

      // Set headers for file download
      const filename = `booking-prices-${search.searchName.replace(/[^a-z0-9]/gi, '-')}-${new Date().toISOString().split('T')[0]}.xlsx`;

      reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      reply.header('Content-Disposition', `attachment; filename="${filename}"`);

      return reply.send(buffer);
    } catch (error) {
      logger.error('Failed to export prices', { 
        searchId: request.params.id, 
        userId: request.user.id, 
        error: error.message 
      });
      throw error;
    }
  });

  /**
   * GET /api/searches/export-all-latest-prices
   * Export latest prices from all active searches as Excel file
   */
  fastify.get('/api/searches/export-all-latest-prices', {
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
        return reply.code(404).send({
          error: 'No Data',
          message: 'No active searches found to export'
        });
      }

      // Fetch latest prices for each search
      const allPrices = [];
      for (const search of activeSearches) {
        try {
          const prices = await cosmosDBService.getLatestPrices(search.id);
          
          // Deduplicate prices by hotelName
          const seenHotels = new Set();
          for (const price of prices) {
            if (!seenHotels.has(price.hotelName)) {
              seenHotels.add(price.hotelName);
              allPrices.push({
                searchName: search.searchName,
                destination: search.criteria?.cityName || 'Unknown',
                hotelName: price.hotelName,
                rating: price.rating || '',
                lowestPrice: price.numericPrice || price.parsedPrice || '',
                currency: price.currency || '',
                hotelUrl: price.hotelUrl || '',
                checkIn: search.criteria?.checkIn || '',
                checkOut: search.criteria?.checkOut || '',
                extractedAt: price.extractedAt || ''
              });
            }
          }
        } catch (error) {
          logger.warn('Failed to fetch prices for search during bulk export', {
            searchId: search.id,
            error: error.message
          });
          // Continue with other searches
        }
      }

      if (allPrices.length === 0) {
        return reply.code(404).send({
          error: 'No Data',
          message: 'No price data available from active searches'
        });
      }

      // Create Excel workbook
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('All Prices');

      // Add header row
      worksheet.columns = [
        { header: 'Search Name', key: 'searchName', width: 20 },
        { header: 'Destination', key: 'destination', width: 18 },
        { header: 'Hotel Name', key: 'hotelName', width: 25 },
        { header: 'Rating', key: 'rating', width: 10 },
        { header: 'Lowest Price', key: 'lowestPrice', width: 15 },
        { header: 'Currency', key: 'currency', width: 12 },
        { header: 'Booking URL', key: 'hotelUrl', width: 40 },
        { header: 'Check-In', key: 'checkIn', width: 15 },
        { header: 'Check-Out', key: 'checkOut', width: 15 },
        { header: 'Last Updated', key: 'extractedAt', width: 20 }
      ];

      // Style header row
      worksheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FF366092' }
      };
      worksheet.getRow(1).font = {
        bold: true,
        color: { argb: 'FFFFFFFF' }
      };

      // Add data rows
      allPrices.forEach(price => {
        worksheet.addRow(price);
      });

      // Auto-fit columns
      worksheet.columns.forEach(column => {
        column.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
      });

      // Generate Excel file
      const buffer = await workbook.xlsx.writeBuffer();

      // Set headers for file download
      const filename = `vacation-prices-all-${new Date().toISOString().split('T')[0]}.xlsx`;
      
      reply.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      reply.header('Content-Disposition', `attachment; filename="${filename}"`);

      logger.info('All-prices Excel export generated', {
        userId,
        searchCount: activeSearches.length,
        priceCount: allPrices.length
      });

      return reply.send(buffer);
    } catch (error) {
      logger.error('Failed to export all prices to Excel', {
        userId: request.user.id,
        error: error.message
      });
      throw error;
    }
  });
}
