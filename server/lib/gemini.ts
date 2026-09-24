import { GoogleGenAI } from '@google/genai';

/** Returns a configured Gemini client, or `null` when no API key is present. */
export const getGeminiClient = (): GoogleGenAI | null => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return null;
  }
  return new GoogleGenAI({ apiKey });
};

/** Model used for every server-side classification call. */
export const GEMINI_MODEL = 'gemini-3.6-flash';
