import googleOAuthService from '../auth/google-oauth.service.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const logger = require('../logger.cjs');

/**
 * Authentication routes
 */
export default async function authRoutes(fastify, options) {
  
  /**
   * GET /auth/google
   * Initiates Google OAuth flow
   */
  fastify.get('/auth/google', async (request, reply) => {
    return reply.redirect('/oauth2/google');
  });

  /**
   * GET /auth/google/callback
   * Handles OAuth callback from Google
   */
  fastify.get('/auth/google/callback', async (request, reply) => {
    try {
      // Get token from OAuth2 plugin
      const token = await fastify.oauth2Google.getAccessTokenFromAuthorizationCodeFlow(request);

      // Fetch user profile from Google
      const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: {
          Authorization: `Bearer ${token.access_token}`
        }
      });

      if (!response.ok) {
        throw new Error('Failed to fetch user profile from Google');
      }

      const googleProfile = await response.json();

      // Handle user creation/login
      const { user, sessionToken } = await googleOAuthService.handleCallback(googleProfile);

      // Set secure session
      request.session.set('user', sessionToken);

      // Redirect to frontend or return user data
      if (process.env.FRONTEND_URL) {
        return reply.redirect(`${process.env.FRONTEND_URL}/dashboard`);
      } else {
        return reply.send({
          success: true,
          user: user
        });
      }

    } catch (error) {
      logger.error('OAuth callback error', { error: error.message });
      return reply.code(500).send({
        error: 'Authentication Failed',
        message: 'Failed to complete Google authentication'
      });
    }
  });

  /**
   * POST /auth/logout
   * Logs out current user
   */
  fastify.post('/auth/logout', async (request, reply) => {
    request.session.delete();
    return reply.send({
      success: true,
      message: 'Logged out successfully'
    });
  });

  /**
   * GET /auth/status
   * Check authentication status
   */
  fastify.get('/auth/status', async (request, reply) => {
    const session = request.session.get('user');

    if (!session || !googleOAuthService.validateToken(session)) {
      return reply.send({
        authenticated: false
      });
    }

    const user = await googleOAuthService.getUserFromToken(session);

    if (!user) {
      request.session.delete();
      return reply.send({
        authenticated: false
      });
    }

    return reply.send({
      authenticated: true,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        photoURL: user.photoURL
      }
    });
  });
}
