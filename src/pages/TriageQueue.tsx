import { CheckCircle2, History, RefreshCw, ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { confirmSubmission, fetchQueue, fetchSubmissionDetail, overrideSubmission } from '../api';
import OverrideModal from '../components/OverrideModal';
import UrgencyBadge from '../components/UrgencyBadge';
import { FALLBACK_MODEL_NAME, type Department, type IntakeDetail, type IntakeSubmission, type UrgencyLevel } from '../../shared/types';

const STATUS_LABEL: Record<IntakeSubmission['reviewStatus'], string> = {
  pending: 'Pending review',
  reviewed: 'Confirmed',
  overridden: 'Overridden',
};

function timeAgo(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

export default function TriageQueue({ refreshKey }: { refreshKey: number }) {
  const [submissions, setSubmissions] = useState<IntakeSubmission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<IntakeDetail | null>(null);
  const [showOverride, setShowOverride] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function loadQueue() {
    setError(null);
    try {
      const { submissions } = await fetchQueue();
      setSubmissions(submissions);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load the queue.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadQueue();
  }, [refreshKey]);

  useEffect(() => {
    setActionError(null);
    setShowOverride(false);
    if (!selectedId) {
      setDetail(null);
      return;
    }
    // Ignore a slow response for a row the user has already clicked away from,
    // so the sidebar can never show one patient's data under another's name.
    let stale = false;
    setDetail(null);
    fetchSubmissionDetail(selectedId)
      .then(({ detail }) => {
        if (!stale) setDetail(detail);
      })
      .catch((err) => {
        if (!stale) setActionError(err instanceof Error ? err.message : 'Failed to load detail.');
      });
    return () => {
      stale = true;
    };
  }, [selectedId]);

  /** Re-syncs the list and sidebar after a change. Never throws: the change itself already succeeded. */
  async function refreshAfterChange(id: string) {
    await loadQueue();
    try {
      const { detail } = await fetchSubmissionDetail(id);
      setDetail(detail);
    } catch {
      setActionError('Your change was saved, but the latest details could not be loaded. Press Refresh.');
    }
  }

  async function handleConfirm() {
    if (!selectedId) return;
    setActionError(null);
    try {
      await confirmSubmission(selectedId);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to confirm.');
      return;
    }
    await refreshAfterChange(selectedId);
  }

  async function handleOverride(payload: { newUrgencyLevel: UrgencyLevel; newDepartment: Department; reason: string }) {
    if (!selectedId) return;
    // If this throws, the modal shows the error and stays open (nothing was saved).
    await overrideSubmission(selectedId, payload);
    setShowOverride(false);
    await refreshAfterChange(selectedId);
  }

  const selected = submissions.find((s) => s.id === selectedId) ?? null;

  return (
    <div className="mx-auto flex max-w-5xl gap-6 px-4 py-8 sm:px-6">
      <div className="flex-1">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold text-slate-900">Triage Queue</h1>
          <button
            onClick={loadQueue}
            className="flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        {/* the sidebar (which normally shows action errors) isn't rendered until detail loads */}
        {selectedId && !detail && actionError && <p className="mt-3 text-sm text-red-600">{actionError}</p>}
        {loading && <p className="mt-3 text-sm text-slate-500">Loading…</p>}

        {!loading && submissions.length === 0 && (
          <p className="mt-6 rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
            No intake submissions yet.
          </p>
        )}

        <div className="mt-4 space-y-2">
          {submissions.map((s) => (
            <button
              key={s.id}
              onClick={() => setSelectedId(s.id)}
              className={`flex w-full items-center gap-3 rounded-lg border bg-white p-3 text-left shadow-sm transition-colors hover:border-sky-300 ${
                selectedId === s.id ? 'border-sky-400 ring-1 ring-sky-400' : 'border-slate-200'
              }`}
            >
              <UrgencyBadge level={s.finalUrgencyLevel} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-900">{s.patientName}</p>
                <p className="truncate text-xs text-slate-500">
                  {s.finalDepartment} · {timeAgo(s.submittedAt)}
                </p>
              </div>
              {s.needsHumanReview && s.reviewStatus === 'pending' && (
                <span className="flex items-center gap-1 rounded-full bg-amber-50 px-2 py-1 text-xs font-medium text-amber-700 ring-1 ring-inset ring-amber-600/20">
                  <ShieldAlert className="h-3 w-3" />
                  Review required
                </span>
              )}
              {s.reviewStatus !== 'pending' && (
                <span className="flex items-center gap-1 rounded-full bg-slate-100 px-2 py-1 text-xs font-medium text-slate-600">
                  <CheckCircle2 className="h-3 w-3" />
                  {STATUS_LABEL[s.reviewStatus]}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {selected && detail && (
        <aside className="w-80 flex-shrink-0 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900">{selected.patientName}</h2>
          <p className="text-xs text-slate-500">{selected.contactPhone || 'No phone on file'}</p>

          <div className="mt-3 flex items-center gap-2">
            <UrgencyBadge level={selected.finalUrgencyLevel} />
            <span className="text-sm text-slate-700">{selected.finalDepartment}</span>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            AI confidence: {Math.round(selected.confidenceScore * 100)}%
            {selected.needsHumanReview && ' · below review threshold'}
          </p>

          {detail.classificationHistory[0]?.modelName === FALLBACK_MODEL_NAME && (
            <p className="mt-2 flex items-start gap-1 rounded-md bg-red-50 p-2 text-xs text-red-700 ring-1 ring-inset ring-red-600/20">
              <ShieldAlert className="mt-0.5 h-3 w-3 flex-shrink-0" />
              AI classification was unavailable for this intake — High urgency is a precaution. Triage manually.
            </p>
          )}

          {actionError && <p className="mt-2 text-xs text-red-600">{actionError}</p>}

          {selected.reviewStatus === 'pending' && (
            <div className="mt-4 space-y-2 border-t border-slate-100 pt-3">
              <button
                onClick={handleConfirm}
                className="w-full rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
              >
                Confirm classification
              </button>
              <button
                onClick={() => setShowOverride(true)}
                className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Override…
              </button>
            </div>
          )}

          {selected.reviewStatus !== 'pending' && (
            <button
              onClick={() => setShowOverride(true)}
              className="mt-4 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Override…
            </button>
          )}

          {detail.overrideLogs.length > 0 && (
            <div className="mt-4 border-t border-slate-100 pt-3">
              <p className="flex items-center gap-1 text-xs font-semibold text-slate-600">
                <History className="h-3.5 w-3.5" />
                Override history
              </p>
              <ul className="mt-2 space-y-2">
                {detail.overrideLogs.map((log) => (
                  <li key={log.id} className="rounded-md bg-slate-50 p-2 text-xs text-slate-600">
                    <p>
                      <strong>{log.previousUrgencyLevel} → {log.newUrgencyLevel}</strong> by {log.overriddenBy}
                    </p>
                    <p className="mt-0.5 text-slate-500">{log.reason}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>
      )}

      {showOverride && selected && (
        <OverrideModal submission={selected} onClose={() => setShowOverride(false)} onSubmit={handleOverride} />
      )}
    </div>
  );
}
