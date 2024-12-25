# AgentScan indexer

A [Ponder](https://ponder.sh) indexer for tracking agent and service contract events, as well as transactions on top of olas

The indexed data is exposed via a GraphQL API that can be queried to analyze Agent activity

## Prerequisites

- Node.js >= 18.14
- PostgreSQL with pgvector extension installed
- RPC URLs for mainnet, gnosis, and base chains

Most RPC endpoints can be obtained from [Alchemy](https://www.alchemy.com/) or [Quicknode](https://www.quicknode.com/)

### Local Development

1. Clone the repository
2. Install dependencies:
```bash
npm install
```

3. Create a `.env.local` file with your RPC URLs and database configuration:
```bash
# Required RPC URLs
PONDER_RPC_URL_8453="..." # Base
PONDER_RPC_URL_1="..."    # Mainnet
PONDER_RPC_URL_100="..."  # Gnosis

# Required: PostgreSQL database URL with pgvector extension
ABI_DATABASE_URL="postgresql://user:password@host:port/database"
```

4. Set up the database:
```bash
# First, ensure pgvector extension is installed in your PostgreSQL database
psql -d your_database_name -c 'CREATE EXTENSION IF NOT EXISTS vector;'

# Then run the database setup script
npm run setup-db
```

This will:
- Create the required tables with vector support
- Set up necessary indexes for efficient querying
- Add composite unique constraints for data integrity

5. Start the development server:
```bash
npm run dev
```

The GraphQL playground will be available at http://localhost:42069/graphql

## Troubleshooting

If you encounter database-related errors:
- Ensure the pgvector extension is installed in your PostgreSQL database
- Verify your database connection string in `.env.local`
- Check that your PostgreSQL user has sufficient permissions

## Deploy

Check out the ponder [deployment guide](https://ponder.sh/docs/production/deploy) for detailed instructions.

