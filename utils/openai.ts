import { OpenAI } from "openai";
import dotenv from "dotenv";
import pgvector from "pgvector";

export const MAX_TOKENS = 7500;
export const TOKEN_OVERLAP = 200;

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export async function generateEmbeddingWithRetry(
  text: string,
  maxRetries: number = 3,
  initialDelay: number = 200
): Promise<any> {
  const estimatedTokens = estimateTokens(text);

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

  console.log("Text too long for single embedding, splitting into chunks...");
  const chunks = splitTextIntoChunks(text, MAX_TOKENS);

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
  if (!text) return [];

  const chunks: string[] = [];
  let currentChunk = "";

  const sentences = text.match(/[^.!?]+[.!?]+|\s*[^.!?]+$/g) || [text];

  for (let sentence of sentences) {
    sentence = sentence.trim();
    const sentenceTokens = estimateTokens(sentence);

    if (sentenceTokens > maxTokens) {
      const words = sentence.split(/\s+/);

      for (const word of words) {
        const testChunk = currentChunk ? `${currentChunk} ${word}` : word;
        const testChunkTokens = estimateTokens(testChunk);

        if (testChunkTokens > maxTokens - TOKEN_OVERLAP) {
          if (currentChunk) {
            chunks.push(currentChunk.trim());
          }
          currentChunk = word;
        } else {
          currentChunk = testChunk;
        }
      }
    } else {
      const testChunk = currentChunk ? `${currentChunk} ${sentence}` : sentence;
      const testChunkTokens = estimateTokens(testChunk);

      if (testChunkTokens > maxTokens - TOKEN_OVERLAP) {
        if (currentChunk) {
          chunks.push(currentChunk.trim());
        }
        currentChunk = sentence;
      } else {
        currentChunk = testChunk;
      }
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }

  return chunks.map((chunk, index) => {
    if (index === 0) return chunk;

    const prevChunk = chunks[index - 1] ?? "";
    const overlapText = prevChunk
      .split(/\s+/)
      .slice(-TOKEN_OVERLAP / 20)
      .join(" ");
    return `${overlapText} ${chunk}`;
  });
}

export default openai;
