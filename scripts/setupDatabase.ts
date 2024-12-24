import { getPool, executeQuery } from "../utils/postgres";
import dotenv from "dotenv";

dotenv.config();

async function createTables() {
  const createAbiTable = `
    CREATE TABLE IF NOT EXISTS abis (
      id SERIAL PRIMARY KEY,
      address TEXT NOT NULL,
      chain_id INTEGER NOT NULL,
      abi JSONB NOT NULL,
      name TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(address, chain_id)
    );
  `;

  const createAbiChunksTable = `
    CREATE TABLE IF NOT EXISTS abi_chunks (
      id SERIAL PRIMARY KEY,
      abi_id INTEGER REFERENCES abis(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      chunk_text TEXT NOT NULL,
      embedding VECTOR(1536),
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(abi_id, chunk_index)
    );
  `;

  const createIndexes = `
    CREATE INDEX IF NOT EXISTS idx_abis_address ON abis(address);
    CREATE INDEX IF NOT EXISTS idx_abis_chain_id ON abis(chain_id);
    CREATE INDEX IF NOT EXISTS idx_abi_chunks_abi_id ON abi_chunks(abi_id);
  `;

  try {
    await executeQuery(async (client) => {
      // Create the vector extension if it doesn't exist
      await client.query(`CREATE EXTENSION IF NOT EXISTS vector;`);
      
      // Create tables
      await client.query(createAbiTable);
      await client.query(createAbiChunksTable);
      
      // Create indexes
      await client.query(createIndexes);
      
      console.log("Successfully created ABI database tables and indexes");
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
