import { Loader2, Stethoscope } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { login } from '../api';
import { FIELD, LABEL, PRIMARY_BUTTON } from '../ui';
import type { StaffUser } from '../../shared/types';

export default function Login({ onSignedIn, notice }: { onSignedIn: (user: StaffUser) => void; notice?: string | null }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const ids = { username: useId(), password: useId(), notice: useId(), error: useId() };

  useEffect(() => {
    document.title = 'Sign in — TriageAssist';
    usernameRef.current?.focus();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return; // aria-disabled keeps focus on the button, so guard here instead of using `disabled`
    setError(null);
    setSubmitting(true);
    try {
      const { user } = await login(username, password);
      setPassword('');
      onSignedIn(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
      setPassword('');
      passwordRef.current?.focus(); // the field was cleared: put the cursor back where they retype
    } finally {
      setSubmitting(false);
    }
  }

  // The session-ended notice and any error describe the whole form, so both fields point at them.
  const described = [notice ? ids.notice : null, error ? ids.error : null].filter(Boolean).join(' ') || undefined;

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
      <div className="mb-6 flex items-center gap-2">
        <Stethoscope className="h-7 w-7 text-sky-700" aria-hidden="true" />
        <div>
          <p className="text-base font-semibold leading-none text-slate-900">TriageAssist</p>
          <p className="text-xs leading-none text-slate-600">Meridian Urgent Care</p>
        </div>
      </div>

      <h1 className="mb-3 text-lg font-semibold text-slate-900">Staff sign-in</h1>

      {notice && (
        <p id={ids.notice} role="alert" className="mb-3 rounded-md bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-inset ring-amber-700/30">
          {notice}
        </p>
      )}

      <form onSubmit={handleSubmit} className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div>
          <label htmlFor={ids.username} className={LABEL}>Username</label>
          <input
            id={ids.username}
            ref={usernameRef}
            required
            autoComplete="username"
            maxLength={64}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            aria-describedby={described}
            aria-invalid={error ? true : undefined}
            className={FIELD}
          />
        </div>

        <div>
          <label htmlFor={ids.password} className={LABEL}>Password</label>
          <input
            id={ids.password}
            ref={passwordRef}
            type="password"
            required
            autoComplete="current-password"
            maxLength={256}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-describedby={described}
            aria-invalid={error ? true : undefined}
            className={FIELD}
          />
        </div>

        {error && (
          <p id={ids.error} role="alert" className="text-sm font-medium text-red-700">
            {error}
          </p>
        )}

        <button type="submit" aria-disabled={submitting} className={`${PRIMARY_BUTTON} w-full`}>
          {submitting && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
