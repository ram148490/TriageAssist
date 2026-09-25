import { AlertTriangle, Loader2, WifiOff } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchMe, logout, setUnauthorizedHandler } from './api';
import ErrorBoundary from './components/ErrorBoundary';
import NavBar, { type View } from './components/NavBar';
import { DEFAULT_POLL_MS, useQueue } from './hooks/useQueue';
import IntakeForm from './pages/IntakeForm';
import Login from './pages/Login';
import TriageQueue from './pages/TriageQueue';
import type { IntakeSubmission, StaffUser } from '../shared/types';

// Mirrors the server's default idle timeout (SESSION_IDLE_MINUTES). The server is the authority;
// this only makes the screen stop showing patient data on an unattended workstation.
const IDLE_SIGN_OUT_MS = 30 * 60_000;

interface NewHighCase {
  id: string;
  patientName: string;
  department: string;
}

/** What a screen reader says when high-urgency cases arrive. Assertive: this is the most time-critical event. */
export function describeNewHigh(cases: NewHighCase[]): string {
  if (cases.length === 1) {
    return `New high urgency case: ${cases[0].patientName}, ${cases[0].department}.`;
  }
  return `${cases.length} new high urgency cases: ${cases.map((c) => `${c.patientName}, ${c.department}`).join('; ')}.`;
}

export default function App({ pollMs = DEFAULT_POLL_MS }: { pollMs?: number }) {
  // undefined = still checking whether a session already exists
  const [user, setUser] = useState<StaffUser | null | undefined>(undefined);
  const [notice, setNotice] = useState<string | null>(null);
  const [view, setView] = useState<View>('intake');
  const [focusCaseId, setFocusCaseId] = useState<string | null>(null);
  const lastActivity = useRef(Date.now());

  // Screen-reader announcements. Both regions are always mounted (a live region that is inserted
  // together with its text is announced unreliably). Urgent things go in the assertive one.
  const [assertive, setAssertive] = useState('');
  const [polite, setPolite] = useState('');
  const [banner, setBanner] = useState<NewHighCase[]>([]);

  const announceAssertive = useCallback((text: string) => {
    setAssertive(''); // clear first so an identical message is announced again
    window.setTimeout(() => setAssertive(text), 50);
  }, []);
  const announcePolite = useCallback((text: string) => {
    setPolite('');
    window.setTimeout(() => setPolite(text), 50);
  }, []);

  const handleNewHigh = useCallback(
    (cases: IntakeSubmission[]) => {
      const mapped = cases.map((c) => ({ id: c.id, patientName: c.patientName, department: c.finalDepartment }));
      announceAssertive(describeNewHigh(mapped));
      setBanner((prev) => [...mapped, ...prev.filter((p) => !mapped.some((m) => m.id === p.id))].slice(0, 5));
    },
    [announceAssertive],
  );

  const handleConnection = useCallback(
    (lost: boolean) => {
      announcePolite(
        lost
          ? 'Warning: cannot reach the server. The queue may be out of date and new cases will not appear until the connection returns.'
          : 'Connection restored. The queue is up to date.',
      );
    },
    [announcePolite],
  );

  // The queue is kept current on every screen, not just the queue tab.
  const queue = useQueue({ enabled: !!user, pollMs, onNewHigh: handleNewHigh, onConnection: handleConnection });
  const highPending = queue.submissions.filter((s) => s.finalUrgencyLevel === 'high' && s.reviewStatus === 'pending').length;

  /** Returns to the sign-in screen. Unmounting the pages discards all patient data held in their state. */
  const endSession = useCallback((message: string | null) => {
    setUser(null);
    setNotice(message);
    setView('intake');
    setBanner([]);
    setAssertive('');
    setPolite('');
    setFocusCaseId(null);
  }, []);

  useEffect(() => {
    fetchMe().then(setUser);
    setUnauthorizedHandler(() => endSession('Your session has ended. Please sign in again.'));
    return () => setUnauthorizedHandler(null);
  }, [endSession]);

  const signOut = useCallback(async () => {
    try {
      await logout();
    } catch {
      // Even if the request fails, clear the screen; the server-side session times out on its own.
    }
    endSession(null);
  }, [endSession]);

  // Auto-logoff after inactivity while signed in.
  useEffect(() => {
    if (!user) return;
    lastActivity.current = Date.now();
    const touch = () => {
      lastActivity.current = Date.now();
    };
    const events = ['mousemove', 'keydown', 'click', 'touchstart', 'scroll'] as const;
    events.forEach((e) => window.addEventListener(e, touch, { passive: true }));
    const timer = window.setInterval(() => {
      if (Date.now() - lastActivity.current > IDLE_SIGN_OUT_MS) {
        logout().catch(() => {});
        endSession('You were signed out after 30 minutes of inactivity.');
      }
    }, 30_000);
    return () => {
      events.forEach((e) => window.removeEventListener(e, touch));
      window.clearInterval(timer);
    };
  }, [user, endSession]);

  // The tab title carries the number of high-urgency cases waiting, visible even when the tab is in the background.
  useEffect(() => {
    if (!user) return;
    const base = view === 'queue' ? 'Triage queue' : 'New intake';
    document.title = `${highPending > 0 ? `(${highPending} high) ` : ''}${base} — TriageAssist`;
  }, [user, view, highPending]);

  // When the screen changes (including right after signing in), move focus to the new page's heading so
  // keyboard and screen-reader users land at the top of what they asked for, not on a vanished button.
  // Skipped when a case is about to take focus itself.
  useEffect(() => {
    if (!user || focusCaseId) return;
    document.getElementById('page-heading')?.focus();
  }, [user?.username, view]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleFocusHandled = useCallback(() => setFocusCaseId(null), []);

  if (user === undefined) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 text-slate-700" role="status" aria-label="Loading">
        <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      </div>
    );
  }

  if (user === null) {
    return (
      <div className="min-h-screen bg-slate-50">
        <Login
          notice={notice}
          onSignedIn={(u) => {
            setNotice(null);
            setUser(u);
          }}
        />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:font-semibold focus:text-sky-800 focus:shadow-lg"
      >
        Skip to main content
      </a>

      <div role="alert" aria-atomic="true" className="sr-only" data-testid="assertive-announcer">{assertive}</div>
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="polite-announcer">{polite}</div>

      <NavBar view={view} onChange={setView} username={user.username} onSignOut={signOut} highCount={highPending} />

      {queue.connectionLost && (
        <div className="bg-amber-100 text-amber-950">
          <p className="mx-auto flex max-w-5xl items-center gap-2 px-4 py-2 text-sm font-medium sm:px-6">
            <WifiOff className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
            Cannot reach the server. The queue on screen may be out of date; new cases will not appear until the connection returns.
          </p>
        </div>
      )}

      {banner.length > 0 && (
        <section aria-label="New high urgency cases" className="bg-red-800 text-white">
          <ul className="mx-auto max-w-5xl divide-y divide-red-600 px-4 sm:px-6">
            {banner.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2 text-sm">
                <AlertTriangle className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
                <span className="flex-1">
                  <strong className="font-semibold">New high urgency case:</strong> {c.patientName}, {c.department}
                </span>
                <button
                  onClick={() => {
                    setFocusCaseId(c.id);
                    setView('queue');
                    setBanner((b) => b.filter((x) => x.id !== c.id));
                  }}
                  className="rounded-md bg-white px-3 py-1 text-xs font-semibold text-red-900 hover:bg-red-50"
                >
                  View in queue
                  <span className="sr-only">: {c.patientName}</span>
                </button>
                <button
                  onClick={() => setBanner((b) => b.filter((x) => x.id !== c.id))}
                  className="rounded-md border border-white px-3 py-1 text-xs font-semibold text-white hover:bg-red-700"
                >
                  Dismiss<span className="sr-only"> alert for {c.patientName}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <main id="main-content" tabIndex={-1} className="outline-none">
        {/* keyed by view so switching tabs resets a boundary that has tripped */}
        <ErrorBoundary key={view}>
          {view === 'intake' ? (
            <IntakeForm
              onSubmitted={(submission) => {
                // The user is looking at this result already; don't announce it a second time as "new".
                queue.acknowledge(submission.id);
                queue.refresh();
              }}
            />
          ) : (
            <TriageQueue queue={queue} focusCaseId={focusCaseId} onFocusHandled={handleFocusHandled} />
          )}
        </ErrorBoundary>
      </main>
    </div>
  );
}
