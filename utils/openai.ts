import { OpenAI } from "openai";
import pgvector from "pgvector";
import dotenv from "dotenv";

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Add type for retry options
interface RetryOptions {
  maxRetries?: number;
  initialDelay?: number;
}

// Add these constants at the top of the file
export const MAX_TOKENS = 4000; // Significantly reduced from 4000
export const TOKEN_OVERLAP = 25; // Reduced from 50
export const MIN_CHUNK_LENGTH = 100;
export const ABSOLUTE_MAX_TOKENS = 7000; // Reduced from 8000

// Helper function to estimate tokens (rough approximation)
export function estimateTokens(text: string | undefined): number {
  if (!text) return 0;
  // More aggressive token estimation
  if (text.trim().startsWith("{") || text.trim().startsWith("[")) {
    // Even more conservative for JSON/ABI content
    return Math.ceil(text.length / 2); // Changed from 2.5 to 2
  }
  const hasCode = /[{}\[\]()]/g.test(text);
  return Math.ceil(text.length / (hasCode ? 2 : 3)); // More conservative estimates
}

// Content-specific token limits
const TOKEN_LIMITS = {
  ABI: {
    MAX_TOKENS: 4000,
    TOKEN_OVERLAP: 20,
    MIN_CHUNK_LENGTH: 50,
    ABSOLUTE_MAX: 6000,
  },
  CODE: {
    MAX_TOKENS: 5000,
    TOKEN_OVERLAP: 100,
    MIN_CHUNK_LENGTH: 100,
    ABSOLUTE_MAX: 7000,
  },
  DEFAULT: {
    MAX_TOKENS: 7500,
    TOKEN_OVERLAP: 200,
    MIN_CHUNK_LENGTH: 100,
    ABSOLUTE_MAX: 7500,
  },
};

// ABI detection
function isABI(text: string): boolean {
  try {
    const content = JSON.parse(text);
    if (!Array.isArray(content)) return false;

    return content.some(
      (item) =>
        item &&
        typeof item === "object" &&
        ((item.type &&
          ["function", "event", "constructor"].includes(item.type)) ||
          (item.inputs && Array.isArray(item.inputs)) ||
          (item.stateMutability && typeof item.stateMutability === "string"))
    );
  } catch {
    return false;
  }
}

export function splitTextIntoChunks(
  text: string | undefined,
  maxTokens: number = TOKEN_LIMITS.DEFAULT.MAX_TOKENS
): string[] {
  if (!text) return [];

  // Determine content type and get appropriate limits
  let limits = TOKEN_LIMITS.DEFAULT;
  if (isABI(text)) {
    limits = TOKEN_LIMITS.ABI;
    return splitABIContent(text, limits);
  } else if (/[{}\[\]()]/g.test(text)) {
    limits = TOKEN_LIMITS.CODE;
  }

  const actualMaxTokens = Math.min(maxTokens, limits.ABSOLUTE_MAX);
  const chunks: string[] = [];

  // Helper function to safely add chunks
  const addChunk = (chunk: string) => {
    const trimmed = chunk.trim();
    if (trimmed.length >= limits.MIN_CHUNK_LENGTH) {
      const estimatedSize = estimateTokens(trimmed);
      if (estimatedSize <= limits.ABSOLUTE_MAX) {
        chunks.push(trimmed);
      } else {
        // Split large chunks into smaller pieces
        const subChunks = splitBySize(trimmed, actualMaxTokens, limits);
        chunks.push(...subChunks);
      }
    }
  };

  // Helper function for splitting by size
  const splitBySize = (
    text: string,
    maxSize: number,
    limits: typeof TOKEN_LIMITS.DEFAULT
  ): string[] => {
    const localChunks: string[] = [];
    let current = "";
    let currentSize = 0;
    const words = text.split(/\s+/);

    for (const word of words) {
      const wordSize = estimateTokens(word);
      if (currentSize + wordSize > maxSize - limits.TOKEN_OVERLAP) {
        if (current) {
          localChunks.push(current.trim());
          current = "";
          currentSize = 0;
        }
      }
      current = current ? `${current} ${word}` : word;
      currentSize += wordSize;
    }

    if (current) {
      localChunks.push(current.trim());
    }

    return localChunks;
  };

  // Specialized function for splitting ABI content
  function splitABIContent(
    abiText: string,
    limits: typeof TOKEN_LIMITS.ABI
  ): string[] {
    try {
      const abi = JSON.parse(abiText);
      const chunks: string[] = [];
      let currentChunk: any[] = [];
      let currentSize = 0;

      for (const item of abi) {
        const itemString = JSON.stringify(item);
        const itemSize = estimateTokens(itemString);

        // If single item is too large, split it
        if (itemSize > limits.MAX_TOKENS) {
          if (currentChunk.length > 0) {
            chunks.push(JSON.stringify(currentChunk));
            currentChunk = [];
            currentSize = 0;
          }
          // Split large item into smaller pieces
          const subChunks = splitBySize(itemString, limits.MAX_TOKENS, limits);
          chunks.push(...subChunks);
          continue;
        }

        // Check if adding this item would exceed the limit
        if (currentSize + itemSize > limits.MAX_TOKENS - limits.TOKEN_OVERLAP) {
          chunks.push(JSON.stringify(currentChunk));
          currentChunk = [];
          currentSize = 0;
        }

        currentChunk.push(item);
        currentSize += itemSize;
      }

      // Add remaining items
      if (currentChunk.length > 0) {
        chunks.push(JSON.stringify(currentChunk));
      }

      return chunks;
    } catch (error) {
      console.error("Error splitting ABI:", error);
      // Fallback to regular splitting if JSON parsing fails
      return splitBySize(abiText, limits.MAX_TOKENS, limits);
    }
  }

  // Handle regular text content
  if (!text.trim().startsWith("{") && !text.trim().startsWith("[")) {
    const segments = text.split(/(?<=\.|\?|\!)\s+/);
    let currentChunk = "";
    let currentSize = 0;

    for (const segment of segments) {
      const segmentSize = estimateTokens(segment);

      if (currentSize + segmentSize > actualMaxTokens - limits.TOKEN_OVERLAP) {
        if (currentChunk) {
          addChunk(currentChunk);
          currentChunk = "";
          currentSize = 0;
        }
      }

      currentChunk = currentChunk ? `${currentChunk} ${segment}` : segment;
      currentSize += segmentSize;
    }

    if (currentChunk) {
      addChunk(currentChunk);
    }
  }

  return chunks;
}

async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const { maxRetries = 3, initialDelay = 400 } = options;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      if (error?.status === 429) {
        const retryAfterMs = error.response?.headers?.["retry-after-ms"];

        const retryAfter = error.response?.headers?.["retry-after"];

        let delayMs: number;
        if (retryAfterMs) {
          delayMs = parseInt(retryAfterMs);
        } else if (retryAfter) {
          delayMs = parseInt(retryAfter) * 1000;
        } else {
          delayMs = Math.pow(2, attempt) * 1000 + Math.random() * 1000;
        }

        console.error(
          `Rate limited. Waiting ${delayMs}ms before retry...`,
          error?.message
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }

      if (attempt === maxRetries) {
        console.error(`Failed all retry attempts:`, error);
        throw error;
      }

      const delay =
        initialDelay * Math.pow(2, attempt - 1) + Math.random() * 200;
      console.error(`Attempt ${attempt} failed. Retrying in ${delay}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw new Error("Failed after all retries");
}

// Cache for embeddings
const embeddingCache = new Map<string, number[]>();

export async function generateEmbeddingWithRetry(
  text: string,
  options?: RetryOptions
): Promise<any> {
  // Check cache first
  const cached = embeddingCache.get(text);
  if (cached) return cached;

  const estimatedTokens = estimateTokens(text);

  // If text might be too long, split it before attempting embedding
  if (estimatedTokens > MAX_TOKENS) {
    const chunks = splitTextIntoChunks(text, MAX_TOKENS);

    const embeddings: any[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];

      try {
        // Double-check chunk size
        if (estimateTokens(chunk) > MAX_TOKENS) {
          console.log(`Chunk ${i + 1} still too large, further splitting...`);
          const subChunks = splitTextIntoChunks(chunk, MAX_TOKENS / 2);
          for (let j = 0; j < subChunks.length; j++) {
            const subChunk = subChunks[j];
            const embedding = await withRetry(async () => {
              if (!subChunk) return null;
              const response = await openai.embeddings.create({
                model: "text-embedding-3-small",
                input: subChunk,
                dimensions: 512,
              });
              return pgvector.toSql(response.data?.[0]?.embedding);
            }, options);
            embeddings.push(embedding);
          }
        } else {
          const embedding = await withRetry(async () => {
            if (!chunk) return null;
            const response = await openai.embeddings.create({
              model: "text-embedding-3-small",
              input: chunk,
              dimensions: 512,
            });
            return pgvector.toSql(response.data?.[0]?.embedding);
          }, options);
          embeddings.push(embedding);
        }
      } catch (error) {
        console.error(`Error processing chunk ${i + 1}!:`, error);
      }
    }
    return embeddings;
  } else {
    const embedding = await withRetry(async () => {
      const response = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: text,
        dimensions: 512,
      });
      return pgvector.toSql(response.data?.[0]?.embedding);
    }, options);

    // Cache the result
    embeddingCache.set(text, embedding);
    return embedding;
  }
}
