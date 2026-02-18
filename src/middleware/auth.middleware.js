import googleOAuthService from '../auth/google-oauth.service.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const logger = require('../logger.cjs');

/**
 * Authentication middleware
 * Validates session and attaches user to request
 */
export async function authenticate(request, reply) {
  try {
    // Get session from secure session
    const session = request.session.get('user');

    if (!session) {
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'No active session. Please login.'
      });
    }

    // Validate token
    if (!googleOAuthService.validateToken(session)) {
      request.session.delete();
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'Session expired. Please login again.'
      });
    }

    // Get user from database
    const user = await googleOAuthService.getUserFromToken(session);

    if (!user) {
      request.session.delete();
      return reply.code(401).send({
        error: 'Unauthorized',
        message: 'User not found. Please login again.'
      });
    }

    // Attach user to request
    request.user = {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      photoURL: user.photoURL
    };

    // Add user context to logger (use request.logger to avoid overwriting Fastify's request.log)
    request.logger = logger.child({ userId: user.id, email: user.email });

  } catch (error) {
    logger.error('Authentication error', { error: error.message });
    return reply.code(500).send({
      error: 'Internal Server Error',
      message: 'Authentication failed'
    });
  }
}

/**
 * Optional authentication middleware
 * Attaches user if session exists, but doesn't require it
 */
export async function optionalAuth(request, reply) {
  try {
    const session = request.session.get('user');

    if (session && googleOAuthService.validateToken(session)) {
      const user = await googleOAuthService.getUserFromToken(session);
      if (user) {
        request.user = {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          photoURL: user.photoURL
        };
        request.logger = logger.child({ userId: user.id, email: user.email });
      }
    }
  } catch (error) {
    // Silently fail for optional auth
    logger.warn('Optional auth failed', { error: error.message });
  }
}
