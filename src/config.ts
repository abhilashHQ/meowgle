import 'dotenv/config';

export type Config = {
  geminiApiKey: string;
  exaApiKey: string;
  fastModel: string;
  mainModel: string;
  port: number;
  dbPath: string;
  fakeNow: string | null;
};

export const config: Config = {
  geminiApiKey: process.env.GEMINI_API_KEY ?? '',
  exaApiKey: process.env.EXA_API_KEY ?? '',
  fastModel: process.env.GEMINI_FAST_MODEL || 'gemini-3.1-flash-lite',
  mainModel: process.env.GEMINI_MAIN_MODEL || 'gemini-3.6-flash',
  port: Number(process.env.PORT || 3000),
  dbPath: process.env.DB_PATH || 'data/minimi.db',
  fakeNow: process.env.FAKE_NOW || null,
};