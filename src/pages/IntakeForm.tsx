import { CheckCircle2, Loader2, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { submitIntake } from '../api';
import UrgencyBadge from '../components/UrgencyBadge';
import type { IntakeSubmission } from '../../shared/types';

export default function IntakeForm({ onSubmitted }: { onSubmitted: () => void }) {
  const [patientName, setPatientName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [symptomText, setSymptomText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<IntakeSubmission | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { submission } = await submitIntake({ patientName, contactPhone: contactPhone || undefined, symptomText });
      setResult(submission);
      setPatientName('');
      setContactPhone('');
      setSymptomText('');
      onSubmitted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
      <h1 className="text-lg font-semibold text-slate-900">Patient Symptom Intake</h1>
      <p className="mt-1 text-sm text-slate-500">
        Describe what the patient tells you in their own words. This is used once to suggest an urgency level and
        department, then discarded — it is never stored.
      </p>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div>
          <label className="block text-sm font-medium text-slate-700">Patient name</label>
          <input
            required
            value={patientName}
            onChange={(e) => setPatientName(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
            placeholder="Jane Doe"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700">Contact phone (optional)</label>
          <input
            value={contactPhone}
            onChange={(e) => setContactPhone(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
            placeholder="(555) 555-0100"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-slate-700">Symptoms, in the patient's own words</label>
          <textarea
            required
            minLength={3}
            rows={5}
            value={symptomText}
            onChange={(e) => setSymptomText(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
            placeholder="e.g. Sharp pain in my lower right side that started this morning, feels worse when I press on it..."
          />
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={submitting}
          className="flex w-full items-center justify-center gap-2 rounded-md bg-sky-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-sky-700 disabled:opacity-60"
        >
          {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
          {submitting ? 'Classifying…' : 'Submit intake'}
        </button>
      </form>

      {result && (
        <div className="mt-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-emerald-600" />
            <h2 className="text-sm font-semibold text-slate-900">Added to the triage queue</h2>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
            <UrgencyBadge level={result.finalUrgencyLevel} />
            <span className="text-slate-700">{result.finalDepartment}</span>
            <span className="text-slate-400">·</span>
            <span className="text-slate-500">{Math.round(result.confidenceScore * 100)}% confidence</span>
          </div>
          {result.needsHumanReview && (
            <div className="mt-3 flex items-start gap-2 rounded-md bg-amber-50 p-3 text-sm text-amber-800 ring-1 ring-inset ring-amber-600/20">
              <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <p>
                Confidence was below the review threshold, so this case is flagged for <strong>mandatory human
                review</strong> and will not be auto-routed. A staff member must confirm or override it from the
                Triage Queue.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
