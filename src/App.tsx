import { useState } from 'react';
import NavBar, { type View } from './components/NavBar';
import IntakeForm from './pages/IntakeForm';
import TriageQueue from './pages/TriageQueue';

export default function App() {
  const [view, setView] = useState<View>('intake');
  const [queueRefreshKey, setQueueRefreshKey] = useState(0);

  return (
    <div className="min-h-screen bg-slate-50">
      <NavBar view={view} onChange={setView} />
      {view === 'intake' ? (
        <IntakeForm
          onSubmitted={() => {
            setQueueRefreshKey((k) => k + 1);
          }}
        />
      ) : (
        <TriageQueue refreshKey={queueRefreshKey} />
      )}
    </div>
  );
}
