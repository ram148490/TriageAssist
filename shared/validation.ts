/** Input limits shared by the API (enforcement) and the forms (maxLength hints). */
export const LIMITS = {
  patientName: 100,
  contactPhone: 30,
  symptomText: 2000,
  reason: 1000,
} as const;

// Control characters (other than tab/newline/CR in free text) have no business in
// these fields and can corrupt logs, terminals and Postgres text columns (NUL).
const FREE_TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const SINGLE_LINE_CONTROL = /[\u0000-\u001f\u007f]/;
const PHONE = /^[0-9+()\-.\sx#]{3,30}$/i;

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string) => ({ ok: false as const, error });

export function validateIntake(input: {
  patientName?: unknown;
  contactPhone?: unknown;
  symptomText?: unknown;
}): Validated<{ patientName: string; contactPhone: string | null; symptomText: string }> {
  const patientName = typeof input.patientName === 'string' ? input.patientName.trim() : '';
  if (!patientName) return fail('patientName is required.');
  if (patientName.length > LIMITS.patientName) return fail(`patientName must be at most ${LIMITS.patientName} characters.`);
  if (SINGLE_LINE_CONTROL.test(patientName)) return fail('patientName contains invalid characters.');

  const symptomText = typeof input.symptomText === 'string' ? input.symptomText.trim() : '';
  if (symptomText.length < 3) return fail('symptomText is required.');
  if (symptomText.length > LIMITS.symptomText) return fail(`symptomText must be at most ${LIMITS.symptomText} characters.`);
  if (FREE_TEXT_CONTROL.test(symptomText)) return fail('symptomText contains invalid characters.');

  let contactPhone: string | null = null;
  if (input.contactPhone !== undefined && input.contactPhone !== null) {
    if (typeof input.contactPhone !== 'string') return fail('contactPhone must be a string.');
    const phone = input.contactPhone.trim();
    if (phone) {
      if (!PHONE.test(phone)) return fail('contactPhone must be 3-30 characters: digits, spaces and + ( ) - . x #.');
      contactPhone = phone;
    }
  }

  return { ok: true, value: { patientName, contactPhone, symptomText } };
}

export function validateReason(reason: unknown): Validated<string> {
  const value = typeof reason === 'string' ? reason.trim() : '';
  if (!value) return fail('A reason is required to override a classification.');
  if (value.length > LIMITS.reason) return fail(`reason must be at most ${LIMITS.reason} characters.`);
  if (FREE_TEXT_CONTROL.test(value)) return fail('reason contains invalid characters.');
  return { ok: true, value };
}
