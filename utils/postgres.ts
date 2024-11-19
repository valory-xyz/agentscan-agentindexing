import { Pool, PoolClient } from "pg";
import dotenv from "dotenv";

dotenv.config();

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is not defined");
}

// Configure pool with connection limits
const createPool = (() => {
  let pool: Pool | null = null;

  return () => {
    if (!pool) {
      pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: {
          rejectUnauthorized: false,
        },
        max: 25, // Limit maximum connections
        idleTimeoutMillis: 120000, // Close idle connections after 60 seconds
      });

      // Handle pool errors
      pool.on("error", (err, client) => {
        console.error("Unexpected error on idle client", err);
      });
    }
    return pool;
  };
})();

// Add connection management helper
export const withConnection = async <T>(
  operation: (client: PoolClient) => Promise<T>
): Promise<T> => {
  const pool = createPool();
  const client = await pool.connect();

  try {
    return await operation(client);
  } finally {
    client.release();
  }
};

// Update executeQuery to use connection management
export const executeQuery = async <T>(
  queryFn: (client: PoolClient) => Promise<T>
): Promise<T> => {
  return withConnection(queryFn);
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

// Test connection on startup
void testConnection();

export default executeQuery;
