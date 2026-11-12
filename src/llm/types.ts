export interface LLM {
  json<T>(o: {
    model: 'fast' | 'main';
    system: string;
    prompt: string;
    schema: object;
  }): Promise<T>;
  stream(o: { model: 'fast' | 'main'; system: string; prompt: string }): AsyncIterable<string>;
}