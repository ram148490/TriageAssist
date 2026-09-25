import { X } from 'lucide-react';
import { useState } from 'react';
import { DEPARTMENTS, URGENCY_LEVELS, type Department, type IntakeSubmission, type UrgencyLevel } from '../../shared/types';
import { LIMITS } from '../../shared/validation';

export default function OverrideModal({
  submission,
  onClose,
  onSubmit,
}: {
  submission: IntakeSubmission;
  onClose: () => void;
  onSubmit: (payload: { newUrgencyLevel: UrgencyLevel; newDepartment: Department; reason: string }) => Promise<void>;
}) {
  const [newUrgencyLevel, setNewUrgencyLevel] = useState<UrgencyLevel>(submission.finalUrgencyLevel);
  const [newDepartment, setNewDepartment] = useState<Department>(submission.finalDepartment);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!reason.trim()) {
      setError('A reason is required.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit({ newUrgencyLevel, newDepartment, reason: reason.trim() });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save override.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4">
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">Override classification — {submission.patientName}</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700">Urgency level</label>
            <select
              value={newUrgencyLevel}
              onChange={(e) => setNewUrgencyLevel(e.target.value as UrgencyLevel)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            >
              {URGENCY_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700">Department</label>
            <select
              value={newDepartment}
              onChange={(e) => setNewDepartment(e.target.value as Department)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            >
              {DEPARTMENTS.map((dept) => (
                <option key={dept} value={dept}>
                  {dept}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700">Reason for override (required)</label>
            <textarea
              required
              rows={3}
              maxLength={LIMITS.reason}
              autoComplete="off"
              spellCheck={false}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              placeholder="e.g. Patient's vitals on arrival indicate higher urgency than the intake text suggested."
            />
          </div>

          <p className="text-xs text-slate-500">This override is recorded under your signed-in account.</p>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="rounded-md px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100">
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-md bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-700 disabled:opacity-60"
            >
              {submitting ? 'Saving…' : 'Save override'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
