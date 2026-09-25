import { ClipboardList, LogOut, Stethoscope } from 'lucide-react';

export type View = 'intake' | 'queue';

export default function NavBar({
  view,
  onChange,
  username,
  onSignOut,
  highCount,
}: {
  view: View;
  onChange: (v: View) => void;
  username: string;
  onSignOut: () => void;
  /** High-urgency cases still awaiting review; shown on the queue tab. */
  highCount: number;
}) {
  const tabs: { id: View; label: string; Icon: typeof ClipboardList }[] = [
    { id: 'intake', label: 'New Intake', Icon: ClipboardList },
    { id: 'queue', label: 'Triage Queue', Icon: Stethoscope },
  ];

  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-2">
          <Stethoscope className="h-6 w-6 text-sky-700" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold leading-none text-slate-900">TriageAssist</p>
            <p className="text-xs leading-none text-slate-600">Meridian Urgent Care</p>
          </div>
        </div>
        <nav aria-label="Main" className="flex gap-1 rounded-lg bg-slate-100 p-1">
          {tabs.map(({ id, label, Icon }) => (
            <button
              key={id}
              onClick={() => onChange(id)}
              aria-current={view === id ? 'page' : undefined}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                view === id ? 'bg-white text-sky-800 shadow-sm' : 'text-slate-700 hover:text-slate-900'
              }`}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {label}
              {id === 'queue' && highCount > 0 && (
                <>
                  <span aria-hidden="true" className="ml-0.5 rounded-full bg-red-700 px-1.5 py-0.5 text-xs font-semibold text-white">
                    {highCount}
                  </span>
                  <span className="sr-only">
                    , {highCount} high urgency {highCount === 1 ? 'case' : 'cases'} awaiting review
                  </span>
                </>
              )}
            </button>
          ))}
        </nav>
        <div className="flex items-center gap-2 text-sm text-slate-700">
          <span>
            Signed in as <strong className="font-semibold text-slate-900">{username}</strong>
          </span>
          <button
            onClick={onSignOut}
            className="flex items-center gap-1 rounded-md border border-slate-400 px-2.5 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-100"
          >
            <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}
