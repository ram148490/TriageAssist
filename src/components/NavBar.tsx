import { ClipboardList, LogOut, Stethoscope } from 'lucide-react';

export type View = 'intake' | 'queue';

export default function NavBar({
  view,
  onChange,
  username,
  onSignOut,
}: {
  view: View;
  onChange: (v: View) => void;
  username: string;
  onSignOut: () => void;
}) {
  const tabs: { id: View; label: string; Icon: typeof ClipboardList }[] = [
    { id: 'intake', label: 'New Intake', Icon: ClipboardList },
    { id: 'queue', label: 'Triage Queue', Icon: Stethoscope },
  ];

  return (
    <header className="border-b border-slate-200 bg-white">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3 sm:px-6">
        <div className="flex items-center gap-2">
          <Stethoscope className="h-6 w-6 text-sky-600" />
          <div>
            <p className="text-sm font-semibold leading-none text-slate-900">TriageAssist</p>
            <p className="text-xs leading-none text-slate-500">Meridian Urgent Care</p>
          </div>
        </div>
        <nav className="flex gap-1 rounded-lg bg-slate-100 p-1">
          {tabs.map(({ id, label, Icon }) => (
            <button
              key={id}
              onClick={() => onChange(id)}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                view === id ? 'bg-white text-sky-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Icon className="h-4 w-4" />
              {label}
            </button>
          ))}
        </nav>
        <div className="flex items-center gap-2 text-sm text-slate-600">
          <span>
            Signed in as <strong className="font-semibold text-slate-900">{username}</strong>
          </span>
          <button
            onClick={onSignOut}
            className="flex items-center gap-1 rounded-md border border-slate-300 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            <LogOut className="h-3.5 w-3.5" />
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}
