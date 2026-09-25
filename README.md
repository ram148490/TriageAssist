# TriageAssist

**AI-assisted symptom triage queue for Meridian Urgent Care front-desk staff.**

Front-desk staff at Meridian aren't clinically trained and have no fast way to tell which
patients need to be seen first from free-text symptom intake. TriageAssist takes a short
free-text description, classifies it with a structured (non-conversational) AI prompt into
an urgency level, a suggested department, and a confidence score, and surfaces the result in
a staff-facing queue sorted by urgency — with a hard safety net: anything the model isn't
confident about is flagged for mandatory human review and is never silently auto-routed.

## Features

- **Symptom intake form** — patient name, optional phone, free-text symptoms.
- **Structured AI classification** — a single Gemini call constrained by a JSON response
  schema (`urgencyLevel`, `suggestedDepartment`, `confidenceScore`); not open-ended chat.
- **Staff triage queue** — every submission, sorted high → medium → low urgency, oldest
  first within a level.
- **Mandatory human review** — any classification below `CONFIDENCE_THRESHOLD` (default
  0.7) is flagged `needs_human_review` and stays `pending` until a staff member confirms or
  overrides it. If the AI call fails or no API key is configured, the system fails **safe**:
  confidence is pinned to 0, which always forces review.
- **Manual override with audit log** — staff can change the urgency/department on any
  submission. A reason and the staff member's name are required and every override is
  written to `override_logs`, along with the full AI classification history in
  `classification_history`.

- **Staff sign-in required** — every screen and every data endpoint requires a signed-in staff
  account; who confirmed or overrode a case is taken from the session, never typed in.

## Accessibility

Built to WCAG 2.2 AA as far as automated tooling can judge (see the limits below).

- **Labels and structure.** Every form field has a real `<label>` tied to it, with hints and errors
  attached via `aria-describedby`; pages have a single `h1`, a labelled `nav`, a `main` landmark and a
  "Skip to main content" link; the current page is marked `aria-current`. Urgency is always text plus an
  icon shape, never colour alone. Queue rows are a real list whose buttons have full names
  ("High urgency, Maria Lopez, General Urgent Care, 5 min ago, Review required"), and the Confirm/Override
  buttons are described by the patient they act on.
- **Keyboard, end to end.** Sign-in is operable with Tab/Enter alone: focus starts in the username field,
  a failed attempt returns focus to the (cleared) password field, and after signing in focus lands on the
  page heading. Choosing a case moves focus to its details; Escape or Close returns it to the row. After
  Confirm or Override removes the button that had focus, focus moves to the case instead of being lost.
  The override dialog is a real modal: labelled, focus moves in and is trapped, Escape cancels, and focus
  returns to the button that opened it. Buttons stay focusable while busy (`aria-disabled`, never
  `disabled`). One visible 3px focus ring everywhere.
- **Colour and motion.** Text meets 4.5:1 and form-field borders 3:1 (this replaced white-on-`sky-600` and
  white-on-`emerald-600` buttons, and near-invisible field borders); spinners and transitions stop under
  `prefers-reduced-motion`.
- **New high-urgency cases are announced.** The queue is refreshed every 15 seconds on **every** screen (not
  only while the queue tab is open). When a case newly becomes High urgency — arrives, or is escalated by
  someone else's override — an assertive live region says, for example, "New high urgency case: Maria Lopez,
  General Urgent Care." (several at once are combined), a red banner appears with **View in queue** (opens the
  case and puts keyboard focus on its row) and **Dismiss**, the Queue tab shows a count, and the browser tab
  title shows "(2 high)". Cases already there when the app loaded are not announced, and neither are your own
  submissions (the form result announces those) or low/medium cases. If updates stop reaching the server, a
  visible warning and a polite announcement say the queue may be out of date, and another says when it recovers.
  Automatic polls are marked `X-Background-Poll` so the server does **not** count them as activity: an
  unattended screen still signs out after the idle timeout.

Limits, stated plainly:

- **Latency.** A new case is noticed within one poll (15 s), not instantly. Browsers slow timers in background
  tabs (Chrome can drop them to about once a minute), so a hidden tab can be later still — the tab-title count is
  the fallback. The app refreshes immediately when the tab becomes visible or the network returns. A push
  channel (server-sent events) would remove the delay; it isn't built.
- **Not verified with real assistive technology.** The automated checks below drive the real components, but
  jsdom has no layout engine or screen reader. Before relying on this, test with NVDA or JAWS on Windows and
  VoiceOver on macOS/iOS, in particular that the assertive announcement is spoken without cutting off other
  speech, and by keyboard alone in your target browser.
- **Contrast** is computed from the Tailwind palette for colours declared on the same element; a colour
  inherited from a differently coloured ancestor isn't seen.

## Failure handling

The app is designed never to crash or hang on a failure in the path a patient's triage
depends on:

- **AI failure or timeout:** every way the Gemini call can go wrong (no key, network error,
  HTTP 4xx/5xx, a hang, a stalled response, malformed or out-of-range output) resolves to the
  same fail-safe: **High urgency, confidence 0, mandatory human review**. The call has a hard
  deadline (`GEMINI_TIMEOUT_MS`, default 10s), so a hung request can't hang the front desk. The
  intake result and the queue sidebar tell staff explicitly that the AI was unavailable.
- **Database:** connection and statement timeouts stop a dead database from hanging requests, and
  a dropped connection is logged instead of crashing the process. Requests fail with a JSON
  error while it is down and succeed again once it is back.
- **Bad input:** wrong-typed or oversized JSON gets a clean 4xx; route handlers can't take the
  process down; process-level handlers log anything that slips through.
- **UI:** requests time out with a readable message, non-JSON responses are handled, a render
  error is contained by an error boundary, and a failed refresh after a successful save no
  longer reports the save as failed.

## Security

- **Authentication on everything.** All `/api` routes except `/api/health` and the sign-in
  routes return `401` without a valid session — the queue and the confirm/override actions are
  protected on the server, not merely absent from the navigation. Passwords are stored only as
  scrypt hashes; sessions are server-side, in an `HttpOnly`, `SameSite=Strict` cookie, expire
  after 30 minutes of inactivity (and 12 hours absolute), and end on sign-out. The UI also signs
  out an idle workstation and clears patient data from the screen.
- **Brute-force protection.** 5 failed sign-ins per client+username, or 20 per client, lock
  that client out for 15 minutes. Unknown users and wrong passwords are indistinguishable.
- **A tamper-proof audit trail.** The reviewer recorded on a confirm/override is the signed-in
  user; any name in the request body is ignored.
- **Cross-site protection.** `SameSite=Strict` cookies plus rejection of cross-origin
  state-changing requests. No CORS.
- **Input limits.** Name 100, phone 30, symptoms 2,000, override reason 1,000 characters;
  request bodies are capped at 16 KB; intake is rate-limited per user
  (`INTAKE_RATE_LIMIT_PER_MINUTE`, default 30) because each one spends AI quota.
- **Injection.** Every SQL statement is static text with bound parameters. React escapes all
  output and there is no raw-HTML rendering. Patient text is wrapped in delimiters and the
  model is told to treat it as untrusted data (see the residual-risk note below).
- **Hardening.** Loopback-only bind by default (`HOST`), Postgres published on `127.0.0.1` only,
  `nosniff` / `X-Frame-Options: DENY` / `no-referrer`, a strict CSP in production, and
  `Cache-Control: no-store` on all API responses (they contain patient data).
- **Logs cannot leak patient data.** Errors are logged through `server/lib/log.ts`, which never
  prints Postgres row details, request bodies, or upstream messages that could quote the
  patient's text.

### Before this holds real patient data

- **Where the symptom text goes.** It is sent to Google's Gemini API for classification (the
  patient's name and phone are never sent). Under Google's terms for the **unpaid** Gemini API,
  submitted content may be used to improve Google's products and read by human reviewers, and
  Google says not to submit personal or sensitive information. The paid terms don't use prompts
  to improve products. So: **in production the AI is disabled unless you set
  `GEMINI_PAID_TIER_CONFIRMED=true`** (asserting you use a paid-tier key); every case then takes
  the safe manual-review path. In development it works but logs a warning — use synthetic data.
  Those terms don't address HIPAA; if this is a covered entity's workflow, you need a BAA with
  your AI provider (e.g. Vertex AI), which is outside what this app can decide for you.
- **Residual risk: prompt injection.** Delimiters and instructions make it harder to steer the
  model, but can't make it impossible. A manipulated *high-confidence* wrong answer is not
  routed to human review. Treat the AI as advice and keep clinical staff in the loop.
- **Serve it over HTTPS** (a reverse proxy is fine) and set `NODE_ENV=production`, which makes
  the session cookie `Secure`. Use a strong database password (the compose file ships a dev one),
  and `DATABASE_SSL=true` for any database that isn't on the same machine.
- **Stored data.** Patient names and phone numbers are plaintext in Postgres and are kept until
  you delete them; there is no retention job. Encrypt the disk/database volume and define a
  retention policy.
- **Account management is CLI-only.** Creating, resetting and disabling accounts needs shell and
  database access (`npm run create-user`); there is no in-app admin screen, no roles (every
  signed-in user can confirm and override), no password change or "forgot password" flow, and a
  disabled account's open session lasts until the server restarts. A natural next step is an
  admin role with an in-app "Staff accounts" screen and forced password change at first sign-in.
- **Not built:** MFA, roles, per-user session revocation without a restart, and audit-log tamper
  protection at the database level.

## Data minimization

This is health-adjacent data. The raw symptom text a patient/staff member types is sent to
the classifier **once**, in memory, and then discarded — it is **never written to the
database**, never logged, and there is no code path that persists it. Only the classification
outcome (urgency, department, confidence, timestamps, and who reviewed/overrode it) is stored
long-term. See `server/schema.ts` for the full schema.

## Tech stack

- **Frontend:** React 19 + TypeScript, Vite, Tailwind CSS
- **Backend:** Node.js + Express (TypeScript), served from the same process/port as the
  frontend (Vite runs in Express middleware mode in dev; a static build in production)
- **Database:** PostgreSQL (via `pg`)
- **AI:** Google Gemini (`@google/genai`) with `responseSchema`-constrained JSON output

## Project structure

```
TriageAssist/
├── server/
│   ├── index.ts            # Express app entrypoint (dev: Vite middleware, prod: static)
│   ├── db.ts                # pg Pool + idempotent schema setup
│   ├── schema.ts             # CREATE TABLE IF NOT EXISTS ... (source of truth for schema)
│   ├── migrate.ts            # `npm run migrate` — applies schema.ts standalone
│   ├── lib/
│   │   ├── gemini.ts          # Gemini client factory
│   │   ├── classifier.ts      # Structured classification prompt + safe fallback
│   │   └── mappers.ts         # DB row -> API type mapping
│   └── routes/
│       ├── intake.routes.ts   # POST /api/intake
│       └── queue.routes.ts    # GET /api/queue, GET/:id, POST/:id/confirm, POST/:id/override
├── shared/
│   ├── types.ts               # Types shared by client + server (urgency levels, departments, ...)
│   └── logic.ts               # Pure helper functions (review threshold, urgency ranking)
├── src/                       # React app
│   ├── pages/IntakeForm.tsx
│   ├── pages/TriageQueue.tsx
│   └── components/
└── tests/                     # Dependency-free unit tests (no DB required)
```

## Getting started

### 1. Start PostgreSQL

The included `docker-compose.yml` starts a local Postgres instance with credentials that
match `.env.example` exactly, so no extra configuration is needed:

```bash
docker compose up -d
```

If you don't have Docker, install PostgreSQL locally instead and update `DATABASE_URL` in
your `.env` to match.

### 2. Configure environment

```bash
cp .env.example .env
```

Set `GEMINI_API_KEY` to a key from [Google AI Studio](https://aistudio.google.com/app/apikey).
**The app still runs without a key** — every classification simply fails safe (confidence 0,
mandatory review), which is useful for testing the review/override workflow without burning
API calls, but you'll want a real key to see actual classification behavior.

### 3. Install dependencies and set up the database

```bash
npm install
npm run migrate
```

### 4. Create a staff account

Nobody can sign in until an account exists, and there is **deliberately no public signup**:
this is a staff-only tool holding patient data, so anyone able to create their own account would
defeat the authentication. Accounts are provisioned by an administrator on the server. The
password is generated and shown **once**:

```bash
npm run create-user -- alice            # create
npm run create-user -- alice --reset    # issue a new password
npm run create-user -- alice --disable  # block sign-in
```

### 5. Run it

```bash
npm run dev
```

Open http://localhost:3000. Submit an intake on the "New Intake" tab, then switch to
"Triage Queue" to see it sorted by urgency, confirm/override it, and see the audit trail.

## Configuration

| Variable | Purpose | Default |
| --- | --- | --- |
| `DATABASE_URL` | PostgreSQL connection string | — (required) |
| `GEMINI_API_KEY` | Gemini API key for classification | — (falls back to mandatory-review-everything if unset) |
| `CONFIDENCE_THRESHOLD` | Confidence below this (0–1) forces mandatory human review. The server refuses to start if it isn't a number between 0 and 1. | `0.7` |
| `GEMINI_TIMEOUT_MS` | Hard deadline for the AI call (including retries). Past this the fail-safe result is used | `10000` |
| `PORT` | Local server port | `3000` |
| `HOST` | Address to bind. Keep the default unless a TLS reverse proxy is in front | `127.0.0.1` |
| `SESSION_IDLE_MINUTES` / `SESSION_MAX_HOURS` | Sign-out after this much inactivity / this long in total | `30` / `12` |
| `COOKIE_SECURE` | Force the `Secure` flag on the session cookie (defaults to on when `NODE_ENV=production`) | — |
| `INTAKE_RATE_LIMIT_PER_MINUTE` | Intake submissions allowed per user per minute | `30` |
| `GEMINI_PAID_TIER_CONFIRMED` | Set to `true` to assert the key is on Google's paid terms. **Required for AI classification in production** | — |
| `DATABASE_SSL` | Set to `true` to require TLS to the database | — |

## npm scripts

| Script | Description |
| --- | --- |
| `npm run dev` | Start the combined Express + Vite dev server |
| `npm run migrate` | Apply the database schema (idempotent, safe to re-run) |
| `npm run build` | Build the production client bundle + bundle the server |
| `npm start` | Run the production build |
| `npm run lint` | Type-check the whole project |
| `npm run create-user -- <name>` | Create a staff account (or `--reset` / `--disable`) |
| `npm test` | Dependency-free unit tests (classifier fail-safe, security primitives, validation, log safety) and the accessibility checks below |
| `npm run test:a11y` | Accessibility only: WCAG contrast of every colour pair + axe-core and keyboard/live-region behaviour of the real UI in jsdom |
| `npm run test:api` | API edge cases against its own server + Postgres (see Testing notes) |
| `npm run test:security` | Authentication, sessions, lockout, CSRF, headers, rate limits (own servers; needs Postgres) |
| `npm run test:privacy` | Proves the symptom text never reaches the DB, logs or responses on any path (own servers; needs Postgres) |
| `npm run test:failsafe` | End-to-end proof that a Gemini failure/timeout still yields the High-urgency fail-safe (boots its own server; needs Postgres) |

## Testing notes

`npm test` covers everything that doesn't need a database: the confidence threshold decision
(including NaN fail-safe and threshold parsing), and the classifier fail-safe. The classifier
is tested against ~30 injected failure modes (errors, hangs, malformed or out-of-range model
output) both with fake clients and through the real Gemini SDK over HTTP against a
misbehaving local server. It does **not** exercise the Express routes or Postgres.

`npm run test:failsafe` is the end-to-end version of the core safety check: it boots the real
server against a fake Gemini that hangs / returns 429 / 503 / garbage, submits an intake, and
asserts staff still get a 201 with High urgency, 0% confidence, mandatory review and an
"AI unavailable" flag within the deadline, sorted to the top of the queue. It needs Postgres
but no API key, and deletes its own rows.

The live suites (`test:api`, `test:security`, `test:privacy`, `test:failsafe`) each boot **their own
copy of the server** on a private port with a throwaway staff account and Gemini disabled or faked,
so they never touch your running dev server, spend no AI quota, and send nothing to Google. They need
Postgres (`docker compose up -d && npm run migrate`), and they delete the rows and accounts they create.

- `test:api` — validation, malformed IDs, oversized/invalid JSON, the confirm/override state rules,
  audit-trail chaining, concurrent overrides, and wrong-typed fields that used to crash the server.
- `test:security` — background polling can't defeat the idle timeout; every data endpoint returns 401 anonymously *and* anonymous calls change nothing;
  forged cookies/headers; session cookie flags, fixation, logout replay; lockout; forged names in the
  audit trail; cross-site requests; input limits; headers and error hygiene; loopback-only binding;
  the per-user rate limit; production CSP.
- `test:privacy` — plants a canary string in the symptom text, drives the real server through every
  Gemini failure mode (a fake API that echoes the text back in its errors), plus malformed and rejected
  requests, then searches the server logs, every API response, every column of every database table
  and Postgres's own log for it. Also checks exactly what is sent to Gemini, and the paid-tier gate.
- `test:a11y` (also part of `npm test`; needs no database) — a static WCAG contrast check that resolves Tailwind's
  own palette for every text/background pair, field border and placeholder in `src/`, plus behaviour tests that mount
  the real `<App>` in jsdom against a fake API, press keys and follow focus: the sign-in flow, labels on every
  control, axe-core (no violations) on the sign-in, intake, queue, case-details and override-dialog states, focus
  trap and restoration, focus after Confirm/Override, and the new-high-urgency announcement (exactly once, on any
  screen, not for your own submissions, aggregated, escalations, banner leads to the case, connection loss).
  Mutation-checked: removing the announcement, restricting polling to the queue tab, the focus trap, a field label,
  or the post-Confirm focus fix each makes a specific test fail.
- `test:failsafe` — a Gemini hang / 401 / 429 / 503 / garbage still yields a 201 with High urgency,
  0% confidence, mandatory review and an "AI unavailable" flag, sorted to the top of the queue.

The React UI is not covered by automated tests. Before relying on this in a real clinic
workflow, run it through the actual UI with realistic (synthetic) intake text, including
deliberately vague ones, to confirm they land in mandatory review.

## API reference

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/auth/login` | Sign in with `{username, password}`; sets the session cookie. `401` generic on failure, `429` when locked out |
| `POST` | `/api/auth/logout` | End the session |
| `GET` | `/api/auth/me` | The signed-in user, or `401` |
| `POST` | `/api/intake` | Submit a new symptom intake; classifies and stores the outcome only. `400` on missing/non-string fields |
| `GET` | `/api/queue` | List all submissions, sorted by urgency |
| `GET` | `/api/queue/:id` | One submission + its classification history + override log. `404` for an unknown or malformed id |
| `POST` | `/api/queue/:id/confirm` | Staff confirms the AI classification as-is. Only `pending` submissions: `409` if already confirmed or overridden |
| `POST` | `/api/queue/:id/override` | Staff overrides urgency/department; reason required, logged. `400` if nothing would change |

Everything except `/api/health` and the three `/api/auth` routes requires a session (`401` otherwise). No request accepts a reviewer name: the signed-in user is recorded.

All errors are JSON: `{ "success": false, "error": "…" }` (including `400` for invalid JSON and `413` for bodies over 1 MB).
