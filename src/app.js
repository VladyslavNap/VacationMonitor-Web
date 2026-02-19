import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import secureSession from '@fastify/secure-session';
import oauth2 from '@fastify/oauth2';
import fastifyStatic from '@fastify/static';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

// Import services
import cosmosDBService from './services/cosmos-db.service.js';

// Import middleware
import { errorHandler, notFoundHandler } from './middleware/error-handler.middleware.js';

// Import routes
import authRoutes from './routes/auth.routes.js';
import userRoutes from './routes/users.routes.js';
import searchRoutes from './routes/searches.routes.js';
import priceRoutes from './routes/prices.routes.js';

const require = createRequire(import.meta.url);
const logger = require('./logger.cjs');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const homePageTemplate      = readFileSync(join(__dirname, 'views', 'home.html'), 'utf8');
const dashboardTemplate     = readFileSync(join(__dirname, 'views', 'dashboard.html'), 'utf8');
const searchTemplate        = readFileSync(join(__dirname, 'views', 'search.html'), 'utf8');
const newSearchTemplate     = readFileSync(join(__dirname, 'views', 'new-search.html'), 'utf8');
const settingsTemplate      = readFileSync(join(__dirname, 'views', 'settings.html'), 'utf8');
const privacyPolicyTemplate = readFileSync(join(__dirname, 'views', 'privacy-policy.html'), 'utf8');
const termsOfServiceTemplate = readFileSync(join(__dirname, 'views', 'terms-of-service.html'), 'utf8');

/**
 * Build and configure Fastify application
 */
export async function buildApp(opts = {}) {
  const app = Fastify({
    logger: false, // Use Winston logger instead
    trustProxy: true,
    disableRequestLogging: true,
    ...opts
  });

  try {
    // ==================== STATIC ASSETS ====================
    await app.register(fastifyStatic, {
      root: join(__dirname, '..', 'public'),
      prefix: '/assets/',
      decorateReply: false
    });

    // ==================== CORS ====================
    await app.register(cors, {
      origin: process.env.FRONTEND_URL || true,
      credentials: true
    });

    // ==================== SECURITY ====================
    await app.register(helmet, {
      contentSecurityPolicy: false // Disable for development
    });

    // ==================== RATE LIMITING ====================
    await app.register(rateLimit, {
      max: 100, // 100 requests
      timeWindow: '1 minute',
      errorResponseBuilder: () => ({
        error: 'Too Many Requests',
        message: 'Rate limit exceeded. Please try again later.'
      })
    });

    // ==================== SESSION ====================
    // Generate session key: openssl rand -base64 32
    const sessionSecret = process.env.SESSION_SECRET || 'a-secret-with-minimum-length-of-32-characters-for-secure-session';
    
    await app.register(secureSession, {
      secret: sessionSecret,
      salt: 'mq9hDxBVDbspDR6n',
      cookie: {
        path: '/',
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
      }
    });

    // ==================== GOOGLE OAUTH ====================
    await app.register(oauth2, {
      name: 'oauth2Google',
      scope: ['profile', 'email'],
      credentials: {
        client: {
          id: process.env.GOOGLE_OAUTH_CLIENT_ID,
          secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET
        },
        auth: oauth2.GOOGLE_CONFIGURATION
      },
      startRedirectPath: '/oauth2/google',
      redirectStateCookieName: 'oauth2-redirect-state',
      cookie: {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production'
      },
      callbackUri: process.env.GOOGLE_OAUTH_CALLBACK_URL || 'http://localhost:3000/auth/google/callback'
    });

    // ==================== REQUEST LOGGING ====================
    app.addHook('onRequest', (request, reply, done) => {
      const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      request.id = requestId;
      
      logger.info('Incoming request', {
        requestId,
        method: request.method,
        url: request.url,
        ip: request.ip
      });
      
      done();
    });

    app.addHook('onResponse', (request, reply, done) => {
      logger.info('Request completed', {
        requestId: request.id,
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        responseTime: reply.getResponseTime()
      });
      
      done();
    });

    // ==================== HEALTH CHECK ====================
    app.get('/', async (request, reply) => {
      const accepts = request.headers.accept || '';
      if (accepts.includes('application/json')) {
        return { service: 'VacationMonitor Web API', status: 'ok', auth: '/auth/google', health: '/health' };
      }
      // Redirect authenticated users straight to their dashboard
      const sessionUser = request.session.get('user');
      if (sessionUser) {
        return reply.redirect('/dashboard', 302);
      }
      return reply.type('text/html; charset=utf-8').send(homePageTemplate);
    });

    app.get('/dashboard', async (_request, reply) => {
      return reply.type('text/html; charset=utf-8').send(dashboardTemplate);
    });

    app.get('/search', async (_request, reply) => {
      return reply.type('text/html; charset=utf-8').send(searchTemplate);
    });

    app.get('/new-search', async (_request, reply) => {
      return reply.type('text/html; charset=utf-8').send(newSearchTemplate);
    });

    app.get('/settings', async (_request, reply) => {
      return reply.type('text/html; charset=utf-8').send(settingsTemplate);
    });

    app.get('/privacy', async (_request, reply) => {
      return reply.type('text/html; charset=utf-8').send(privacyPolicyTemplate);
    });

    app.get('/terms', async (_request, reply) => {
      return reply.type('text/html; charset=utf-8').send(termsOfServiceTemplate);
    });

    app.get('/health', async (request, reply) => {
      return {
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        environment: process.env.NODE_ENV || 'development'
      };
    });

    // ==================== ROUTES ====================
    await app.register(authRoutes);
    await app.register(userRoutes);
    await app.register(searchRoutes);
    await app.register(priceRoutes);

    // ==================== ERROR HANDLING ====================
    app.setErrorHandler(errorHandler);
    app.setNotFoundHandler(notFoundHandler);

    logger.info('Fastify app configured successfully');

    return app;

  } catch (error) {
    logger.error('Failed to build Fastify app', { error: error.message });
    throw error;
  }
}

/**
 * Start the web server
 */
export async function startServer() {
  try {
    logger.info('Starting VacationMonitor Web Server...');

    // Initialize Cosmos DB
    logger.info('Initializing Cosmos DB connection...');
    await cosmosDBService.initialize();

    // Build app
    const app = await buildApp();

    // Start server
    const port = parseInt(process.env.PORT || '3000', 10);
    const host = process.env.HOST || '0.0.0.0';

    await app.listen({ port, host });

    logger.info(`🚀 Server listening on http://${host}:${port}`);
    logger.info(`📊 Health check: http://${host}:${port}/health`);
    logger.info(`🔐 Google OAuth: http://${host}:${port}/auth/google`);
    
    return app;

  } catch (error) {
    logger.error('Failed to start server', { error: error.message, stack: error.stack });
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully...');
  process.exit(0);
});
