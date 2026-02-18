import { nanoid } from 'nanoid';
import cosmosDBService from '../services/cosmos-db.service.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const logger = require('../logger.cjs');

/**
 * Google OAuth Authentication Service
 * Handles user authentication flow and session management
 */
class GoogleOAuthService {
  /**
   * Handle successful OAuth callback
   * Creates or updates user in database
   * @param {Object} googleProfile - User profile from Google
   * @returns {Object} User object and session token
   */
  async handleCallback(googleProfile) {
    try {
      const { sub: googleId, email, name, picture } = googleProfile;

      // Check if user exists by Google ID
      let user = await cosmosDBService.getUserByGoogleId(googleId);

      if (user) {
        // Update existing user
        user = await cosmosDBService.upsertUser({
          id: user.id,
          email: email,
          displayName: name,
          googleId: googleId,
          photoURL: picture,
          emailPreferences: user.emailPreferences
        });
        logger.info('User logged in', { userId: user.id, email });
      } else {
        // Create new user
        const userId = `user_${nanoid(16)}`;
        user = await cosmosDBService.upsertUser({
          id: userId,
          email: email,
          displayName: name,
          googleId: googleId,
          photoURL: picture,
          emailPreferences: { enabled: true }
        });
        logger.info('New user created', { userId: user.id, email });
      }

      // Generate session token
      const sessionToken = this.generateSessionToken(user);

      return {
        user: {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          photoURL: user.photoURL
        },
        sessionToken
      };
    } catch (error) {
      logger.error('Failed to handle OAuth callback', { error: error.message });
      throw error;
    }
  }

  /**
   * Generate session token for user
   * @param {Object} user - User object
   * @returns {Object} Session token data
   */
  generateSessionToken(user) {
    return {
      userId: user.id,
      email: user.email,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days
    };
  }

  /**
   * Validate session token
   * @param {Object} token - Session token
   * @returns {boolean} Whether token is valid
   */
  validateToken(token) {
    if (!token || !token.userId || !token.expiresAt) {
      return false;
    }

    const expiresAt = new Date(token.expiresAt);
    const now = new Date();

    return expiresAt > now;
  }

  /**
   * Get user from session token
   * @param {Object} token - Session token
   * @returns {Object} User object or null
   */
  async getUserFromToken(token) {
    if (!this.validateToken(token)) {
      return null;
    }

    try {
      const user = await cosmosDBService.getUser(token.userId);
      return user;
    } catch (error) {
      logger.error('Failed to get user from token', { userId: token.userId, error: error.message });
      return null;
    }
  }
}

export default new GoogleOAuthService();
