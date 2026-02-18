import { readFileSync } from 'fs';
import { parse } from 'csv-parse/sync';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';
import { nanoid } from 'nanoid';

// Load environment variables
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Import services
import cosmosDBService from '../src/services/cosmos-db.service.js';
import BookingURLParser from '../src/parsers/booking-url-parser.js';

const urlParser = new BookingURLParser();

/**
 * Migrate existing file-based data to Cosmos DB
 * Converts CSV prices and JSON conversations to database records
 */
async function migrateData() {
  try {
    console.log('🚀 Starting data migration...\n');

    // Initialize Cosmos DB
    await cosmosDBService.initialize();
    console.log('✅ Cosmos DB connected\n');

    // ==================== MIGRATE DEFAULT USER ====================
    console.log('📝 Creating default user...');
    const defaultUserId = `user_${nanoid(16)}`;
    const defaultUser = await cosmosDBService.upsertUser({
      id: defaultUserId,
      email: process.env.EMAIL_RECIPIENT?.split(',')[0] || 'user@example.com',
      displayName: 'Default User',
      googleId: 'migration_default',
      emailPreferences: { enabled: true }
    });
    console.log(`✅ Default user created: ${defaultUser.email}\n`);

    // ==================== MIGRATE SEARCH CONFIG ====================
    console.log('📝 Migrating search configuration...');
    const configPath = path.join(__dirname, '..', 'config', 'search-config.json');
    
    let searchConfig;
    try {
      const configData = readFileSync(configPath, 'utf-8');
      searchConfig = JSON.parse(configData);
    } catch (error) {
      console.log('⚠️  No search-config.json found, skipping search migration');
      searchConfig = null;
    }

    let defaultSearchId = null;
    if (searchConfig) {
      defaultSearchId = `search_${nanoid(16)}`;
      
      // Transform old config format to new criteria format
      const oldFormat = searchConfig.search || searchConfig;
      const criteria = {
        destination: oldFormat.destination,
        destinationType: oldFormat.destinationType || 'region',
        checkIn: oldFormat.checkIn,
        checkOut: oldFormat.checkOut,
        adults: oldFormat.adults || 2,
        children: oldFormat.children || 0,
        childAges: oldFormat.childAge ? [oldFormat.childAge] : (oldFormat.childAges || []),
        rooms: oldFormat.rooms || 1,
        currency: oldFormat.currency,
        minPrice: oldFormat.minPrice,
        reviewScore: oldFormat.reviewScore,
        mealPlan: oldFormat.mealPlan,
        stayType: oldFormat.stayType
      };
      
      // Build search URL from criteria
      const searchUrl = urlParser.buildUrl(criteria);
      
      const search = await cosmosDBService.createSearch({
        id: defaultSearchId,
        userId: defaultUserId,
        searchName: oldFormat.cityName || 'Default Search',
        searchUrl: searchUrl,
        criteria: criteria,
        emailRecipients: process.env.EMAIL_RECIPIENT?.split(',').map(e => e.trim()) || [defaultUser.email],
        schedule: {
          enabled: true,
          intervalHours: 6,
          nextRun: new Date().toISOString()
        },
        isActive: true
      });

      console.log(`✅ Search created: ${search.searchName}`);
      console.log(`   Destination: ${oldFormat.cityName}`);
      console.log(`   Check-in: ${oldFormat.checkIn}`);
      console.log(`   Check-out: ${oldFormat.checkOut}\n`);
    }

    // ==================== MIGRATE PRICE HISTORY ====================
    console.log('📝 Migrating price history from CSV...');
    const csvPath = path.join(__dirname, '..', 'data', 'booking_prices.csv');
    
    let priceCount = 0;
    try {
      const csvData = readFileSync(csvPath, 'utf-8');
      const records = parse(csvData, {
        columns: true,
        skip_empty_lines: true
      });

      if (records.length > 0) {
        console.log(`   Found ${records.length} price records`);
        
        if (!defaultSearchId) {
          console.log('⚠️  No search created, skipping price migration');
        } else {
          // Convert CSV records to price documents
          const prices = records.map(record => ({
            id: `price_${nanoid(16)}`,
            searchId: defaultSearchId,
            userId: defaultUserId,
            hotelName: record['Hotel Name'] || record.hotelName,
            rating: record['Rating'] || record.rating,
            location: record['Location'] || record.location,
            cityName: record['City Name'] || record.cityName,
            originalPriceText: record['Original Price Text'] || record.originalPriceText,
            parsedPrice: record['Parsed Price'] || record.parsedPrice,
            numericPrice: parseFloat(record['Numeric Price'] || record.numericPrice || '0'),
            currency: record['Currency'] || record.currency,
            hotelUrl: record['Hotel URL'] || record.hotelUrl,
            extractedAt: record['Extracted At'] || record.extractedAt,
            searchDestination: record['Search Destination'] || record.searchDestination,
            searchDate: record['Search Date'] || record.searchDate
          }));

          // Import in batches of 100
          const batchSize = 100;
          for (let i = 0; i < prices.length; i += batchSize) {
            const batch = prices.slice(i, i + batchSize);
            await cosmosDBService.createPrices(batch);
            priceCount += batch.length;
            console.log(`   Imported ${priceCount}/${prices.length} prices...`);
          }

          console.log(`✅ Imported ${priceCount} price records\n`);
        }
      } else {
        console.log('⚠️  No price records found in CSV\n');
      }
    } catch (error) {
      console.log('⚠️  No booking_prices.csv found, skipping price migration\n');
    }

    // ==================== MIGRATE AI CONVERSATIONS ====================
    console.log('📝 Migrating AI conversation history...');
    const conversationPath = path.join(__dirname, '..', 'data', 'ai-conversation.json');
    
    try {
      const conversationData = readFileSync(conversationPath, 'utf-8');
      const conversations = JSON.parse(conversationData);
      
      if (defaultSearchId && conversations['booking-monitor-thread']) {
        const messages = conversations['booking-monitor-thread'];
        await cosmosDBService.updateConversation(defaultSearchId, messages);
        console.log(`✅ Imported conversation with ${messages.length} messages\n`);
      } else {
        console.log('⚠️  No conversation to migrate\n');
      }
    } catch (error) {
      console.log('⚠️  No ai-conversation.json found, skipping conversation migration\n');
    }

    // ==================== SUMMARY ====================
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ Data migration completed successfully!\n');
    console.log('📊 Summary:');
    console.log(`   Users created: 1`);
    console.log(`   Searches created: ${defaultSearchId ? 1 : 0}`);
    console.log(`   Prices imported: ${priceCount}`);
    console.log(`   Conversations imported: ${defaultSearchId ? 1 : 0}`);
    console.log('\n📝 Next steps:');
    console.log('   1. Start the web server: npm start');
    console.log('   2. Visit http://localhost:3000/auth/google to login');
    console.log('   3. Start the worker: npm run worker');
    console.log(`   4. Your migrated data is associated with: ${defaultUser.email}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  } catch (error) {
    console.error('\n❌ Migration failed:');
    console.error(error.message);
    console.error('\nStack trace:', error.stack);
    process.exit(1);
  }
}

// Run migration
migrateData();
