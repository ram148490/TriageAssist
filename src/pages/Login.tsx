import { Loader2, Stethoscope } from 'lucide-react';
import { useState } from 'react';
import { login } from '../api';
import type { StaffUser } from '../../shared/types';

export default function Login({ onSignedIn, notice }: { onSignedIn: (user: StaffUser) => void; notice?: string | null }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const { user } = await login(username, password);
      setPassword('');
      onSignedIn(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed.');
      setPassword('');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
      <div className="mb-6 flex items-center gap-2">
        <Stethoscope className="h-7 w-7 text-sky-600" />
        <div>
          <p className="text-base font-semibold leading-none text-slate-900">TriageAssist</p>
          <p className="text-xs leading-none text-slate-500">Meridian Urgent Care — staff sign-in</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        {notice && <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-800 ring-1 ring-inset ring-amber-600/20">{notice}</p>}

        <div>
          <label htmlFor="username" className="block text-sm font-medium text-slate-700">Username</label>
          <input
            id="username"
            required
            autoFocus
            autoComplete="username"
            maxLength={64}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
          />
        </div>

        <div>
          <label htmlFor="password" className="block text-sm font-medium text-slate-700">Password</label>
          <input
            id="password"
            type="password"
            required
            autoComplete="current-password"
            maxLength={256}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500"
          />
        </div>

        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}

        <button
          type="submit"
          disabled={submitting}
          className="flex w-full items-center justify-center gap-2 rounded-md bg-sky-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-sky-700 disabled:opacity-60"
        >
          {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
