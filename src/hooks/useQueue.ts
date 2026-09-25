import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchQueue } from '../api';
import type { IntakeSubmission, UrgencyLevel } from '../../shared/types';

export interface QueueState {
  submissions: IntakeSubmission[];
  loading: boolean;
  /** The last initial/manual load error. Background failures set `connectionLost` instead. */
  error: string | null;
  lastUpdated: Date | null;
  /** True while background updates are failing, i.e. the list on screen may be out of date. */
  connectionLost: boolean;
  /** Reloads the queue; resolves to the fresh list, or null if the request failed. */
  refresh: () => Promise<IntakeSubmission[] | null>;
  /**
   * Marks a case as already known to the user (they just created or changed it), so it is not
   * also announced as a "new high-urgency case".
   */
  acknowledge: (id: string) => void;
}

export const DEFAULT_POLL_MS = 15_000;

/**
 * Keeps the triage queue current for as long as the user is signed in, on every screen (not
 * only while the queue tab is open): a high-urgency case that arrives from another
 * workstation must reach staff wherever they are in the app.
 *
 * `onNewHigh` fires for cases that have just become high urgency: newly arrived, or
 * escalated by an override. Cases already present when the queue was first loaded are the
 * baseline and are not announced.
 */
export function useQueue(opts: {
  enabled: boolean;
  pollMs?: number;
  onNewHigh?: (cases: IntakeSubmission[]) => void;
  onConnection?: (lost: boolean) => void;
}): QueueState {
  const { enabled, pollMs = DEFAULT_POLL_MS } = opts;
  const [submissions, setSubmissions] = useState<IntakeSubmission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [connectionLost, setConnectionLost] = useState(false);

  const seen = useRef<Map<string, UrgencyLevel> | null>(null); // null until the first successful load
  const acknowledged = useRef(new Set<string>());
  const latestRequest = useRef(0);
  const lost = useRef(false);
  const onNewHigh = useRef(opts.onNewHigh);
  const onConnection = useRef(opts.onConnection);
  onNewHigh.current = opts.onNewHigh;
  onConnection.current = opts.onConnection;

  const load = useCallback(async (background: boolean): Promise<IntakeSubmission[] | null> => {
    const requestId = ++latestRequest.current;
    try {
      const { submissions: list } = await fetchQueue({ background });
      if (requestId !== latestRequest.current) return list; // a newer request has superseded this one

      const previous = seen.current;
      seen.current = new Map(list.map((s) => [s.id, s.finalUrgencyLevel]));
      if (previous) {
        const fresh = list.filter(
          (s) => s.finalUrgencyLevel === 'high' && previous.get(s.id) !== 'high' && !acknowledged.current.has(s.id),
        );
        if (fresh.length > 0) onNewHigh.current?.(fresh);
      }

      setSubmissions(list);
      setLastUpdated(new Date());
      setError(null);
      if (lost.current) {
        lost.current = false;
        setConnectionLost(false);
        onConnection.current?.(false);
      }
      return list;
    } catch (err) {
      if (requestId !== latestRequest.current) return null;
      if (background) {
        if (!lost.current) {
          lost.current = true;
          setConnectionLost(true);
          onConnection.current?.(true);
        }
      } else {
        setError(err instanceof Error ? err.message : 'Failed to load the queue.');
      }
      return null;
    } finally {
      if (requestId === latestRequest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      // Signed out: forget everything, including the patient list held in memory.
      latestRequest.current++;
      seen.current = null;
      acknowledged.current.clear();
      lost.current = false;
      setSubmissions([]);
      setLoading(true);
      setError(null);
      setLastUpdated(null);
      setConnectionLost(false);
      return;
    }
    load(false);
    const timer = window.setInterval(() => load(true), pollMs);
    const onVisible = () => {
      if (document.visibilityState === 'visible') load(true);
    };
    const onOnline = () => load(true);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
    };
  }, [enabled, pollMs, load]);

  const refresh = useCallback(() => load(false), [load]);
  const acknowledge = useCallback((id: string) => {
    acknowledged.current.add(id);
  }, []);

  return { submissions, loading, error, lastUpdated, connectionLost, refresh, acknowledge };
}
