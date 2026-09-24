import { Type } from '@google/genai';
import { DEPARTMENTS, URGENCY_LEVELS, type ClassificationResult } from '../../shared/types';
import { GEMINI_MODEL, getGeminiClient } from './gemini';

export const PROMPT_VERSION = 'triage-classify-v1';

const SYSTEM_INSTRUCTION = `You are a front-desk intake triage classifier for Meridian Urgent Care, an independent urgent care clinic.

You are NOT a diagnostic tool and you do not provide medical advice. Your only job is to help non-clinical front-desk staff sort the order in which patients are SEEN, from the patient's own free-text description of their symptoms.

Classify the intake into:
- urgencyLevel: "high" (needs to be seen immediately — signs of a potentially serious or rapidly worsening condition, e.g. chest pain, difficulty breathing, severe bleeding, stroke-like symptoms, high fever in an infant), "medium" (should be seen soon, within the normal queue, not an emergency), or "low" (minor, stable, can reasonably wait).
- suggestedDepartment: exactly one of ${JSON.stringify(DEPARTMENTS)}. Use "Refer to Emergency Room" for anything that sounds like it belongs in an ER rather than urgent care.
- confidenceScore: your confidence in this classification, from 0 to 1. Be honest and conservative — use a LOW score whenever the text is vague, ambiguous, contradictory, too short to assess, or describes multiple unrelated symptoms. A low score is expected and safe; it simply routes the case to a human for review.

Bias toward safety: if symptoms could plausibly indicate something serious, prefer the higher urgency level and/or a lower confidence score rather than guessing reassuringly. When genuinely uncertain, lower the confidence score rather than picking an urgency level you are not sure about.

Return ONLY the structured JSON described by the response schema. Do not include any explanation, diagnosis, or treatment suggestion.`;

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    urgencyLevel: { type: Type.STRING, enum: [...URGENCY_LEVELS] },
    suggestedDepartment: { type: Type.STRING, enum: [...DEPARTMENTS] },
    confidenceScore: { type: Type.NUMBER },
  },
  required: ['urgencyLevel', 'suggestedDepartment', 'confidenceScore'],
};

/**
 * Fallback used whenever the AI call cannot be trusted (no API key configured,
 * request failure, or a malformed response). Confidence is pinned to 0 so this
 * always triggers mandatory human review — the app never silently auto-routes
 * a patient it failed to classify.
 */
function unavailableFallback(): ClassificationResult {
  return {
    urgencyLevel: 'medium',
    suggestedDepartment: 'General Urgent Care',
    confidenceScore: 0,
    modelName: 'unavailable-fallback',
    promptVersion: PROMPT_VERSION,
  };
}

export async function classifySymptoms(symptomText: string): Promise<ClassificationResult> {
  const ai = getGeminiClient();
  if (!ai) {
    return unavailableFallback();
  }

  try {
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: symptomText,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
        temperature: 0.1,
      },
    });

    const parsed = JSON.parse(response.text || '{}');

    if (
      !URGENCY_LEVELS.includes(parsed.urgencyLevel) ||
      !DEPARTMENTS.includes(parsed.suggestedDepartment) ||
      typeof parsed.confidenceScore !== 'number'
    ) {
      return unavailableFallback();
    }

    return {
      urgencyLevel: parsed.urgencyLevel,
      suggestedDepartment: parsed.suggestedDepartment,
      confidenceScore: Math.max(0, Math.min(1, parsed.confidenceScore)),
      modelName: GEMINI_MODEL,
      promptVersion: PROMPT_VERSION,
    };
  } catch (error) {
    console.error('Classification call failed:', error);
    return unavailableFallback();
  }
}
