import { CheckCircle2, History, Loader2, RefreshCw, ShieldAlert, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { confirmSubmission, fetchSubmissionDetail, overrideSubmission } from '../api';
import OverrideModal from '../components/OverrideModal';
import UrgencyBadge from '../components/UrgencyBadge';
import type { QueueState } from '../hooks/useQueue';
import { timeAgo, URGENCY_LABEL } from '../lib/format';
import { SECONDARY_BUTTON } from '../ui';
import { FALLBACK_MODEL_NAME, type Department, type IntakeDetail, type IntakeSubmission, type UrgencyLevel } from '../../shared/types';

const STATUS_LABEL: Record<IntakeSubmission['reviewStatus'], string> = {
  pending: 'Pending review',
  reviewed: 'Confirmed',
  overridden: 'Overridden',
};

/** The accessible name of a queue row: everything a sighted user gets at a glance, in reading order. */
function rowLabel(s: IntakeSubmission): string {
  const status = s.reviewStatus === 'pending' ? (s.needsHumanReview ? 'Review required' : 'Pending review') : STATUS_LABEL[s.reviewStatus];
  return `${URGENCY_LABEL[s.finalUrgencyLevel]} urgency, ${s.patientName}, ${s.finalDepartment}, ${timeAgo(s.submittedAt)}, ${status}`;
}

export default function TriageQueue({
  queue,
  focusCaseId,
  onFocusHandled,
}: {
  queue: QueueState;
  /** When set, open this case and put keyboard focus on its row (from the "new high-urgency case" banner). */
  focusCaseId: string | null;
  onFocusHandled: () => void;
}) {
  const { submissions, loading, error } = queue;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<IntakeDetail | null>(null);
  const [showOverride, setShowOverride] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Polite live-region text: results of refreshes and actions. */
  const [status, setStatus] = useState('');

  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const overrideOpenerRef = useRef<HTMLElement | null>(null);
  /** True when the user just chose a case and expects focus to move to its details once loaded. */
  const focusDetailWhenLoaded = useRef(false);

  useEffect(() => {
    document.title = 'Triage queue — TriageAssist';
  }, []);

  // Load the details of the selected case.
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

  // Details have arrived after the user picked a case: move focus to them.
  useEffect(() => {
    if (detail && focusDetailWhenLoaded.current) {
      focusDetailWhenLoaded.current = false;
      detailHeadingRef.current?.focus();
    }
  }, [detail]);

  // Someone else changed the open case (seen through the background poll): refresh its details
  // quietly, without moving focus, so nobody acts on a stale "Confirm" button.
  const selected = submissions.find((s) => s.id === selectedId) ?? null;
  const selectedUpdatedAt = selected?.updatedAt;
  useEffect(() => {
    if (!selectedId || !detail || !selectedUpdatedAt || detail.submission.updatedAt === selectedUpdatedAt) return;
    let stale = false;
    fetchSubmissionDetail(selectedId)
      .then(({ detail: fresh }) => {
        if (stale) return;
        setDetail(fresh);
        setStatus('This case was just updated by someone else. The details on screen have been refreshed.');
      })
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [selectedId, selectedUpdatedAt, detail]);

  // Arrived from the "new high-urgency case" banner: open the case and put focus on its row.
  useEffect(() => {
    if (!focusCaseId || !submissions.some((s) => s.id === focusCaseId)) return;
    setSelectedId(focusCaseId);
    rowRefs.current.get(focusCaseId)?.focus();
    onFocusHandled();
  }, [focusCaseId, submissions, onFocusHandled]);

  function selectCase(id: string) {
    if (id === selectedId && detail) {
      detailHeadingRef.current?.focus();
      return;
    }
    focusDetailWhenLoaded.current = true;
    setSelectedId(id);
  }

  function closeDetail() {
    // Return focus to the row the user came from before the details disappear.
    if (selectedId) rowRefs.current.get(selectedId)?.focus();
    focusDetailWhenLoaded.current = false;
    setSelectedId(null);
  }

  async function handleRefresh() {
    const list = await queue.refresh();
    setStatus(list ? `Queue refreshed. ${list.length} ${list.length === 1 ? 'case' : 'cases'}.` : 'Could not refresh the queue.');
  }

  /** Re-syncs the details after a change. Never throws: the change itself already succeeded. */
  async function refreshAfterChange(id: string) {
    await queue.refresh();
    try {
      const { detail } = await fetchSubmissionDetail(id);
      setDetail(detail);
    } catch {
      setActionError('Your change was saved, but the latest details could not be loaded. Press Refresh.');
    }
  }

  async function handleConfirm() {
    if (!selectedId || busy) return;
    setActionError(null);
    setBusy(true);
    try {
      await confirmSubmission(selectedId);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to confirm.');
      setBusy(false);
      return;
    }
    setStatus('Classification confirmed. This case no longer needs review.');
    await refreshAfterChange(selectedId);
    setBusy(false);
    // The Confirm button has just been removed from the page: don't leave focus stranded on <body>.
    detailHeadingRef.current?.focus();
  }

  function openOverride() {
    overrideOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setShowOverride(true);
  }

  function cancelOverride() {
    setShowOverride(false);
    const opener = overrideOpenerRef.current;
    // Give focus back to the button that opened the dialog (or, if it is gone, to the case).
    (opener && opener.isConnected ? opener : detailHeadingRef.current)?.focus();
  }

  async function handleOverride(payload: { newUrgencyLevel: UrgencyLevel; newDepartment: Department; reason: string }) {
    if (!selectedId) return;
    // If this throws, the dialog shows the error and stays open (nothing was saved).
    await overrideSubmission(selectedId, payload);
    // The user made this change themselves: don't also announce it as a "new high-urgency case".
    queue.acknowledge(selectedId);
    setShowOverride(false);
    setStatus(`Override saved. Now ${URGENCY_LABEL[payload.newUrgencyLevel]} urgency, ${payload.newDepartment}.`);
    await refreshAfterChange(selectedId);
    detailHeadingRef.current?.focus();
  }

  const highPending = submissions.filter((s) => s.finalUrgencyLevel === 'high' && s.reviewStatus === 'pending').length;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6 lg:flex-row">
      <div className="flex-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 id="page-heading" tabIndex={-1} className="text-lg font-semibold text-slate-900">Triage Queue</h1>
          <div className="flex items-center gap-3">
            {queue.lastUpdated && (
              <span className="text-xs text-slate-700">Updated {queue.lastUpdated.toLocaleTimeString()}</span>
            )}
            <button onClick={handleRefresh} className={`${SECONDARY_BUTTON} flex items-center gap-1.5`}>
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              Refresh
            </button>
          </div>
        </div>

        {/* Polite announcements: refresh results and the outcome of confirm/override. Always mounted. */}
        <div role="status" className="sr-only">{status}</div>

        <div role="alert">{error && <p className="mt-3 text-sm font-medium text-red-700">{error}</p>}</div>
        {/* the sidebar (which normally shows action errors) isn't rendered until detail loads */}
        <div role="alert">
          {selectedId && !detail && actionError && <p className="mt-3 text-sm font-medium text-red-700">{actionError}</p>}
        </div>
        {selectedId && !detail && !actionError && (
          <p role="status" className="mt-3 flex items-center gap-2 text-sm text-slate-700">
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            Loading case details…
          </p>
        )}
        {loading && (
          <p role="status" className="mt-3 text-sm text-slate-700">Loading the queue…</p>
        )}

        {!loading && submissions.length === 0 && (
          <p className="mt-6 rounded-lg border border-dashed border-slate-400 p-6 text-center text-sm text-slate-700">
            No intake submissions yet.
          </p>
        )}

        {submissions.length > 0 && (
          <>
            <p id="queue-summary" className="mt-3 text-sm text-slate-700">
              {submissions.length} {submissions.length === 1 ? 'case' : 'cases'}, most urgent first.{' '}
              <strong className="font-semibold text-slate-900">
                {highPending} high urgency awaiting review.
              </strong>
            </p>
            <ul aria-label="Cases, most urgent first" aria-describedby="queue-summary" className="mt-3 space-y-2">
              {submissions.map((s) => (
                <li key={s.id}>
                  <button
                    ref={(el) => {
                      if (el) rowRefs.current.set(s.id, el);
                      else rowRefs.current.delete(s.id);
                    }}
                    onClick={() => selectCase(s.id)}
                    aria-label={rowLabel(s)}
                    aria-current={selectedId === s.id ? 'true' : undefined}
                    // Only reference the details panel while it exists (an IDREF to a missing element is invalid ARIA).
                    aria-controls={selectedId === s.id && detail ? 'case-detail' : undefined}
                    className={`flex w-full items-center gap-3 rounded-lg border bg-white p-3 text-left shadow-sm transition-colors hover:border-sky-600 ${
                      selectedId === s.id ? 'border-sky-700 ring-2 ring-sky-700' : 'border-slate-300'
                    }`}
                  >
                    <UrgencyBadge level={s.finalUrgencyLevel} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-slate-900">{s.patientName}</span>
                      <span className="block truncate text-xs text-slate-700">
                        {s.finalDepartment} <span aria-hidden="true">·</span> {timeAgo(s.submittedAt)}
                      </span>
                    </span>
                    {s.needsHumanReview && s.reviewStatus === 'pending' && (
                      <span className="flex items-center gap-1 rounded-full bg-amber-50 px-2 py-1 text-xs font-medium text-amber-900 ring-1 ring-inset ring-amber-700/30">
                        <ShieldAlert className="h-3 w-3" aria-hidden="true" />
                        Review required
                      </span>
                    )}
                    {s.reviewStatus !== 'pending' && (
                      <span className="flex items-center gap-1 rounded-full bg-slate-100 px-2 py-1 text-xs font-medium text-slate-800">
                        <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                        {STATUS_LABEL[s.reviewStatus]}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {selected && detail && (
        <aside
          id="case-detail"
          aria-label="Case details"
          onKeyDown={(e) => {
            if (e.key === 'Escape' && !showOverride) closeDetail();
          }}
          className="w-full flex-shrink-0 rounded-xl border border-slate-200 bg-white p-4 shadow-sm lg:w-80"
        >
          <div className="flex items-start justify-between gap-2">
            <h2 id="case-detail-heading" ref={detailHeadingRef} tabIndex={-1} className="text-sm font-semibold text-slate-900">
              {selected.patientName}
            </h2>
            <button
              onClick={closeDetail}
              aria-label="Close case details"
              className="-m-1.5 rounded-md p-1.5 text-slate-700 hover:bg-slate-100 hover:text-slate-900"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          <p className="text-xs text-slate-700">{selected.contactPhone || 'No phone on file'}</p>

          <div className="mt-3 flex items-center gap-2">
            <UrgencyBadge level={selected.finalUrgencyLevel} />
            <span className="text-sm text-slate-800">
              <span className="sr-only">Department: </span>
              {selected.finalDepartment}
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-700">
            AI confidence: {Math.round(selected.confidenceScore * 100)}%
            {selected.needsHumanReview && ' · below review threshold'}
          </p>

          {detail.classificationHistory[0]?.modelName === FALLBACK_MODEL_NAME && (
            <p className="mt-2 flex items-start gap-1 rounded-md bg-red-50 p-2 text-xs text-red-800 ring-1 ring-inset ring-red-700/30">
              <ShieldAlert className="mt-0.5 h-3 w-3 flex-shrink-0" aria-hidden="true" />
              AI classification was unavailable for this intake — High urgency is a precaution. Triage manually.
            </p>
          )}

          <div role="alert">{actionError && <p className="mt-2 text-xs font-medium text-red-700">{actionError}</p>}</div>

          <div className="mt-4 space-y-2 border-t border-slate-200 pt-3">
            {selected.reviewStatus === 'pending' && (
              <button
                onClick={handleConfirm}
                aria-disabled={busy}
                aria-describedby="case-detail-heading"
                className="w-full rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800 aria-disabled:cursor-wait aria-disabled:opacity-70"
              >
                {busy ? 'Confirming…' : 'Confirm classification'}
              </button>
            )}
            <button
              onClick={openOverride}
              aria-haspopup="dialog"
              aria-describedby="case-detail-heading"
              className={`${SECONDARY_BUTTON} w-full`}
            >
              Override…
            </button>
          </div>

          {detail.overrideLogs.length > 0 && (
            <div className="mt-4 border-t border-slate-200 pt-3">
              <h3 className="flex items-center gap-1 text-xs font-semibold text-slate-800">
                <History className="h-3.5 w-3.5" aria-hidden="true" />
                Override history
              </h3>
              <ul className="mt-2 space-y-2">
                {detail.overrideLogs.map((log) => (
                  <li key={log.id} className="rounded-md bg-slate-100 p-2 text-xs text-slate-800">
                    <p>
                      <strong>
                        {log.previousUrgencyLevel} <span aria-hidden="true">→</span>
                        <span className="sr-only"> changed to </span> {log.newUrgencyLevel}
                      </strong>{' '}
                      by {log.overriddenBy}
                    </p>
                    <p className="mt-0.5 text-slate-700">{log.reason}</p>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>
      )}

      {showOverride && selected && <OverrideModal submission={selected} onClose={cancelOverride} onSubmit={handleOverride} />}
    </div>
  );
}
