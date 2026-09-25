import { CheckCircle2, Loader2, ShieldAlert } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { submitIntake } from '../api';
import UrgencyBadge from '../components/UrgencyBadge';
import { URGENCY_LABEL } from '../lib/format';
import { FIELD, LABEL, PRIMARY_BUTTON } from '../ui';
import type { IntakeSubmission } from '../../shared/types';
import { LIMITS } from '../../shared/validation';

export default function IntakeForm({ onSubmitted }: { onSubmitted: (submission: IntakeSubmission) => void }) {
  const [patientName, setPatientName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [symptomText, setSymptomText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<IntakeSubmission | null>(null);
  const [classificationUnavailable, setClassificationUnavailable] = useState(false);
  const ids = { name: useId(), phone: useId(), symptoms: useId(), symptomsHint: useId(), phoneHint: useId(), error: useId(), intro: useId() };

  useEffect(() => {
    document.title = 'New intake — TriageAssist';
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return; // aria-disabled (not `disabled`) keeps keyboard focus on the button
    setError(null);
    setResult(null);
    setSubmitting(true);
    try {
      const { submission, classificationUnavailable } = await submitIntake({
        patientName,
        contactPhone: contactPhone || undefined,
        symptomText,
      });
      setResult(submission);
      setClassificationUnavailable(classificationUnavailable);
      setPatientName('');
      setContactPhone('');
      setSymptomText('');
      onSubmitted(submission);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setSubmitting(false);
    }
  }

  // A high-urgency or fail-safe result is time-critical: announce it assertively. Everything else politely.
  const urgent = !!result && (result.finalUrgencyLevel === 'high' || classificationUnavailable);
  const card = result && (
    <section aria-labelledby={`${ids.error}-result`} className="mt-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center gap-2">
        <CheckCircle2 className="h-5 w-5 text-emerald-700" aria-hidden="true" />
        <h2 id={`${ids.error}-result`} className="text-sm font-semibold text-slate-900">Added to the triage queue</h2>
      </div>
      <p className="mt-3 flex flex-wrap items-center gap-3 text-sm">
        <UrgencyBadge level={result.finalUrgencyLevel} />
        <span className="text-slate-800">
          <span className="sr-only">Department: </span>
          {result.finalDepartment}
        </span>
        <span className="text-slate-600" aria-hidden="true">·</span>
        <span className="text-slate-700">
          {classificationUnavailable ? 'AI unavailable' : `${Math.round(result.confidenceScore * 100)}% confidence`}
        </span>
      </p>
      {classificationUnavailable && (
        <div className="mt-3 flex items-start gap-2 rounded-md bg-red-50 p-3 text-sm text-red-800 ring-1 ring-inset ring-red-700/30">
          <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
          <p>
            The AI classifier was <strong>unavailable</strong> (it failed or timed out), so this patient was set to{' '}
            <strong>{URGENCY_LABEL.high} urgency</strong> as a precaution and needs <strong>manual triage</strong>. A staff
            member must confirm or override it from the Triage Queue.
          </p>
        </div>
      )}
      {!classificationUnavailable && result.needsHumanReview && (
        <div className="mt-3 flex items-start gap-2 rounded-md bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-inset ring-amber-700/30">
          <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
          <p>
            Confidence was below the review threshold, so this case is flagged for <strong>mandatory human
            review</strong> and will not be auto-routed. A staff member must confirm or override it from the
            Triage Queue.
          </p>
        </div>
      )}
    </section>
  );

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
      <h1 id="page-heading" tabIndex={-1} className="text-lg font-semibold text-slate-900">Patient Symptom Intake</h1>
      <p id={ids.intro} className="mt-1 text-sm text-slate-700">
        Describe what the patient tells you in their own words. It is sent to an AI service once to suggest an
        urgency level and department, and TriageAssist does not store it. Do not type the patient's name or other
        identifying details here.
      </p>

      <form onSubmit={handleSubmit} aria-labelledby="page-heading" className="mt-6 space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div>
          <label htmlFor={ids.name} className={LABEL}>
            Patient name <span className="font-normal text-slate-700">(required)</span>
          </label>
          <input
            id={ids.name}
            required
            maxLength={LIMITS.patientName}
            autoComplete="off"
            value={patientName}
            onChange={(e) => setPatientName(e.target.value)}
            className={FIELD}
            placeholder="Jane Doe"
          />
        </div>

        <div>
          <label htmlFor={ids.phone} className={LABEL}>
            Contact phone <span className="font-normal text-slate-700">(optional)</span>
          </label>
          <input
            id={ids.phone}
            type="tel"
            maxLength={LIMITS.contactPhone}
            autoComplete="off"
            value={contactPhone}
            onChange={(e) => setContactPhone(e.target.value)}
            aria-describedby={ids.phoneHint}
            className={FIELD}
            placeholder="(555) 555-0100"
          />
          <p id={ids.phoneHint} className="mt-1 text-xs text-slate-700">Digits, spaces and + ( ) - . x #</p>
        </div>

        <div>
          <label htmlFor={ids.symptoms} className={LABEL}>
            Symptoms, in the patient's own words <span className="font-normal text-slate-700">(required)</span>
          </label>
          <textarea
            id={ids.symptoms}
            required
            minLength={3}
            maxLength={LIMITS.symptomText}
            autoComplete="off"
            spellCheck={false}
            rows={5}
            value={symptomText}
            onChange={(e) => setSymptomText(e.target.value)}
            aria-describedby={ids.symptomsHint}
            className={FIELD}
            placeholder="e.g. Sharp pain in my lower right side that started this morning, feels worse when I press on it..."
          />
          <p id={ids.symptomsHint} className="mt-1 text-xs text-slate-700">
            Up to {LIMITS.symptomText.toLocaleString()} characters. Do not include the patient's name.
          </p>
        </div>

        {/* Always mounted so the announcement is reliable; empty when there is no error. */}
        <div role="alert" id={ids.error}>
          {error && <p className="text-sm font-medium text-red-700">{error}</p>}
        </div>

        <button type="submit" aria-disabled={submitting} className={`${PRIMARY_BUTTON} w-full`}>
          {submitting && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
          {submitting ? 'Classifying…' : 'Submit intake'}
        </button>
        <p role="status" className="sr-only">{submitting ? 'Classifying the intake. Please wait.' : ''}</p>
      </form>

      {/* Both containers are always mounted; the result goes in the assertive one when it is urgent. */}
      <div role="alert">{urgent && card}</div>
      <div role="status">{!urgent && card}</div>
    </div>
  );
}
