import { executeQuery } from "../utils/postgres";
import dotenv from "dotenv";

dotenv.config();

async function createTables() {
  const createContextEmbeddingsTable = `
    CREATE TABLE IF NOT EXISTS context_embeddings (
      id TEXT PRIMARY KEY,
      company_id TEXT,
      type TEXT,
      location TEXT,
      content TEXT,
      name TEXT,
      embedding VECTOR(512),
      is_chunk BOOLEAN,
      original_location TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      deleted_at TIMESTAMP WITH TIME ZONE
    );
  `;

  const createIndexes = `
    CREATE INDEX IF NOT EXISTS idx_context_embeddings_company_id ON context_embeddings(company_id);
    CREATE INDEX IF NOT EXISTS idx_context_embeddings_type ON context_embeddings(type);
    CREATE INDEX IF NOT EXISTS idx_context_embeddings_location ON context_embeddings(location);
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
