import { Loader2, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { DEPARTMENTS, URGENCY_LEVELS, type Department, type IntakeSubmission, type UrgencyLevel } from '../../shared/types';
import { LIMITS } from '../../shared/validation';
import { URGENCY_LABEL } from '../lib/format';
import { FIELD, LABEL, PRIMARY_BUTTON } from '../ui';

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal dialog for overriding a classification.
 *
 * Keyboard behaviour: focus moves into the dialog when it opens, Tab / Shift+Tab cycle inside it
 * (they can't reach the page behind), and Escape cancels. The parent decides where focus goes
 * afterwards (back to the button that opened it on cancel, or to the case after a save).
 */
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

  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLSelectElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const ids = { title: useId(), current: useId(), urgency: useId(), department: useId(), reason: useId(), reasonHint: useId(), error: useId() };

  useEffect(() => {
    firstFieldRef.current?.focus();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    if (!reason.trim()) {
      setError('A reason is required.');
      reasonRef.current?.focus();
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

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !dialogRef.current) return;

    const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    const inside = active instanceof Node && dialogRef.current.contains(active);

    if (e.shiftKey && (active === first || !inside)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !inside)) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4" onKeyDown={handleKeyDown}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={ids.title}
        aria-describedby={ids.current}
        className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl"
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id={ids.title} className="text-base font-semibold text-slate-900">
            Override classification — {submission.patientName}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog without saving"
            className="-m-1.5 rounded-md p-1.5 text-slate-700 hover:bg-slate-100 hover:text-slate-900"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        <p id={ids.current} className="mt-1 text-sm text-slate-700">
          Currently {URGENCY_LABEL[submission.finalUrgencyLevel]} urgency, {submission.finalDepartment}. Your change is
          recorded under your signed-in account.
        </p>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div>
            <label htmlFor={ids.urgency} className={LABEL}>Urgency level</label>
            <select
              id={ids.urgency}
              ref={firstFieldRef}
              value={newUrgencyLevel}
              onChange={(e) => setNewUrgencyLevel(e.target.value as UrgencyLevel)}
              className={FIELD}
            >
              {URGENCY_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {URGENCY_LABEL[level]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor={ids.department} className={LABEL}>Department</label>
            <select
              id={ids.department}
              value={newDepartment}
              onChange={(e) => setNewDepartment(e.target.value as Department)}
              className={FIELD}
            >
              {DEPARTMENTS.map((dept) => (
                <option key={dept} value={dept}>
                  {dept}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor={ids.reason} className={LABEL}>
              Reason for override <span className="font-normal text-slate-700">(required)</span>
            </label>
            <textarea
              id={ids.reason}
              ref={reasonRef}
              required
              aria-required="true"
              aria-invalid={error === 'A reason is required.' ? true : undefined}
              aria-describedby={`${ids.reasonHint} ${ids.error}`}
              rows={3}
              maxLength={LIMITS.reason}
              autoComplete="off"
              spellCheck={false}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className={FIELD}
              placeholder="e.g. Patient's vitals on arrival indicate higher urgency than the intake text suggested."
            />
            <p id={ids.reasonHint} className="mt-1 text-xs text-slate-700">
              Up to {LIMITS.reason.toLocaleString()} characters. Kept in the audit trail.
            </p>
          </div>

          <div role="alert" id={ids.error}>
            {error && <p className="text-sm font-medium text-red-700">{error}</p>}
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onClose} className="rounded-md px-3 py-2 text-sm font-medium text-slate-800 hover:bg-slate-100">
              Cancel
            </button>
            <button type="submit" aria-disabled={submitting} className={PRIMARY_BUTTON}>
              {submitting && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
              {submitting ? 'Saving…' : 'Save override'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
