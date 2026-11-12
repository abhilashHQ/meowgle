import { GoogleGenAI, type ThinkingConfig } from '@google/genai';
import type {
  JsonOptions,
  LLM,
  LLMStreamPart,
  Reasoning,
  StreamOptions,
} from './types.js';
import { friendlyError } from '../errors.js';

const JSON_TIMEOUT_MS = 30_000;
const FAST_JSON_TIMEOUT_MS = 8_000;
const STREAM_TOTAL_MS = 120_000;
const STREAM_IDLE_MS = 25_000;
const FIRST_EVENT_MS: Record<Reasoning, number> = {
  low: 10_000,
  medium: 15_000,
  high: 20_000,
  xhigh: 30_000,
};

const THINKING_LEVEL: Record<Reasoning, 'low' | 'medium' | 'high'> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
};

export function createGeminiLLM(
  apiKey: string,
  models: { fast: string; main: string },
): LLM {
  // The `-latest` aliases only exist on v1beta; the SDK defaults to v1.
  const client = new GoogleGenAI({ apiKey, apiVersion: 'v1beta' });
  const modelId = (tier: 'fast' | 'main') => (tier === 'fast' ? models.fast : models.main);

  async function* streamFrom(
    model: string,
    o: StreamOptions,
  ): AsyncGenerator<LLMStreamPart> {
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    if (o.signal) {
      if (o.signal.aborted) controller.abort();
      else o.signal.addEventListener('abort', forwardAbort, { once: true });
    }

    let timer = setTimeout(
      () => controller.abort(),
      o.reasoning ? FIRST_EVENT_MS[o.reasoning] : FIRST_EVENT_MS.medium,
    );
    const total = setTimeout(() => controller.abort(), STREAM_TOTAL_MS);
    const resetIdle = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), STREAM_IDLE_MS);
    };

    try {
      const response = await client.models.generateContentStream({
        model,
        contents: o.prompt,
        config: {
          systemInstruction: o.system,
          abortSignal: controller.signal,
          ...(o.reasoning
            ? {
                thinkingConfig: {
                  thinkingLevel: THINKING_LEVEL[o.reasoning],
                  includeThoughts: o.includeThoughts ?? false,
                } as unknown as ThinkingConfig,
              }
            : {}),
        },
      });

      for await (const chunk of response) {
        const parts = chunk.candidates?.[0]?.content?.parts ?? [];
        for (const part of parts) {
          if (!part.text) continue;
          resetIdle();
          yield { type: part.thought ? 'thought' : 'text', text: part.text };
        }
      }
    } finally {
      clearTimeout(timer);
      clearTimeout(total);
      o.signal?.removeEventListener('abort', forwardAbort);
    }
  }

  return {
    async json<T>(o: JsonOptions): Promise<T> {
      try {
        const response = await client.models.generateContent({
          model: modelId(o.model),
          contents: o.prompt,
          config: {
            systemInstruction: o.system,
            responseMimeType: 'application/json',
            responseJsonSchema: o.schema,
            abortSignal: AbortSignal.timeout(
              o.timeoutMs ?? (o.model === 'fast' ? FAST_JSON_TIMEOUT_MS : JSON_TIMEOUT_MS),
            ),
            ...(o.reasoning
              ? {
                  thinkingConfig: {
                    thinkingLevel: THINKING_LEVEL[o.reasoning],
                  } as unknown as ThinkingConfig,
                }
              : {}),
          },
        });
        const text = response.text;
        if (!text) throw new Error('Gemini returned an empty response');
        return JSON.parse(text) as T;
      } catch (error) {
        throw new Error(friendlyError(error));
      }
    },

    // If the main model fails before producing answer text (overload, timeout),
    // fall back to the fast model so the user still gets an answer.
    async *stream(o: StreamOptions) {
      let yieldedText = false;
      try {
        for await (const part of streamFrom(modelId(o.model), o)) {
          if (part.type === 'text') yieldedText = true;
          yield part;
        }
      } catch (error) {
        if (yieldedText || o.model === 'fast' || o.signal?.aborted) throw error;
        console.error(
          `main model failed before answer text, falling back to fast: ${friendlyError(error)}`,
        );
        yield* streamFrom(models.fast, {
          ...o,
          model: 'fast',
          reasoning: undefined,
          includeThoughts: false,
        });
      }
    },
  };
}
