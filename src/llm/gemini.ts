import { GoogleGenAI } from '@google/genai';
import type { LLM } from './types.js';

const JSON_TIMEOUT_MS = 12_000;
const FIRST_CHUNK_TIMEOUT_MS = 8_000;
const STREAM_TIMEOUT_MS = 60_000;

export function createGeminiLLM(
  apiKey: string,
  models: { fast: string; main: string },
): LLM {
  // The `-latest` aliases only exist on v1beta; the SDK defaults to v1.
  const client = new GoogleGenAI({ apiKey, apiVersion: 'v1beta' });
  const modelId = (tier: 'fast' | 'main') => (tier === 'fast' ? models.fast : models.main);

  async function* streamFrom(model: string, system: string, prompt: string) {
    const controller = new AbortController();
    const total = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);
    const firstChunk = setTimeout(() => controller.abort(), FIRST_CHUNK_TIMEOUT_MS);
    try {
      const response = await client.models.generateContentStream({
        model,
        contents: prompt,
        config: { systemInstruction: system, abortSignal: controller.signal },
      });
      for await (const chunk of response) {
        clearTimeout(firstChunk);
        if (chunk.text) yield chunk.text;
      }
    } finally {
      clearTimeout(total);
      clearTimeout(firstChunk);
    }
  }

  return {
    async json<T>(o: {
      model: 'fast' | 'main';
      system: string;
      prompt: string;
      schema: object;
    }): Promise<T> {
      const response = await client.models.generateContent({
        model: modelId(o.model),
        contents: o.prompt,
        config: {
          systemInstruction: o.system,
          responseMimeType: 'application/json',
          responseJsonSchema: o.schema,
          abortSignal: AbortSignal.timeout(JSON_TIMEOUT_MS),
        },
      });
      const text = response.text;
      if (!text) throw new Error('Gemini returned an empty response');
      return JSON.parse(text) as T;
    },

    // If the main model fails before producing any text (overload, timeout),
    // fall back to the fast model so the user still gets an answer.
    async *stream(o: { model: 'fast' | 'main'; system: string; prompt: string }) {
      let yielded = false;
      try {
        for await (const text of streamFrom(modelId(o.model), o.system, o.prompt)) {
          yielded = true;
          yield text;
        }
      } catch (error) {
        if (yielded || o.model === 'fast') throw error;
        console.error(`main model failed before first token, falling back to fast: ${String(error)}`);
        yield* streamFrom(models.fast, o.system, o.prompt);
      }
    },
  };
}
