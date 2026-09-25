import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchMe, logout, setUnauthorizedHandler } from './api';
import ErrorBoundary from './components/ErrorBoundary';
import NavBar, { type View } from './components/NavBar';
import IntakeForm from './pages/IntakeForm';
import Login from './pages/Login';
import TriageQueue from './pages/TriageQueue';
import type { StaffUser } from '../shared/types';

// Mirrors the server's default idle timeout (SESSION_IDLE_MINUTES). The server is the authority;
// this only makes the screen stop showing patient data on an unattended workstation.
const IDLE_SIGN_OUT_MS = 30 * 60_000;

export default function App() {
  // undefined = still checking whether a session already exists
  const [user, setUser] = useState<StaffUser | null | undefined>(undefined);
  const [notice, setNotice] = useState<string | null>(null);
  const [view, setView] = useState<View>('intake');
  const [queueRefreshKey, setQueueRefreshKey] = useState(0);
  const lastActivity = useRef(Date.now());

  /** Returns to the sign-in screen. Unmounting the pages discards all patient data held in their state. */
  const endSession = useCallback((message: string | null) => {
    setUser(null);
    setNotice(message);
    setView('intake');
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

  if (user === undefined) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 text-slate-500">
        <Loader2 className="h-5 w-5 animate-spin" />
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
      <NavBar view={view} onChange={setView} username={user.username} onSignOut={signOut} />
      {/* keyed by view so switching tabs resets a boundary that has tripped */}
      <ErrorBoundary key={view}>
        {view === 'intake' ? (
          <IntakeForm
            onSubmitted={() => {
              setQueueRefreshKey((k) => k + 1);
            }}
          />
        ) : (
          <TriageQueue refreshKey={queueRefreshKey} />
        )}
      </ErrorBoundary>
    </div>
  );
}
