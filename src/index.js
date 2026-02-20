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
  const app = await startServer();

  // Also start scheduler in same process
  try {
    await schedulerService.start();
  } catch (error) {
    logger.warn('Scheduler failed to start', { error: error.message });
    logger.info('Web server is running but scheduler is offline - monitor the health endpoint');
  }

  logger.info('✅ Web server and scheduler started');

  return { app, schedulerService };
}

let schedulerService = null;
let gracefulShutdownInProgress = false;

/**
 * Handle graceful shutdown
 */
async function handleShutdown(signal) {
  if (gracefulShutdownInProgress) {
    logger.warn(`${signal} received again, forcing exit`);
    process.exit(1);
  }

  gracefulShutdownInProgress = true;
  logger.info(`${signal} received, initiating graceful shutdown...`);

  // Set a timeout to force exit if graceful shutdown takes too long
  const shutdownTimeout = setTimeout(() => {
    logger.error('Graceful shutdown timeout exceeded (10s), forcing exit');
    process.exit(1);
  }, 10000);

  try {
    // Stop scheduler first
    if (schedulerService) {
      logger.info('Stopping scheduler...');
      await schedulerService.stop();
    }

    logger.info('✅ Graceful shutdown completed');
    clearTimeout(shutdownTimeout);
    process.exit(0);
  } catch (error) {
    logger.error('Error during graceful shutdown', { error: error.message });
    clearTimeout(shutdownTimeout);
    process.exit(1);
  }
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

    const services = await startWebServer();
    schedulerService = services.schedulerService;
  } catch (error) {
    logger.error('Application failed to start', { error: error.message, stack: error.stack });
    process.exit(1);
  }
}

// Graceful shutdown handlers
process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

// Run only if this is the main module
if (process.argv[1] === __filename) {
  main();
}

export default main;
