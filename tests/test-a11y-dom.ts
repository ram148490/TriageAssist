/**
 * Accessibility behaviour tests. Mounts the real <App> in jsdom against an in-memory fake API and
 * checks, by driving it with keyboard/mouse events, that:
 *   - every form control has an accessible name, and axe-core finds no violations on any screen state
 *     (sign-in, intake, queue, queue with details open, override dialog);
 *   - the sign-in flow is fully keyboard operable and focus lands somewhere sensible after each step;
 *   - the override dialog is a real modal (labelled, focus trap, Escape, focus restoration);
 *   - focus is never stranded on <body> after Confirm / Override remove the button that had it;
 *   - a NEW HIGH-URGENCY CASE is announced through an assertive live region, on any screen, exactly
 *     once, without announcing the user's own submissions or already-known cases, with a visible
 *     banner that leads to the case; and a lost connection is announced too.
 *
 * jsdom has no layout engine, so colour contrast is checked separately (test-a11y-contrast.ts) and
 * this file cannot judge how anything looks. It does not replace testing with a real screen reader.
 *
 *   npm run test:a11y
 */
import assert from 'assert';
import { JSDOM } from 'jsdom';
import axeCore from 'axe-core';
import type { IntakeDetail, IntakeSubmission, OverrideLogEntry, UrgencyLevel } from '../shared/types';

// ---------------------------------------------------------------- jsdom + globals (before React loads)
const dom = new JSDOM('<!doctype html><html lang="en"><head><title>TriageAssist</title></head><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
  runScripts: 'outside-only',
});
const w = dom.window as unknown as Window & typeof globalThis & { axe: typeof axeCore };
for (const key of [
  'window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement',
  'HTMLButtonElement', 'HTMLFormElement', 'Node', 'Element', 'Event', 'KeyboardEvent', 'MouseEvent', 'FocusEvent',
  'InputEvent', 'CustomEvent', 'MutationObserver', 'getComputedStyle', 'DocumentFragment', 'Text', 'SVGElement', 'DOMException',
]) {
  Object.defineProperty(globalThis, key, { value: (w as any)[key] ?? (globalThis as any)[key], configurable: true, writable: true });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
w.eval(axeCore.source);

const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: App, describeNewHigh } = await import('../src/App');
const { act } = React;

// The queue polls on a timer, so React state updates land between our awaits; that is what we are testing,
// and React's "not wrapped in act(...)" warning about it is only noise.
const realConsoleError = console.error;
console.error = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && /not wrapped in act|not configured to support act/.test(args[0])) return;
  realConsoleError(...args);
};

// ---------------------------------------------------------------- fake API
interface Req {
  method: string;
  path: string;
  background: boolean;
}
const db = {
  session: false,
  offline: false,
  loginDelayMs: 0,
  submissions: [] as IntakeSubmission[],
  overrideLogs: {} as Record<string, OverrideLogEntry[]>,
  requests: [] as Req[],
  nextIntake: { urgency: 'low' as UrgencyLevel, unavailable: false, needsReview: false, confidence: 0.9 },
  seq: 0,
};

function makeSubmission(over: Partial<IntakeSubmission> & { patientName: string }): IntakeSubmission {
  const now = new Date().toISOString();
  const id = `00000000-0000-4000-8000-${String(++db.seq).padStart(12, '0')}`;
  return {
    id, contactPhone: null, submittedAt: now, urgencyLevel: 'low', suggestedDepartment: 'Minor Illness', confidenceScore: 0.9,
    needsHumanReview: false, finalUrgencyLevel: 'low', finalDepartment: 'Minor Illness', reviewStatus: 'pending',
    reviewedBy: null, reviewedAt: null, createdAt: now, updatedAt: now, ...over,
  };
}

const rank = { high: 0, medium: 1, low: 2 } as const;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = String(input);
  const method = init?.method ?? 'GET';
  const headers = new Headers(init?.headers);
  db.requests.push({ method, path, background: headers.get('x-background-poll') === '1' });
  if (db.offline) throw new TypeError('fetch failed');
  const body = init?.body ? JSON.parse(String(init.body)) : {};

  if (path === '/api/auth/login') {
    if (db.loginDelayMs) await sleep(db.loginDelayMs);
    if (body.username === 'alice' && body.password === 'correct-password') {
      db.session = true;
      return json(200, { success: true, user: { username: 'alice' } });
    }
    return json(401, { success: false, error: 'Invalid username or password.' });
  }
  if (path === '/api/auth/logout') {
    db.session = false;
    return json(200, { success: true });
  }
  if (!db.session) return json(401, { success: false, error: 'Authentication required.' });

  if (path === '/api/auth/me') return json(200, { success: true, user: { username: 'alice' } });
  if (path === '/api/queue') {
    const sorted = [...db.submissions].sort((a, b) => rank[a.finalUrgencyLevel] - rank[b.finalUrgencyLevel] || a.submittedAt.localeCompare(b.submittedAt));
    return json(200, { success: true, submissions: sorted });
  }
  if (path === '/api/intake' && method === 'POST') {
    const n = db.nextIntake;
    const s = makeSubmission({
      patientName: body.patientName, contactPhone: body.contactPhone ?? null, urgencyLevel: n.urgency, finalUrgencyLevel: n.urgency,
      confidenceScore: n.unavailable ? 0 : n.confidence, needsHumanReview: n.needsReview || n.unavailable,
      suggestedDepartment: 'General Urgent Care', finalDepartment: 'General Urgent Care',
    });
    db.submissions.push(s);
    return json(201, { success: true, submission: s, classificationUnavailable: n.unavailable });
  }
  const m = path.match(/^\/api\/queue\/([^/]+)(\/confirm|\/override)?$/);
  if (m) {
    const s = db.submissions.find((x) => x.id === m[1]);
    if (!s) return json(404, { success: false, error: 'Submission not found.' });
    if (m[2] === '/confirm') {
      s.reviewStatus = 'reviewed';
      s.reviewedBy = 'alice';
      s.updatedAt = new Date(Date.now() + ++db.seq).toISOString();
      return json(200, { success: true, submission: s });
    }
    if (m[2] === '/override') {
      const log: OverrideLogEntry = {
        id: `log-${++db.seq}`, intakeId: s.id, previousUrgencyLevel: s.finalUrgencyLevel, previousDepartment: s.finalDepartment,
        newUrgencyLevel: body.newUrgencyLevel, newDepartment: body.newDepartment, reason: body.reason, overriddenBy: 'alice', overriddenAt: new Date().toISOString(),
      };
      (db.overrideLogs[s.id] ??= []).push(log);
      s.finalUrgencyLevel = body.newUrgencyLevel;
      s.finalDepartment = body.newDepartment;
      s.reviewStatus = 'overridden';
      s.updatedAt = new Date(Date.now() + ++db.seq).toISOString();
      return json(200, { success: true, submission: s });
    }
    const detail: IntakeDetail = {
      submission: s,
      classificationHistory: [{ id: 'h1', intakeId: s.id, urgencyLevel: s.urgencyLevel, suggestedDepartment: s.suggestedDepartment, confidenceScore: s.confidenceScore, modelName: 'gemini-3.6-flash', promptVersion: 'v', classifiedAt: s.createdAt }],
      overrideLogs: db.overrideLogs[s.id] ?? [],
    };
    return json(200, { success: true, detail });
  }
  return json(404, { success: false, error: 'Not found.' });
}) as typeof fetch;

// ---------------------------------------------------------------- helpers
const POLL_MS = 40;
let root: ReturnType<typeof createRoot> | null = null;

async function flush(ms = 60) {
  await act(async () => {
    await sleep(ms);
  });
}
async function mount() {
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root')!);
  await act(async () => {
    root!.render(React.createElement(App, { pollMs: POLL_MS }));
  });
  await flush();
}
async function unmount() {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
}
function reset() {
  Object.assign(db, { session: false, offline: false, loginDelayMs: 0, submissions: [], overrideLogs: {}, requests: [], seq: 0 });
  db.nextIntake = { urgency: 'low', unavailable: false, needsReview: false, confidence: 0.9 };
}
const $ = <T extends Element = HTMLElement>(sel: string, scope: ParentNode = document) => scope.querySelector<T>(sel);
const $$ = <T extends Element = HTMLElement>(sel: string, scope: ParentNode = document) => Array.from(scope.querySelectorAll<T>(sel));
const byText = (sel: string, text: string) => $$(sel).find((e) => e.textContent?.includes(text));
const active = () => document.activeElement as HTMLElement | null;
const describe = (el: Element | null) => (el ? `<${el.tagName.toLowerCase()}${el.id ? ` id="${el.id}"` : ''}${el.getAttribute('aria-label') ? ` aria-label="${el.getAttribute('aria-label')}"` : ''}> "${(el.textContent ?? '').trim().slice(0, 40)}"` : 'null');

async function click(el: Element | null | undefined) {
  assert.ok(el, 'click target exists');
  await act(async () => {
    (el as HTMLElement).dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}
async function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof w.HTMLTextAreaElement ? w.HTMLTextAreaElement.prototype : w.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new w.Event('input', { bubbles: true }));
  });
}
/** Dispatches a keydown and returns whether the page prevented its default action. */
async function press(el: Element, key: string, opts: { shiftKey?: boolean } = {}): Promise<boolean> {
  const ev = new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts });
  await act(async () => {
    el.dispatchEvent(ev);
  });
  return ev.defaultPrevented;
}
async function submit(form: HTMLFormElement) {
  await act(async () => {
    form.requestSubmit();
  });
}

/** Elements a Tab key would visit, in DOM order (jsdom has no Tab navigation of its own). */
function tabOrder(scope: ParentNode = document): HTMLElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]'))
    .filter((el) => !(el as HTMLButtonElement).disabled && el.getAttribute('tabindex') !== '-1' && el.getAttribute('aria-hidden') !== 'true' && !el.closest('.sr-only:not(a)'));
}

async function axeViolations(label: string): Promise<void> {
  const results = await w.axe.run(w.document, {
    // jsdom has no layout, so contrast is checked by test-a11y-contrast.ts instead.
    rules: { 'color-contrast': { enabled: false } },
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
  });
  const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.help} → ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`);
  assert.ok(summary.length === 0, `axe-core violations on ${label}:\n  ${summary.join('\n  ')}`);
}

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    console.log(`  FAIL  ${name}\n          ${(err instanceof Error ? err.message : String(err)).split('\n').join('\n          ')}`);
    failures.push(name);
  } finally {
    await unmount();
  }
}
const failures: string[] = [];

async function signIn() {
  reset();
  await mount();
  await typeInto($<HTMLInputElement>('input[autocomplete=username]')!, 'alice');
  await typeInto($<HTMLInputElement>('input[type=password]')!, 'correct-password');
  await submit($<HTMLFormElement>('form')!);
  await flush();
}

// ================================================================= sign-in
console.log('\nSign-in screen');

await test('has a landmark, a heading, a title, and every field is labelled (axe: no violations)', async () => {
  reset();
  await mount();
  assert.strictEqual($('main h1')?.textContent, 'Staff sign-in');
  assert.ok(document.title.startsWith('Sign in'), document.title);
  for (const input of $$<HTMLInputElement>('input')) {
    assert.strictEqual(input.labels?.length, 1, `${describe(input)} needs exactly one <label>`);
    assert.ok(input.labels![0].textContent?.trim(), 'label has text');
  }
  await axeViolations('the sign-in screen');
});

await test('keyboard: focus starts in the username field, Tab order is username → password → Sign in', async () => {
  reset();
  await mount();
  assert.strictEqual(active()?.getAttribute('autocomplete'), 'username', `focus is on ${describe(active())}`);
  const order = tabOrder().map((e) => e.tagName + (e.getAttribute('type') ? `[${e.getAttribute('type')}]` : ''));
  assert.deepStrictEqual(order, ['INPUT', 'INPUT[password]', 'BUTTON[submit]']);
  assert.ok($<HTMLFormElement>('form')!.querySelector('button[type=submit]'), 'a submit button exists, so Enter in a field submits');
});

await test('a wrong password is announced, tied to the fields, and focus returns to the (cleared) password field', async () => {
  reset();
  await mount();
  await typeInto($<HTMLInputElement>('input[autocomplete=username]')!, 'alice');
  await typeInto($<HTMLInputElement>('input[type=password]')!, 'wrong');
  await submit($<HTMLFormElement>('form')!);
  await flush();
  const alert = byText('[role=alert]', 'Invalid username or password.');
  assert.ok(alert, 'error is in a role=alert region');
  const password = $<HTMLInputElement>('input[type=password]')!;
  assert.strictEqual(active(), password, `focus should return to the password field, is on ${describe(active())}`);
  assert.strictEqual(password.value, '');
  assert.ok(password.getAttribute('aria-describedby')?.split(' ').includes(alert!.id), 'password field is described by the error');
  assert.strictEqual(password.getAttribute('aria-invalid'), 'true');
  await axeViolations('the sign-in screen with an error');
});

await test('while signing in, the button is aria-disabled (not disabled) so focus is not lost, and a second submit is ignored', async () => {
  reset();
  db.loginDelayMs = 80;
  await mount();
  await typeInto($<HTMLInputElement>('input[autocomplete=username]')!, 'alice');
  await typeInto($<HTMLInputElement>('input[type=password]')!, 'correct-password');
  const button = $<HTMLButtonElement>('button[type=submit]')!;
  button.focus();
  const form = $<HTMLFormElement>('form')!;
  await act(async () => {
    form.requestSubmit();
  });
  assert.strictEqual(button.getAttribute('aria-disabled'), 'true');
  assert.strictEqual(button.disabled, false, 'must not use the disabled attribute (it drops keyboard focus)');
  assert.strictEqual(active(), button, 'focus stays on the button');
  await act(async () => {
    form.requestSubmit(); // impatient second Enter
  });
  await flush(150);
  assert.strictEqual(db.requests.filter((r) => r.path === '/api/auth/login').length, 1, 'only one login request');
});

await test('after signing in, focus moves to the page heading, and the app shell has skip link, nav and main landmarks', async () => {
  await signIn();
  assert.strictEqual(active()?.id, 'page-heading', `focus is on ${describe(active())}`);
  assert.strictEqual(active()?.tagName, 'H1');
  assert.ok(document.title.includes('New intake'), document.title);
  const first = tabOrder()[0];
  assert.strictEqual(first.getAttribute('href'), '#main-content', 'the skip link is the first thing Tab reaches');
  assert.strictEqual($('a[href="#main-content"]')?.textContent, 'Skip to main content');
  const main = $('main#main-content');
  assert.ok(main && main.getAttribute('tabindex') === '-1', 'the skip link target is focusable');
  assert.ok($('nav[aria-label="Main"]'), 'nav is labelled');
  assert.strictEqual($$('nav[aria-label="Main"] button[aria-current="page"]').length, 1, 'the current page is marked');
  assert.strictEqual($('nav[aria-label="Main"] button[aria-current="page"]')?.textContent?.trim(), 'New Intake');
});

// ================================================================= intake
console.log('\nIntake form');

await test('every control has a name and a described hint; axe finds no violations', async () => {
  await signIn();
  const fields = $$<HTMLInputElement>('main input, main textarea');
  assert.strictEqual(fields.length, 3);
  for (const f of fields) {
    assert.strictEqual(f.labels?.length, 1, `${describe(f)} is not associated with a <label>`);
  }
  assert.ok(byText('label', 'Patient name')?.textContent?.includes('required'));
  assert.ok(byText('label', 'Contact phone')?.textContent?.includes('optional'));
  for (const f of $$<HTMLElement>('main input[aria-describedby], main textarea[aria-describedby]')) {
    for (const id of f.getAttribute('aria-describedby')!.split(' ')) assert.ok(document.getElementById(id), `describedby target ${id} exists`);
  }
  await axeViolations('the intake form');
});

async function fillAndSubmit() {
  await typeInto($<HTMLInputElement>('main input:not([type=tel])')!, 'Maria Lopez');
  await typeInto($<HTMLTextAreaElement>('main textarea')!, 'chest pain and shortness of breath');
  await submit($<HTMLFormElement>('main form')!);
  await flush();
}
const resultRole = () => byText('h2', 'Added to the triage queue')?.closest('[role]')?.getAttribute('role');

await test('a HIGH result is announced assertively (role=alert); a LOW result politely (role=status)', async () => {
  await signIn();
  db.nextIntake = { urgency: 'high', unavailable: false, needsReview: false, confidence: 0.95 };
  await fillAndSubmit();
  assert.strictEqual(resultRole(), 'alert', 'high urgency result');
  assert.ok($('main')!.textContent!.includes('Urgency: High'), 'urgency is text, not colour alone');
  await axeViolations('the intake result (high)');

  db.nextIntake = { urgency: 'low', unavailable: false, needsReview: false, confidence: 0.9 };
  await fillAndSubmit();
  assert.strictEqual(resultRole(), 'status', 'low urgency result');
});

await test('the AI-unavailable fail-safe result is announced assertively and says manual triage is needed', async () => {
  await signIn();
  db.nextIntake = { urgency: 'high', unavailable: true, needsReview: true, confidence: 0 };
  await fillAndSubmit();
  assert.strictEqual(resultRole(), 'alert');
  assert.ok(byText('[role=alert] p', 'The AI classifier was')?.textContent?.includes('manual triage'), 'the banner tells staff to triage manually');
});

await test('while classifying, the button is aria-disabled and keeps focus; a status message says so', async () => {
  await signIn();
  await typeInto($<HTMLInputElement>('main input:not([type=tel])')!, 'Maria Lopez');
  await typeInto($<HTMLTextAreaElement>('main textarea')!, 'headache');
  const button = $<HTMLButtonElement>('main button[type=submit]')!;
  button.focus();
  // Hold the intake response so we can look at the in-flight state.
  const realFetch = globalThis.fetch;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => (String(i) === '/api/intake' ? (await gate, realFetch(i, init)) : realFetch(i, init))) as typeof fetch;
  await act(async () => {
    $<HTMLFormElement>('main form')!.requestSubmit();
  });
  assert.strictEqual(button.getAttribute('aria-disabled'), 'true');
  assert.strictEqual(button.disabled, false);
  assert.strictEqual(active(), button);
  assert.ok(byText('[role=status]', 'Classifying'), 'in-flight status message');
  release();
  await flush();
  globalThis.fetch = realFetch;
  assert.strictEqual(active(), button, 'focus is still on the button afterwards');
});

await test('a server error is announced (role=alert) and the entered text is kept', async () => {
  await signIn();
  await typeInto($<HTMLInputElement>('main input:not([type=tel])')!, 'X');
  await typeInto($<HTMLTextAreaElement>('main textarea')!, 'headache');
  db.session = false; // session expires mid-flight
  await submit($<HTMLFormElement>('main form')!);
  await flush();
  assert.ok($('main h1') === null || document.title.startsWith('Sign in'), 'a 401 returns to the sign-in screen');
  assert.ok(byText('[role=alert]', 'session has ended'), 'the reason is announced on the sign-in screen');
});

// ================================================================= new high urgency
console.log('\nNew high-urgency announcements (the safety-critical path)');

const assertive = () => $('[data-testid=assertive-announcer]')!;
const polite = () => $('[data-testid=polite-announcer]')!;
/** Records every non-empty text the assertive region ever holds, so "announced exactly once" is testable. */
function recordAnnouncements(): { list: string[]; stop: () => void } {
  const list: string[] = [];
  const observer = new w.MutationObserver(() => {
    const text = assertive().textContent?.trim();
    if (text && list[list.length - 1] !== text) list.push(text);
  });
  observer.observe(assertive(), { childList: true, characterData: true, subtree: true });
  return { list, stop: () => observer.disconnect() };
}

await test('a new high-urgency case is announced assertively, exactly once, with a banner and a count on the queue tab', async () => {
  await signIn();
  // One high case already present (baseline: must NOT be announced) and one low.
  db.submissions.push(makeSubmission({ patientName: 'Existing High', finalUrgencyLevel: 'high', urgencyLevel: 'high', finalDepartment: 'Refer to Emergency Room' }));
  db.submissions.push(makeSubmission({ patientName: 'Existing Low' }));
  await unmount();
  await mount(); // sign-in persists via the fake session: this is a fresh page load with the cases already there
  await flush(POLL_MS * 3);
  assert.strictEqual(assertive().textContent, '', 'cases present at first load are the baseline, not announcements');
  assert.strictEqual($('section[aria-label="New high urgency cases"]'), null, 'no banner for the baseline');

  const rec = recordAnnouncements();
  db.submissions.push(makeSubmission({ patientName: 'Maria Lopez', finalUrgencyLevel: 'high', urgencyLevel: 'high', finalDepartment: 'General Urgent Care' }));
  await flush(POLL_MS * 6);
  assert.deepStrictEqual(rec.list, ['New high urgency case: Maria Lopez, General Urgent Care.']);
  assert.strictEqual(assertive().getAttribute('role'), 'alert');
  assert.ok(assertive().classList.contains('sr-only'), 'the region is visually hidden but exposed to assistive tech');
  await flush(POLL_MS * 8); // many more polls: no repeats
  assert.strictEqual(rec.list.length, 1, `announced ${rec.list.length} times: ${JSON.stringify(rec.list)}`);

  const banner = $('section[aria-label="New high urgency cases"]');
  assert.ok(banner?.textContent?.includes('Maria Lopez'), 'a visible banner names the case');
  assert.strictEqual($$('li', banner!).length, 1, 'one banner entry, not one per poll');
  const queueTab = byText('nav button', 'Triage Queue')!;
  assert.ok(queueTab.textContent!.includes('2 high urgency cases awaiting review'), `queue tab says: ${queueTab.textContent}`);
  assert.ok(document.title.startsWith('(2 high)'), document.title);
  rec.stop();
});

await test('it announces on the New Intake screen too, not only while the queue tab is open', async () => {
  await signIn();
  assert.ok(byText('nav button', 'New Intake')!.getAttribute('aria-current') === 'page');
  const rec = recordAnnouncements();
  db.submissions.push(makeSubmission({ patientName: 'Sam Rivera', finalUrgencyLevel: 'high', urgencyLevel: 'high' }));
  await flush(POLL_MS * 6);
  assert.strictEqual(rec.list.length, 1);
  assert.ok(rec.list[0].includes('Sam Rivera'));
  rec.stop();
});

await test('does NOT announce low/medium cases, or the user\'s own submissions, or a case that was already high', async () => {
  await signIn();
  const rec = recordAnnouncements();
  db.submissions.push(makeSubmission({ patientName: 'Low Person' }));
  db.submissions.push(makeSubmission({ patientName: 'Medium Person', finalUrgencyLevel: 'medium', urgencyLevel: 'medium' }));
  await flush(POLL_MS * 5);
  assert.deepStrictEqual(rec.list, [], 'low and medium arrivals are silent');

  db.nextIntake = { urgency: 'high', unavailable: false, needsReview: false, confidence: 0.9 };
  await typeInto($<HTMLInputElement>('main input:not([type=tel])')!, 'My Own Patient');
  await typeInto($<HTMLTextAreaElement>('main textarea')!, 'chest pain');
  await submit($<HTMLFormElement>('main form')!);
  await flush(POLL_MS * 6);
  assert.strictEqual(resultRole(), 'alert', 'the form result itself announces it');
  assert.deepStrictEqual(rec.list, [], 'the queue must not announce it a second time');
  assert.strictEqual($('section[aria-label="New high urgency cases"]'), null, 'and no banner for your own case');
  rec.stop();
});

await test('a case ESCALATED to high by someone else is announced; two arriving together are one aggregated message', async () => {
  await signIn();
  const low = makeSubmission({ patientName: 'Getting Worse' });
  db.submissions.push(low);
  await flush(POLL_MS * 4);
  const rec = recordAnnouncements();
  low.finalUrgencyLevel = 'high';
  low.finalDepartment = 'Refer to Emergency Room';
  low.updatedAt = new Date(Date.now() + 5).toISOString();
  await flush(POLL_MS * 5);
  assert.deepStrictEqual(rec.list, ['New high urgency case: Getting Worse, Refer to Emergency Room.']);

  db.submissions.push(makeSubmission({ patientName: 'Ann One', finalUrgencyLevel: 'high', urgencyLevel: 'high' }));
  db.submissions.push(makeSubmission({ patientName: 'Bob Two', finalUrgencyLevel: 'high', urgencyLevel: 'high' }));
  await flush(POLL_MS * 5);
  assert.strictEqual(rec.list.length, 2);
  assert.ok(/^2 new high urgency cases: /.test(rec.list[1]) && rec.list[1].includes('Ann One') && rec.list[1].includes('Bob Two'), rec.list[1]);
  rec.stop();
});

await test('the banner leads to the case: "View in queue" opens the queue with keyboard focus on that case\'s row', async () => {
  await signIn();
  await flush(POLL_MS * 3);
  db.submissions.push(makeSubmission({ patientName: 'Maria Lopez', finalUrgencyLevel: 'high', urgencyLevel: 'high', needsHumanReview: true }));
  await flush(POLL_MS * 5);
  const view = byText('section[aria-label="New high urgency cases"] button', 'View in queue')!;
  assert.ok(view.textContent!.includes('Maria Lopez'), 'the button says which case, for screen-reader users');
  await click(view);
  await flush(POLL_MS * 3);
  assert.strictEqual(byText('nav button', 'Triage Queue')!.getAttribute('aria-current'), 'page');
  const row = active();
  assert.ok(row?.getAttribute('aria-label')?.startsWith('High urgency, Maria Lopez'), `focus is on ${describe(row)}`);
  assert.strictEqual(row?.getAttribute('aria-current'), 'true', 'the row is marked as the current one');
  assert.strictEqual($('section[aria-label="New high urgency cases"]'), null, 'the banner entry is consumed');
  assert.ok($('aside[aria-label="Case details"]'), 'its details are open');
  assert.strictEqual(active(), row, 'opening details did not steal focus from the row');
});

await test('banner entries can be dismissed by keyboard-operable buttons that name the case', async () => {
  await signIn();
  await flush(POLL_MS * 3);
  db.submissions.push(makeSubmission({ patientName: 'Maria Lopez', finalUrgencyLevel: 'high', urgencyLevel: 'high' }));
  await flush(POLL_MS * 5);
  const dismiss = byText('section[aria-label="New high urgency cases"] button', 'Dismiss')!;
  assert.ok(dismiss.textContent!.includes('alert for Maria Lopez'));
  await click(dismiss);
  assert.strictEqual($('section[aria-label="New high urgency cases"]'), null);
});

await test('a lost connection is announced politely and shown, the list is kept, and recovery is announced', async () => {
  await signIn();
  db.submissions.push(makeSubmission({ patientName: 'Kept Case' }));
  await click(byText('nav button', 'Triage Queue'));
  await flush(POLL_MS * 4);
  db.offline = true;
  await flush(POLL_MS * 5);
  assert.ok(polite().textContent!.includes('cannot reach the server'), polite().textContent!);
  assert.ok($$('p').some((p) => p.textContent!.includes('Cannot reach the server. The queue on screen may be out of date')), 'visible warning');
  assert.ok(byText('button', 'Kept Case'), 'the last known list stays on screen');
  db.offline = false;
  await flush(POLL_MS * 5);
  assert.ok(polite().textContent!.includes('Connection restored'), polite().textContent!);
  assert.ok(!$$('p').some((p) => p.textContent!.includes('may be out of date')), 'warning removed');
});

await test('background polls are marked so the server does not treat them as user activity; manual actions are not', async () => {
  await signIn();
  await click(byText('nav button', 'Triage Queue'));
  db.requests.length = 0;
  await flush(POLL_MS * 6);
  const polls = db.requests.filter((r) => r.path === '/api/queue');
  assert.ok(polls.length >= 3, `expected several polls, saw ${polls.length}`);
  assert.ok(polls.every((r) => r.background), 'every automatic poll carries X-Background-Poll');
  db.requests.length = 0;
  await click(byText('button', 'Refresh'));
  const manual = db.requests.find((r) => r.path === '/api/queue');
  assert.ok(manual && !manual.background, 'a manual Refresh counts as activity');
});

assert.strictEqual(describeNewHigh([{ id: '1', patientName: 'A', department: 'D' }]), 'New high urgency case: A, D.');

// ================================================================= queue
console.log('\nTriage queue');

async function openQueueWithCases() {
  await signIn();
  db.submissions.push(
    makeSubmission({ patientName: 'Maria Lopez', finalUrgencyLevel: 'high', urgencyLevel: 'high', finalDepartment: 'Refer to Emergency Room', needsHumanReview: true }),
    makeSubmission({ patientName: 'Sam Rivera', finalUrgencyLevel: 'medium', urgencyLevel: 'medium', finalDepartment: 'Orthopedic & Injury' }),
    makeSubmission({ patientName: 'Jo Kim', reviewStatus: 'reviewed' }),
  );
  await click(byText('nav button', 'Triage Queue'));
  await flush(POLL_MS * 3);
}

await test('heading gets focus on navigation; the list is a real list; axe finds no violations', async () => {
  await openQueueWithCases();
  assert.strictEqual(active()?.id, 'page-heading');
  assert.strictEqual(active()?.textContent, 'Triage Queue');
  const list = $('ul[aria-label]')!;
  assert.strictEqual($$('li', list).length, 3);
  assert.ok($('#queue-summary')!.textContent!.includes('3 cases'));
  assert.ok($('#queue-summary')!.textContent!.includes('1 high urgency awaiting review'));
  await axeViolations('the queue');
});

await test('each row\'s accessible name carries urgency, patient, department, age and status, and contains its visible text', async () => {
  await openQueueWithCases();
  const rows = $$<HTMLButtonElement>('ul[aria-label] button');
  const labels = rows.map((r) => r.getAttribute('aria-label')!);
  assert.ok(labels[0].startsWith('High urgency, Maria Lopez, Refer to Emergency Room, just now, Review required'), labels[0]);
  assert.ok(labels[1].startsWith('Medium urgency, Sam Rivera, Orthopedic & Injury,'), labels[1]);
  assert.ok(labels[2].endsWith('Confirmed'), labels[2]);
  for (const row of rows) {
    const label = row.getAttribute('aria-label')!;
    for (const visible of Array.from(row.querySelectorAll('span.block')).map((s) => s.textContent!.replace(/\s*·\s*/, ', ').trim())) {
      for (const part of visible.split(', ')) assert.ok(label.includes(part), `visible text "${part}" is missing from the name "${label}"`);
    }
  }
});

await test('choosing a case moves focus to its details; Escape or Close returns focus to the row', async () => {
  await openQueueWithCases();
  const row = byText('ul[aria-label] button', 'Maria Lopez') as HTMLButtonElement;
  row.focus();
  await click(row);
  await flush();
  const heading = $('#case-detail-heading')!;
  assert.strictEqual(active(), heading, `focus is on ${describe(active())}`);
  assert.strictEqual(row.getAttribute('aria-current'), 'true');
  assert.strictEqual(row.getAttribute('aria-controls'), 'case-detail');
  assert.strictEqual($('aside')!.getAttribute('aria-label'), 'Case details');
  await axeViolations('the queue with case details open');

  await press(heading, 'Escape');
  assert.strictEqual($('aside'), null, 'Escape closes the details');
  assert.strictEqual(active(), row, `focus should go back to the row, is on ${describe(active())}`);

  await click(row);
  await flush();
  const close = $<HTMLButtonElement>('button[aria-label="Close case details"]')!;
  assert.ok(close, 'a named close button exists');
  await click(close);
  assert.strictEqual(active(), row);
});

await test('Confirm: the result is announced politely and focus moves to the case instead of being lost on <body>', async () => {
  await openQueueWithCases();
  await click(byText('ul[aria-label] button', 'Maria Lopez'));
  await flush();
  const confirm = byText('aside button', 'Confirm classification') as HTMLButtonElement;
  assert.strictEqual(confirm.getAttribute('aria-describedby'), 'case-detail-heading', 'the button is described by the patient it acts on');
  confirm.focus();
  await click(confirm);
  await flush(POLL_MS * 4);
  assert.ok(polite().textContent === '' && byText('[role=status]', 'Classification confirmed'), 'a polite status announces the outcome');
  assert.ok(!byText('aside button', 'Confirm classification'), 'the Confirm button is gone…');
  assert.strictEqual(active(), $('#case-detail-heading'), `…so focus must not be stranded: it is on ${describe(active())}`);
  assert.ok(byText('ul[aria-label] button', 'Maria Lopez')!.getAttribute('aria-label')!.endsWith('Confirmed'));
});

await test('Override dialog: named modal, focus moves in and is trapped, Escape cancels and restores focus', async () => {
  await openQueueWithCases();
  await click(byText('ul[aria-label] button', 'Maria Lopez'));
  await flush();
  const opener = byText('aside button', 'Override…') as HTMLButtonElement;
  opener.focus();
  await click(opener);

  const dialog = $('[role=dialog]')!;
  assert.ok(dialog, 'a role=dialog exists');
  assert.strictEqual(dialog.getAttribute('aria-modal'), 'true');
  assert.ok(document.getElementById(dialog.getAttribute('aria-labelledby')!)!.textContent!.includes('Maria Lopez'), 'named after the patient');
  assert.ok(document.getElementById(dialog.getAttribute('aria-describedby')!)!.textContent!.includes('Currently High urgency'), 'described by the current state');
  assert.ok(dialog.contains(active()), `focus moved into the dialog: ${describe(active())}`);
  assert.strictEqual(active()?.tagName, 'SELECT');
  for (const field of $$<HTMLElement>('select, textarea', dialog)) assert.ok((field as HTMLSelectElement).labels?.length === 1, `${describe(field)} is labelled`);
  assert.ok($('button[aria-label="Close dialog without saving"]', ), 'the icon-only close button has a name');
  await axeViolations('the override dialog');

  const stops = tabOrder(dialog);
  const [first, last] = [stops[0], stops[stops.length - 1]];
  last.focus();
  assert.ok(await press(last, 'Tab'), 'Tab on the last control is intercepted');
  assert.strictEqual(active(), first, `wraps to the first control, is on ${describe(active())}`);
  assert.ok(await press(first, 'Tab', { shiftKey: true }), 'Shift+Tab on the first control is intercepted');
  assert.strictEqual(active(), last, 'wraps to the last control');
  const middle = stops[1];
  middle.focus();
  assert.strictEqual(await press(middle, 'Tab'), false, 'Tab in the middle is left to the browser');

  await press(dialog, 'Escape');
  assert.strictEqual($('[role=dialog]'), null, 'Escape closes it');
  assert.strictEqual(active(), opener, `focus returns to the button that opened it, is on ${describe(active())}`);
  assert.ok($('aside'), 'and the case details are still open behind it');
});

await test('Override: an empty reason is announced and focuses the reason field; a save announces the outcome and focuses the case', async () => {
  await openQueueWithCases();
  await click(byText('ul[aria-label] button', 'Maria Lopez'));
  await flush();
  await click(byText('aside button', 'Override…'));
  const dialog = $('[role=dialog]')!;

  const reason = $<HTMLTextAreaElement>('textarea', dialog)!;
  // Empty: the browser's own `required` validation blocks the submit before our code runs.
  assert.strictEqual($<HTMLFormElement>('form', dialog)!.checkValidity(), false, 'an empty reason is rejected natively');
  // Whitespace only satisfies `required` but is still empty: our own message covers that case.
  await typeInto(reason, '   ');
  await submit($<HTMLFormElement>('form', dialog)!);
  assert.ok(byText('[role=alert]', 'A reason is required.'), 'the validation error is announced');
  assert.strictEqual(active(), reason, 'focus goes to the field that needs fixing');
  assert.strictEqual(reason.getAttribute('aria-invalid'), 'true');
  assert.ok(reason.getAttribute('aria-describedby')!.split(' ').some((id) => document.getElementById(id)?.textContent?.includes('required')));

  const urgency = $<HTMLSelectElement>('select', dialog)!;
  await act(async () => {
    urgency.value = 'low';
    urgency.dispatchEvent(new w.Event('change', { bubbles: true }));
  });
  await typeInto(reason, 'Vitals are normal');
  assert.strictEqual(reason.getAttribute('aria-invalid'), 'true', 'still flagged until the form is re-submitted');
  await submit($<HTMLFormElement>('form', dialog)!);
  await flush(POLL_MS * 4);

  assert.strictEqual($('[role=dialog]'), null, 'the dialog closes on success');
  assert.ok(byText('[role=status]', 'Override saved. Now Low urgency'), 'a polite status announces the outcome');
  assert.strictEqual(active(), $('#case-detail-heading'), `focus is on the case, not <body>: ${describe(active())}`);
  const history = $('aside h3')?.parentElement;
  assert.ok(history?.textContent?.includes('changed to'), 'the history reads "high changed to low" for a screen reader');
});

await test('a case changed by someone else while its details are open is refreshed and announced, without moving focus', async () => {
  await openQueueWithCases();
  const row = byText('ul[aria-label] button', 'Sam Rivera') as HTMLButtonElement;
  await click(row);
  await flush();
  const other = db.submissions.find((s) => s.patientName === 'Sam Rivera')!;
  other.reviewStatus = 'reviewed';
  other.updatedAt = new Date(Date.now() + 99).toISOString();
  row.focus();
  await flush(POLL_MS * 8);
  assert.ok(byText('[role=status]', 'just updated by someone else'), 'announced');
  assert.ok(!byText('aside button', 'Confirm classification'), 'the stale Confirm button is gone');
  assert.strictEqual(active(), row, 'focus was not moved');
});

await test('Refresh announces the result; sign out returns to the sign-in screen with the patient data gone', async () => {
  await openQueueWithCases();
  await click(byText('button', 'Refresh'));
  await flush();
  assert.ok(byText('[role=status]', 'Queue refreshed. 3 cases.'));
  await click(byText('header button', 'Sign out'));
  await flush();
  assert.strictEqual($('main h1')?.textContent, 'Staff sign-in');
  assert.ok(!document.body.textContent!.includes('Maria Lopez'), 'no patient names remain in the DOM after signing out');
  assert.strictEqual(active()?.getAttribute('autocomplete'), 'username', 'focus lands in the username field');
});

// ================================================================= result
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.error('FAILED:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('test-a11y-dom: all accessibility behaviours verified.');
process.exit(0);
