import { Pool, PoolClient } from "pg";
import dotenv from "dotenv";

dotenv.config();

let poolInstance: Pool | null = null;

const createPool = (): Pool => {
  if (!process.env.ABI_DATABASE_URL) {
    throw new Error("ABI_DATABASE_URL environment variable is not defined");
  }

  const pool = new Pool({
    connectionString: process.env.ABI_DATABASE_URL,
    ssl: {
      rejectUnauthorized: false,
    },
  });

  pool.on("error", (err, client) => {
    console.error("Unexpected error on idle client:", {
      error: err.message,
      stack: err.stack,
    });
  });

  return pool;
};

export const getPool = (): Pool => {
  if (!poolInstance) {
    poolInstance = createPool();
  }
  return poolInstance;
};

export const pool = getPool();

export const executeQuery = async <T>(
  queryFn: (client: PoolClient) => Promise<T>,
  retries = 3
): Promise<T> => {
  const pool = getPool();
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const client = await pool.connect();
      try {
        return await queryFn(client);
      } finally {
        client.release();
      }
    } catch (err: any) {
      lastError = err;
      console.error(`Database connection attempt ${attempt} failed:`, {
        error: err.message,
        code: err.code,
        host: new URL(process.env.ABI_DATABASE_URL || "").hostname,
      });

      if (attempt < retries) {
        // Wait before retrying (exponential backoff)
        await new Promise((resolve) =>
          setTimeout(resolve, Math.pow(2, attempt) * 1000)
        );
      }
    }
  }
  throw lastError;
};

const testConnection = async (): Promise<void> => {
  try {
    await executeQuery(async (client) => {
      const result = await client.query("SELECT NOW()");
      console.log(
        "Successfully connected to PostgreSQL at:",
        result.rows[0].now
      );
    });
  } catch (err) {
    console.error("Error connecting to PostgreSQL:", err);
  }
};

void testConnection();
