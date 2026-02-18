import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const logger = require('../logger.cjs');

/**
 * Global error handler for Fastify
 */
export function errorHandler(error, request, reply) {
  // Log error with context
  logger.error('Request error', {
    error: error.message,
    stack: error.stack,
    method: request.method,
    url: request.url,
    userId: request.user?.id
  });

  // Handle validation errors
  if (error.validation) {
    return reply.code(400).send({
      error: 'Validation Error',
      message: 'Invalid request data',
      details: error.validation
    });
  }

  // Handle Cosmos DB errors
  if (error.code === 404) {
    return reply.code(404).send({
      error: 'Not Found',
      message: 'Resource not found'
    });
  }

  if (error.code === 409) {
    return reply.code(409).send({
      error: 'Conflict',
      message: 'Resource already exists'
    });
  }

  // Handle rate limiting
  if (error.statusCode === 429) {
    return reply.code(429).send({
      error: 'Too Many Requests',
      message: 'Rate limit exceeded. Please try again later.'
    });
  }

  // Default to 500 Internal Server Error
  const statusCode = error.statusCode || 500;
  return reply.code(statusCode).send({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'production' 
      ? 'An unexpected error occurred' 
      : error.message
  });
}

/**
 * Not found handler
 */
export function notFoundHandler(request, reply) {
  reply.code(404).send({
    error: 'Not Found',
    message: `Route ${request.method} ${request.url} not found`
  });
}
