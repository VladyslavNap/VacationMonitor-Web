import dotenv from 'dotenv';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { join, dirname } from 'path';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env file for local development
// In Azure App Service, environment variables are provided directly by the platform
const envPath = join(__dirname, '..', '.env');
if (existsSync(envPath)) {
  dotenv.config({ path: envPath });
  console.log('✓ Loaded environment variables from .env file');
} else {
  console.log('ℹ No .env file found — using environment variables from system (Azure App Service)');
}

const logger = require('./logger.cjs');

/**
 * VacationMonitor Web — API Server + Scheduler
 *
 * Serves the Fastify REST API (OAuth, searches, prices)
 * and runs the scheduler that polls the DB and enqueues
 * jobs to Azure Service Bus for the Worker to consume.
 */

/**
 * Start in web server mode (default)
 */
async function startWebServer() {
  logger.info('Starting in WEB SERVER mode...');

  const { startServer } = await import('./app.js');
  const schedulerService = (await import('./services/scheduler.service.js')).default;

  // Start web server
  await startServer();

  // Also start scheduler in same process
  await schedulerService.start();

  logger.info('✅ Web server and scheduler started');
}

/**
 * Main entry point
 */
async function main() {
  try {
    logger.info('='.repeat(60));
    logger.info('VacationMonitor Web — API Server + Scheduler');
    logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
    logger.info('='.repeat(60));

    await startWebServer();
  } catch (error) {
    logger.error('Application failed to start', { error: error.message, stack: error.stack });
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

// Run only if this is the main module
if (process.argv[1] === __filename) {
  main();
}

export default main;
