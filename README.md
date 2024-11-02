# Agents.fun Base indexer

A [Ponder](https://ponder.sh) indexer for tracking Memeorr contract events and building a GraphQL API.

## Overview

This indexer tracks the following Memeorr events:
- Collected
- Hearted  
- OLASJourneyToAscendance
- Purged
- Summoned
- Unleashed

The indexed data is exposed via a GraphQL API that can be queried to analyze Memeorr activity.

### Local Development

1. Clone the repository
2. Install dependencies:
```bash
npm install
```

3. Create a `.env.local` file with your RPC URL:
```
PONDER_RPC_URL_8453="https://eth-mainnet.g.alchemy.com/v2/YOUR-API-KEY"
```

4. Start the development server:
```bash
npm run dev
```

The GraphQL playground will be available at http://localhost:42069/graphql

## Deploy

Check out the ponder [deployment guide](https://ponder.sh/docs/production/deploy) for detailed instructions.
