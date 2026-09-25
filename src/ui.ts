// Shared class lists. Every colour pair here is checked by tests/test-a11y-contrast.ts
// (text 4.5:1, field borders 3:1), so change colours there-and-here together.

/** Text inputs, selects and textareas. The border is the only thing that shows where the field is (3:1). */
export const FIELD = 'mt-1 w-full rounded-md border border-slate-500 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-500';

export const LABEL = 'block text-sm font-medium text-slate-800';

/** `aria-disabled` (not `disabled`) while busy, so a focused button keeps keyboard focus. */
export const PRIMARY_BUTTON =
  'flex items-center justify-center gap-2 rounded-md bg-sky-700 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-sky-800 aria-disabled:cursor-wait aria-disabled:opacity-70';

export const SECONDARY_BUTTON =
  'rounded-md border border-slate-400 px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-100';
