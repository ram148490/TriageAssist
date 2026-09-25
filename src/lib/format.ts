/**
 * Relative time. The exact string is used both on screen and in a row's accessible name
 * (WCAG 2.5.3 "label in name"), so it is written to be read aloud: "5 min ago", not "5m".
 */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

export const URGENCY_LABEL = { high: 'High', medium: 'Medium', low: 'Low' } as const;
