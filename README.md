# AgentScan indexer

A [Ponder](https://ponder.sh) indexer for tracking agent and service contract events, as well as transactions on top of olas

The indexed data is exposed via a GraphQL API that can be queried to analyze Agent activity

## Prerequisites

- Node.js >= 18.14
- PostgreSQL with pgvector extension installed
- RPC URLs for mainnet, gnosis, and base chains
- Docker (optional, for containerized deployment)

Most RPC endpoints can be obtained from [Alchemy](https://www.alchemy.com/) or [Quicknode](https://www.quicknode.com/)

### Local Development

1. Clone the repository
2. Install dependencies:

```bash
npm ci
```

3. Create a `.env.local` file with your RPC URLs and database configuration:

```bash
# Required RPC URLs
PONDER_RPC_URL_8453="..." # Base
PONDER_RPC_URL_1="..."    # Mainnet
PONDER_RPC_URL_100="..."  # Gnosis

# Required: PostgreSQL database URL with pgvector extension
ABI_DATABASE_URL="postgresql://user:password@host:port/database"

# Optional: OpenAI API key for embeddings
OPENAI_API_KEY="..."
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

### Docker Development Setup

For local development using Docker, you can use the provided docker-compose setup:

1. Create a `.env.local` file with your configuration (see above)

2. Start the development environment:

```bash
docker compose up -d
```

This will start:

- PostgreSQL database with pgvector extension
- Redis instance for caching
- The services will be available at:
  - PostgreSQL: localhost:9090
  - Redis: localhost:6379

### Production Deployment

For production deployment using Docker, you'll need to configure the following environment variables:

| Variable            | Description                   | Required | Default    |
| ------------------- | ----------------------------- | -------- | ---------- |
| NODE_ENV            | Environment setting           | Yes      | production |
| PONDER_RPC_URL_1    | Ethereum RPC URL              | Yes      | -          |
| PONDER_RPC_URL_100  | Gnosis Chain RPC URL          | Yes      | -          |
| PONDER_RPC_URL_8453 | Base Chain RPC URL            | Yes      | -          |
| DATABASE_URL        | Main PostgreSQL database URL  | Yes      | -          |
| ABI_DATABASE_URL    | ABI PostgreSQL database URL   | No       | -          |
| REDIS_URL           | Redis connection URL          | No       | -          |
| OPENAI_API_KEY      | OpenAI API key for embeddings | No\*     | -          |

\* Required if ABI_DATABASE_URL is set

To deploy using Docker:

1. Build the image:

```bash
DOCKER_BUILDKIT=1 docker build -t agentscan-indexer .
```

2. Run the container:

```bash
docker run -d \
  --name agentscan-indexer \
  -p 42069:42069 \
  -e NODE_ENV=production \
  -e PONDER_RPC_URL_1=your_ethereum_rpc \
  -e PONDER_RPC_URL_100=your_gnosis_rpc \
  -e PONDER_RPC_URL_8453=your_base_rpc \
  -e DATABASE_URL=your_database_url \
  -e ABI_DATABASE_URL=your_abi_database_url \
  -e REDIS_URL=your_redis_url \
  -e OPENAI_API_KEY=your_openai_key \
  agentscan-indexer
```

The service will be available at http://localhost:42069/graphql

## Troubleshooting

If you encounter database-related errors:

- Ensure the pgvector extension is installed in your PostgreSQL database
- Verify your database connection string in `.env.local`
- Check that your PostgreSQL user has sufficient permissions
- For Docker deployments, ensure all required environment variables are set correctly

## Deploy

For more detailed deployment options, check out the Ponder [deployment guide](https://ponder.sh/docs/production/deploy).
