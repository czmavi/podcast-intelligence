import type { Config } from "../shared/config.ts";
import { z } from "zod";

export interface TextEmbeddingProvider {
  readonly modelName: string;
  readonly dimensions: number;
  readonly candidateLimit: number;
  readonly minRerankScore: number;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
  rerank(query: string, documents: string[], signal?: AbortSignal): Promise<number[]>;
}

const responseSchema = z.object({
  modelName: z.string(),
  dimensions: z.number().int().positive(),
  embeddings: z.array(z.array(z.number().finite())),
});

const rerankResponseSchema = z.object({
  modelName: z.string(),
  scores: z.array(z.number().min(0).max(1)),
});

export class LocalTextEmbeddingProvider implements TextEmbeddingProvider {
  readonly modelName: string;
  readonly dimensions: number;
  readonly candidateLimit: number;
  readonly minRerankScore: number;

  constructor(private readonly config: Config) {
    this.modelName = config.TEXT_EMBEDDING_MODEL;
    this.dimensions = config.TEXT_EMBEDDING_DIMENSIONS;
    this.candidateLimit = config.SEARCH_CANDIDATE_LIMIT;
    this.minRerankScore = config.SEARCH_MIN_RERANK_SCORE;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    const headers = new Headers({ "content-type": "application/json" });
    if (this.config.AUDIO_ML_API_TOKEN) {
      headers.set("authorization", `Bearer ${this.config.AUDIO_ML_API_TOKEN}`);
    }
    const response = await fetch(`${this.config.AUDIO_ML_URL}/v1/embed-text`, {
      method: "POST",
      headers,
      body: JSON.stringify({ texts }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`Text embedding služba vrátila HTTP ${response.status}.`);
    const output = responseSchema.parse(await response.json());
    if (output.modelName !== this.modelName || output.dimensions !== this.dimensions) {
      throw new Error("Text embedding model není kompatibilní s databázovým indexem.");
    }
    if (output.embeddings.some((embedding) => embedding.length !== this.dimensions)) {
      throw new Error("Text embedding má chybný počet rozměrů.");
    }
    return output.embeddings;
  }

  async embedQuery(text: string): Promise<number[]> {
    const embeddings = await this.embedDocuments([text]);
    const embedding = embeddings[0];
    if (!embedding) throw new Error("Embedding provider nevrátil vektor.");
    return embedding;
  }

  async rerank(query: string, documents: string[], signal?: AbortSignal): Promise<number[]> {
    const headers = new Headers({ "content-type": "application/json" });
    if (this.config.AUDIO_ML_API_TOKEN) {
      headers.set("authorization", `Bearer ${this.config.AUDIO_ML_API_TOKEN}`);
    }
    const response = await fetch(`${this.config.AUDIO_ML_URL}/v1/rerank-text`, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, documents }),
      signal: signal ?? AbortSignal.timeout(300_000),
    });
    if (!response.ok) throw new Error(`Text reranker vrátil HTTP ${response.status}.`);
    const output = rerankResponseSchema.parse(await response.json());
    if (output.modelName !== this.config.TEXT_RERANKER_MODEL) {
      throw new Error("Text reranker používá jiný model, než očekává aplikace.");
    }
    if (output.scores.length !== documents.length) {
      throw new Error("Text reranker vrátil chybný počet výsledků.");
    }
    return output.scores;
  }
}
