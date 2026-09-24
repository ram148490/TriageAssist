import { AlertTriangle, ArrowDown, ArrowUp } from 'lucide-react';
import type { UrgencyLevel } from '../../shared/types';

const STYLES: Record<UrgencyLevel, { classes: string; label: string; Icon: typeof AlertTriangle }> = {
  high: { classes: 'bg-red-100 text-red-800 ring-red-600/20', label: 'High', Icon: AlertTriangle },
  medium: { classes: 'bg-amber-100 text-amber-800 ring-amber-600/20', label: 'Medium', Icon: ArrowUp },
  low: { classes: 'bg-emerald-100 text-emerald-800 ring-emerald-600/20', label: 'Low', Icon: ArrowDown },
};

export default function UrgencyBadge({ level }: { level: UrgencyLevel }) {
  const { classes, label, Icon } = STYLES[level];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${classes}`}>
      <Icon className="h-3.5 w-3.5" />
      {label}
    </span>
  );
}
