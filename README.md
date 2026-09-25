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

### 4. Run it

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
| `PORT` | Local server port | `3000` |

## npm scripts

| Script | Description |
| --- | --- |
| `npm run dev` | Start the combined Express + Vite dev server |
| `npm run migrate` | Apply the database schema (idempotent, safe to re-run) |
| `npm run build` | Build the production client bundle + bundle the server |
| `npm start` | Run the production build |
| `npm run lint` | Type-check the whole project |
| `npm test` | Run the dependency-free unit tests (classification fallback safety, review-threshold logic) |
| `npm run test:api` | API edge-case suite against a **running** server + Postgres (see Testing notes) |

## Testing notes

`npm test` covers the pure logic that doesn't require a live database: the confidence
threshold decision (including NaN fail-safe and threshold parsing) and the fail-safe
classifier fallback. It does **not** exercise the Express routes or Postgres.

`npm run test:api` does. It runs ~55 edge-case checks against a running server
(`docker compose up -d && npm run migrate && npm run dev`, then in another terminal
`npm run test:api`): input validation, malformed IDs, oversized/invalid JSON, the
confirm/override state rules, audit-trail chaining, concurrent overrides, and that the
raw symptom text is never returned. Flags: `--strict` (treat suspected-bug "GAP" results
as failures), `--include-crash` (also send wrong-typed fields; a regression check for
inputs that used to crash the server). Set `BASE_URL` to target a non-default port.

**It writes to the database.** Test rows are named `EDGE-TEST …`; remove them with
`DELETE FROM intake_submissions WHERE patient_name LIKE 'EDGE-TEST%';`. Don't run it against real
data. The fail-safe check only runs when `GEMINI_API_KEY` is unset (otherwise classification
isn't deterministic) and reports SKIP.

The React UI is not covered by automated tests. Before relying on this in a real clinic
workflow, run it through the actual UI with realistic (synthetic) intake text, including
deliberately vague ones, to confirm they land in mandatory review.

## API reference

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/intake` | Submit a new symptom intake; classifies and stores the outcome only. `400` on missing/non-string fields |
| `GET` | `/api/queue` | List all submissions, sorted by urgency |
| `GET` | `/api/queue/:id` | One submission + its classification history + override log. `404` for an unknown or malformed id |
| `POST` | `/api/queue/:id/confirm` | Staff confirms the AI classification as-is. Only `pending` submissions: `409` if already confirmed or overridden |
| `POST` | `/api/queue/:id/override` | Staff overrides urgency/department; reason required, logged. `400` if nothing would change |

All errors are JSON: `{ "success": false, "error": "…" }` (including `400` for invalid JSON and `413` for bodies over 1 MB).
