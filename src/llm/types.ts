export type Reasoning = 'low' | 'medium' | 'high' | 'xhigh';

export type JsonOptions = {
  model: 'fast' | 'main';
  system: string;
  prompt: string;
  schema: object;
  reasoning?: Reasoning;
  timeoutMs?: number;
};

export type StreamOptions = {
  model: 'fast' | 'main';
  system: string;
  prompt: string;
  reasoning?: Reasoning;
  includeThoughts?: boolean;
  signal?: AbortSignal;
};

export type LLMStreamPart = {
  type: 'thought' | 'text';
  text: string;
};

export interface LLM {
  json<T>(o: JsonOptions): Promise<T>;
  stream(o: StreamOptions): AsyncIterable<LLMStreamPart>;
}
