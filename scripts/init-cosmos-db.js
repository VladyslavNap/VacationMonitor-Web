import { CosmosClient } from '@azure/cosmos';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

// Load environment variables
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

/**
 * Initialize Cosmos DB database and containers for VacationMonitor
 * Creates database if it doesn't exist and sets up all required containers with proper partitioning
 */

const CONTAINER_DEFINITIONS = [
  {
    id: 'users',
    partitionKey: '/userId',
    description: 'User profiles and authentication data',
    throughput: 400, // Autoscale RU/s
    indexingPolicy: {
      indexingMode: 'consistent',
      automatic: true,
      includedPaths: [
        { path: '/*' }
      ],
      excludedPaths: [
        { path: '/photoURL/?' }
      ]
    }
  },
  {
    id: 'searches',
    partitionKey: '/userId',
    description: 'User search configurations and schedules',
    throughput: 400,
    indexingPolicy: {
      indexingMode: 'consistent',
      automatic: true,
      includedPaths: [
        { path: '/*' }
      ],
      excludedPaths: []
    }
  },
  {
    id: 'prices',
    partitionKey: '/searchId',
    description: 'Historical price data per search',
    throughput: 1000, // Higher throughput for high-volume writes
    indexingPolicy: {
      indexingMode: 'consistent',
      automatic: true,
      includedPaths: [
        { path: '/extractedAt/?' },
        { path: '/searchId/?' },
        { path: '/hotelName/?' },
        { path: '/numericPrice/?' }
      ],
      excludedPaths: [
        { path: '/*' }
      ]
    }
  },
  {
    id: 'conversations',
    partitionKey: '/searchId',
    description: 'AI conversation threads per search',
    throughput: 400,
    indexingPolicy: {
      indexingMode: 'consistent',
      automatic: true,
      includedPaths: [
        { path: '/searchId/?' },
        { path: '/updatedAt/?' }
      ],
      excludedPaths: [
        { path: '/*' }
      ]
    }
  },
  {
    id: 'jobs',
    partitionKey: '/status',
    description: 'Background job tracking and metadata',
    throughput: 400,
    indexingPolicy: {
      indexingMode: 'consistent',
      automatic: true,
      includedPaths: [
        { path: '/*' }
      ],
      excludedPaths: []
    }
  },
  {
    id: 'searchShares',
    partitionKey: '/searchId',
    description: 'Search sharing and permissions',
    throughput: 400,
    indexingPolicy: {
      indexingMode: 'consistent',
      automatic: true,
      includedPaths: [
        { path: '/searchId/?' },
        { path: '/sharedWithUserId/?' },
        { path: '/ownerId/?' }
      ],
      excludedPaths: [
        { path: '/*' }
      ]
    }
  }
];

async function initializeCosmosDB() {
  try {
    console.log('🚀 Starting Cosmos DB initialization...\n');

    // Validate environment variables
    const endpoint = process.env.COSMOS_ENDPOINT;
    const key = process.env.COSMOS_KEY;
    const databaseName = process.env.COSMOS_DATABASE_NAME;

    if (!endpoint || !key || !databaseName) {
      throw new Error('❌ Missing required environment variables: COSMOS_ENDPOINT, COSMOS_KEY, COSMOS_DATABASE_NAME');
    }

    console.log(`📍 Endpoint: ${endpoint}`);
    console.log(`📦 Database: ${databaseName}\n`);

    // Initialize Cosmos Client
    const client = new CosmosClient({ endpoint, key });

    // Create database if it doesn't exist
    console.log(`Creating database "${databaseName}"...`);
    const { database } = await client.databases.createIfNotExists({
      id: databaseName
    });
    console.log(`✅ Database ready: ${database.id}\n`);

    // Create containers
    for (const containerDef of CONTAINER_DEFINITIONS) {
      console.log(`Creating container "${containerDef.id}"...`);
      console.log(`  📝 Description: ${containerDef.description}`);
      console.log(`  🔑 Partition Key: ${containerDef.partitionKey}`);
      console.log(`  ⚡ Throughput: ${containerDef.throughput} RU/s (autoscale)`);

      try {
        const { container } = await database.containers.createIfNotExists({
          id: containerDef.id,
          partitionKey: {
            paths: [containerDef.partitionKey],
            kind: 'Hash'
          },
          indexingPolicy: containerDef.indexingPolicy,
          throughput: containerDef.throughput
        });

        console.log(`✅ Container ready: ${container.id}\n`);
      } catch (error) {
        if (error.code === 409) {
          console.log(`⚠️  Container "${containerDef.id}" already exists, skipping...\n`);
        } else {
          throw error;
        }
      }
    }

    // Summary
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ Cosmos DB initialization completed successfully!\n');
    console.log('📊 Summary:');
    console.log(`   Database: ${databaseName}`);
    console.log(`   Containers: ${CONTAINER_DEFINITIONS.length}`);
    console.log(`   Total Throughput: ${CONTAINER_DEFINITIONS.reduce((sum, c) => sum + c.throughput, 0)} RU/s`);
    console.log('\n📝 Next steps:');
    console.log('   1. Update your .env file with additional required variables (Google OAuth, Service Bus)');
    console.log('   2. Run: npm install (to install new dependencies)');
    console.log('   3. Run: npm run migrate (to import existing data)');
    console.log('   4. Run: npm start (to start the web server)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  } catch (error) {
    console.error('\n❌ Error initializing Cosmos DB:');
    console.error(error.message);
    console.error('\nStack trace:', error.stack);
    process.exit(1);
  }
}

// Run initialization
initializeCosmosDB();
