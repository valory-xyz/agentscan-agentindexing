import { Pool, PoolClient } from "pg";
import dotenv from "dotenv";

dotenv.config();

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is not defined");
}

// Create a single pool instance
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
  max: 100,
  idleTimeoutMillis: 240000,
});

// Handle pool errors
pool.on("error", (err, client) => {
  console.error("Unexpected error on idle client", err);
});

// Simplified query execution function
export const executeQuery = async <T>(
  queryFn: (client: PoolClient) => Promise<T>
): Promise<T> => {
  const client = await pool.connect();
  try {
    return await queryFn(client);
  } finally {
    client.release();
  }
};

// Test connection function
const testConnection = async (): Promise<void> => {
  try {
    await executeQuery(async (client) => {
      console.log("Successfully connected to PostgreSQL");
    });
  } catch (err) {
    console.error("Error connecting to PostgreSQL:", err);
  }
};

void testConnection();

export default executeQuery;
