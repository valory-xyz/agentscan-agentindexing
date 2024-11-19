import { Pool, PoolClient } from "pg";
import dotenv from "dotenv";

dotenv.config();

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL environment variable is not defined");
}

// Create a singleton pool instance using closure
const createPool = (() => {
  let pool: Pool | null = null;

  return () => {
    if (!pool) {
      pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: {
          rejectUnauthorized: false,
        },
      });

      // Handle pool errors
      pool.on("error", (err, client) => {
        console.error("Unexpected error on idle client", err);
      });
    }
    return pool;
  };
})();

// Helper function to execute queries with automatic client release
export const executeQuery = async <T>(
  queryFn: (client: PoolClient) => Promise<T>
): Promise<T> => {
  const pool = createPool();
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

// Test connection on startup
void testConnection();

export default executeQuery;
