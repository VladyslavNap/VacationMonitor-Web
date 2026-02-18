import cosmosDBService from '../services/cosmos-db.service.js';
import { authenticate } from '../middleware/auth.middleware.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const logger = require('../logger.cjs');

/**
 * User routes
 */
export default async function userRoutes(fastify, options) {

  /**
   * GET /api/users/me
   * Get current user profile
   */
  fastify.get('/api/users/me', {
    preHandler: authenticate
  }, async (request, reply) => {
    try {
      const user = await cosmosDBService.getUser(request.user.id);

      if (!user) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'User not found'
        });
      }

      return reply.send({
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        photoURL: user.photoURL,
        emailPreferences: user.emailPreferences,
        createdAt: user.createdAt
      });
    } catch (error) {
      logger.error('Failed to get user profile', { userId: request.user.id, error: error.message });
      throw error;
    }
  });

  /**
   * PATCH /api/users/me
   * Update current user profile
   */
  fastify.patch('/api/users/me', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'object',
        properties: {
          emailPreferences: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean' }
            }
          }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { emailPreferences } = request.body;
      const user = await cosmosDBService.getUser(request.user.id);

      if (!user) {
        return reply.code(404).send({
          error: 'Not Found',
          message: 'User not found'
        });
      }

      // Update user
      const updated = await cosmosDBService.upsertUser({
        ...user,
        emailPreferences: emailPreferences || user.emailPreferences
      });

      logger.info('User profile updated', { userId: user.id });

      return reply.send({
        id: updated.id,
        email: updated.email,
        displayName: updated.displayName,
        photoURL: updated.photoURL,
        emailPreferences: updated.emailPreferences,
        updatedAt: updated.updatedAt
      });
    } catch (error) {
      logger.error('Failed to update user profile', { userId: request.user.id, error: error.message });
      throw error;
    }
  });

  /**
   * DELETE /api/users/me
   * Delete current user account (and all associated data)
   */
  fastify.delete('/api/users/me', {
    preHandler: authenticate
  }, async (request, reply) => {
    try {
      const userId = request.user.id;

      // TODO: Implement cascade delete for searches, prices, conversations
      // For now, just delete the user
      await cosmosDBService.deleteUser(userId);

      // Clear session
      request.session.delete();

      logger.info('User account deleted', { userId });

      return reply.send({
        success: true,
        message: 'Account deleted successfully'
      });
    } catch (error) {
      logger.error('Failed to delete user account', { userId: request.user.id, error: error.message });
      throw error;
    }
  });
}
