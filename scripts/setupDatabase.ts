import { getPool, executeQuery } from "../utils/postgres";
import dotenv from "dotenv";

dotenv.config();

async function createTables() {
  const createContextEmbeddingsTable = `
    CREATE TABLE IF NOT EXISTS context_embeddings (
      id SERIAL PRIMARY KEY,
      address TEXT,
      chain_id INTEGER,
      chunk_index INTEGER,
      chunk_text TEXT NOT NULL,
      embedding VECTOR(1536),
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(address, chain_id, chunk_index)
    );
  `;

  const createIndexes = `
    CREATE INDEX IF NOT EXISTS idx_context_embeddings_address ON context_embeddings(address);
    CREATE INDEX IF NOT EXISTS idx_context_embeddings_chain_id ON context_embeddings(chain_id);
  `;

  try {
    await executeQuery(async (client) => {
      // Create the vector extension if it doesn't exist
      await client.query(`CREATE EXTENSION IF NOT EXISTS vector;`);
      
      // Create table
      await client.query(createContextEmbeddingsTable);
      
      // Create indexes
      await client.query(createIndexes);
      
      console.log("Successfully created context embeddings table and indexes");
    });
  } catch (error: any) {
    console.error("Error creating database tables:", error.message);
    throw error;
  }
}

async function main() {
  if (!process.env.ABI_DATABASE_URL) {
    console.warn("ABI_DATABASE_URL not defined - skipping database setup");
    process.exit(0);
  }

  try {
    await createTables();
    console.log("Database setup completed successfully");
  } catch (error) {
    console.error("Database setup failed:", error);
    process.exit(1);
  }
}

void main();
