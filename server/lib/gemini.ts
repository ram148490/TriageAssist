import { GoogleGenAI } from '@google/genai';

const isProduction = () => process.env.NODE_ENV === 'production';

/**
 * Patient symptom text is health information, and it is sent to Google for
 * classification. Google's terms for the UNPAID Gemini API say submitted content
 * is used to improve Google products, may be read by human reviewers, and must not
 * include personal or sensitive information. The PAID terms do not use prompts to
 * improve products. We can't tell which tier a key is on, so in production the
 * operator must explicitly confirm a paid-tier key before any patient text is sent;
 * otherwise the AI is disabled and every case takes the safe manual-review path.
 */
export function geminiDataTermsConfirmed(): boolean {
  return process.env.GEMINI_PAID_TIER_CONFIRMED === 'true';
}

/** Returns a configured Gemini client, or `null` when AI classification must not be used. */
export const getGeminiClient = (): GoogleGenAI | null => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return null;
  }
  if (isProduction() && !geminiDataTermsConfirmed()) {
    return null;
  }
  return new GoogleGenAI({ apiKey });
};

/** One-time startup notice about where patient text goes. */
export function warnAboutGeminiDataHandling(): void {
  if (!process.env.GEMINI_API_KEY) return;
  if (isProduction() && !geminiDataTermsConfirmed()) {
    console.warn(
      '[privacy] GEMINI_API_KEY is set but GEMINI_PAID_TIER_CONFIRMED is not "true": AI classification is DISABLED in production ' +
        'and every intake will use the manual-review fail-safe. Use a paid-tier key (prompts are not used to improve Google products) ' +
        'and set GEMINI_PAID_TIER_CONFIRMED=true to enable it.',
    );
  } else if (!geminiDataTermsConfirmed()) {
    console.warn(
      '[privacy] Symptom text is sent to Google Gemini. On the free tier Google may use it to improve its products and have humans review it. ' +
        'Use synthetic data only unless this is a paid-tier key (then set GEMINI_PAID_TIER_CONFIRMED=true).',
    );
  }
}

/** Model used for every server-side classification call. */
export const GEMINI_MODEL = 'gemini-3.6-flash';
