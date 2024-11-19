import { OpenAI } from "openai";
import dotenv from "dotenv";
import pgvector from "pgvector";

// Add these constants at the top of the file
export const MAX_TOKENS = 8000; // Slightly below the 8192 limit to provide safety margin
export const TOKEN_OVERLAP = 200;

dotenv.config();

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Helper function to estimate tokens (rough approximation)
export function estimateTokens(text: string): number {
  // OpenAI generally uses ~4 chars per token for English text
  return Math.ceil(text.length / 4);
}

// Modified generateEmbeddingWithRetry function
export async function generateEmbeddingWithRetry(
  text: string,
  maxRetries: number = 3,
  initialDelay: number = 200
): Promise<any> {
  const estimatedTokens = estimateTokens(text);

  // If text is within token limit, proceed normally
  if (estimatedTokens <= MAX_TOKENS) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const cleanedText = text.replace(/[\r\n]/g, " ");
        const embeddingResponse = await openai.embeddings.create({
          model: "text-embedding-3-small",
          input: cleanedText,
          dimensions: 512,
        });

        return pgvector.toSql(embeddingResponse.data?.[0]?.embedding);
      } catch (error: any) {
        // If we hit the token limit, break out of retry loop and handle splitting
        if (
          error.status === 400 &&
          error.message?.includes("maximum context length")
        ) {
          break;
        }

        if (attempt === maxRetries) {
          console.error(
            "Failed all retry attempts for embedding generation:",
            error
          );
          throw error;
        }

        const delay =
          initialDelay * Math.pow(1.5, attempt - 1) + Math.random() * 100;
        console.log(
          `Embedding generation attempt ${attempt} failed. Retrying in ${delay}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  // Split text into chunks
  console.log("Text too long for single embedding, splitting into chunks...");
  const chunks = splitTextIntoChunks(text, MAX_TOKENS);

  // Process each chunk
  const embeddings: any[] = [];
  for (let i = 0; i < chunks.length; i++) {
    console.log(`Processing chunk ${i + 1}/${chunks.length}`);
    try {
      const embeddingResponse = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: chunks[i] as string,
        dimensions: 512,
      });

      embeddings.push(pgvector.toSql(embeddingResponse.data?.[0]?.embedding));
    } catch (error) {
      console.error(`Failed to generate embedding for chunk ${i + 1}:`, error);
      throw error;
    }
  }

  return embeddings;
}

export function splitTextIntoChunks(text: string, maxTokens: number): string[] {
  const chunks: string[] = [];
  let currentChunk = "";
  const words = text.split(/\s+/);

  for (const word of words) {
    const testChunk = currentChunk + " " + word;
    if (estimateTokens(testChunk) > maxTokens) {
      chunks.push(currentChunk.trim());
      currentChunk = word;
    } else {
      currentChunk = testChunk;
    }
  }
  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

export default openai;
