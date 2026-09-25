# TriageAssist — Testing Report

| | |
|---|---|
| **Application** | TriageAssist — AI-assisted symptom triage queue for Meridian Urgent Care front-desk staff |
| **Report date** | 2026-09-25 |
| **Code under test** | `main` at commit `a7b22c7` (7 commits; the initial build was `1e9df15` on 2026-09-24) |
| **Companion document** | [`SECURITY_CHECKLIST.md`](SECURITY_CHECKLIST.md) |

## 1. Summary

**Result: every automated suite passes, and every defect found is fixed.** Most are covered by a regression
test; the exceptions are listed in §9. That is a statement about the *automated* checks below, not a claim that
the application is ready for real patients — §9 lists what was not tested and what remains open.

| Measure | Result |
|---|---|
| Named checks in the five behaviour suites | **179 / 179 pass** (API 58 · security 60 · privacy 30 · fail-safe 5 · accessibility 26) |
| Unit-level checks (`npm test`) | pass — ≈132 assertion statements, 30 injected AI-failure scenarios |
| WCAG colour-contrast pairs checked | **142 / 142 meet AA** (was 14 failing instances before the accessibility pass) |
| Type-check (`tsc --noEmit`) | 0 errors |
| Production build (`vite build`) | succeeds |
| `npm audit` | 0 vulnerabilities (the only new dependencies are dev-only: `jsdom`, `axe-core`) |
| Defects found and fixed | **40** — 15 functional/resilience, 12 security items (one is clean-up housekeeping), 13 accessibility; plus 6 defects in my own test tooling (§8) |
| Severity of the worst finding | **Critical** — no authentication on any endpoint (§5, S-01) |
| Mutation checks | 10 deliberate regressions, all caught by a specific test (§7) |

Size of the work: 43 files changed since the initial build (+5,321 / −343 lines), including ≈3,000 lines of tests.

## 2. Method and environment

- **How the tests run.** Every behaviour suite boots its **own private copy of the real server** on its own port with a
  throwaway staff account, so it never touches the running dev server. Gemini is either **disabled** (blank key) or
  replaced by a **local fake API** that can be made to hang, error, or return hostile output. Nothing is sent to Google
  and no AI quota is spent. Suites delete the rows and accounts they create (last verified: 0 test rows left behind).
- **What is real:** the Express server, PostgreSQL 16.15 (Docker), the real Gemini SDK (`@google/genai` 2.24.0) talking
  HTTP to the fake, and the real React components (19.3.0) rendered in jsdom 24.1.3 with axe-core 4.13.0.
- **What is not real:** a browser, a screen reader, and — in the automated suites — Gemini itself.
- **Environment:** Windows 11, Node.js 20.3.1, Express 4.22.3, Vite 6, Tailwind 4.
- **Approach:** black-box HTTP checks against the running server; white-box unit tests of the security and
  classification logic; behavioural DOM tests driven by keyboard and mouse events; static analysis for contrast;
  adversarial "canary" tests for data leakage; and **mutation testing** to prove the tests can fail.
- **Verification run for this report:** every suite was executed on 2026-09-25, starting 20:35 UTC, immediately before writing.

## 3. Features tested

Suite key: **UNIT** = `npm test` · **API** = `test:api` · **SEC** = `test:security` · **PRIV** = `test:privacy` ·
**FS** = `test:failsafe` · **A11Y** = `test:a11y` (also part of `npm test`).

| # | Feature | What was verified | Suites |
|---|---|---|---|
| 1 | **Sign-in / sign-out** | Correct and wrong credentials; identical response for unknown user vs wrong password; malformed, oversized and non-string credentials; SQL-injection strings; lockout after 5 failures per client+username and 20 per client; `Retry-After`; cookie flags; new token per login; logout invalidates the token server-side | SEC, UNIT, A11Y |
| 2 | **Sessions** | Idle (30 min) and absolute (12 h) expiry; replay of a captured token after logout; forged/empty/other-name cookies; `Authorization`/`X-User` headers grant nothing; per-user independence; background polls don't extend the idle timer | UNIT, SEC |
| 3 | **Intake form (UI)** | Every field labelled, hints and errors associated; required/optional stated; submit, in-flight state, result card; result is assertive when High or AI-unavailable, polite otherwise; session expiry mid-submit | A11Y |
| 4 | **Intake API** (`POST /api/intake`) | Required fields; length limits; control characters; phone format; wrong types (used to crash the server); whitespace trimming; blank phone stored as `null`; 16 KB body cap; per-user rate limit; hostile text stored verbatim | API, SEC, PRIV, UNIT |
| 5 | **AI classification** | Structured output validated (urgency, department, confidence 0–1, clamping); prompt delimiting and delimiter break-out stripped; only symptom text (never name/phone) sent; API key in a header, not the URL; prompt version recorded | UNIT, PRIV |
| 6 | **AI fail-safe** (the core safety behaviour) | 30 injected failures — errors, sync throws, hangs, stalled bodies, dropped connections, HTTP 401/429/500/503, HTML bodies, non-JSON, fenced JSON, wrong types, unknown enums, out-of-range confidence — all yield **High urgency, 0% confidence, mandatory review** within the deadline; no unhandled rejection escapes; end-to-end through the real server the result is still a `201`, flagged "AI unavailable", and sorts to the top of the queue | UNIT, FS |
| 7 | **Mandatory human review** | Threshold logic (below 0.7 ⇒ review; exactly 0.7 ⇒ trusted); `NaN` fails safe; `CONFIDENCE_THRESHOLD` parsing and startup rejection of junk | UNIT, API |
| 8 | **Triage queue (API)** | Sort high → medium → low then oldest first; re-sorts after override; detail with history and override log; unknown and malformed IDs | API |
| 9 | **Triage queue (UI)** | List semantics and full accessible row names; selection state; details open/close with focus management; polling; "updated by someone else" refresh; sign-out clears patient data from the DOM | A11Y |
| 10 | **Confirm action** | Only `pending` rows (`409` otherwise); reviewer is the signed-in user, never the request body; classification unchanged; no override log created; focus and announcement after confirming | API, SEC, A11Y |
| 11 | **Override action + dialog** | Every invalid input; invalid level/department; reason required, trimmed, length-limited; no-op rejected; original AI suggestion preserved; chained overrides; unicode/long reasons; two concurrent overrides; dialog semantics, focus trap, Escape, focus restoration, validation message | API, SEC, A11Y |
| 12 | **Audit trail** | `override_logs` previous→new chaining; identity cannot be forged; `classification_history` has exactly one row per intake with model and prompt version; fail-safe results recorded as such | API, SEC, FS |
| 13 | **New high-urgency announcements** | Announced once, assertively, on any screen; not for baseline cases, low/medium cases or the user's own submissions; escalations announced; simultaneous arrivals aggregated; banner leads to the case with focus on its row; connection loss/recovery announced | A11Y |
| 14 | **Data minimization** | Symptom text absent from every response, every column of every table, the server log, and Postgres's own log across 18 hostile scenarios (8 Gemini behaviours, 10 malformed/rejected requests) | PRIV |
| 15 | **Account provisioning** (`create-user`) | Account creation, password login, wrong-password refusal (checked by hand); username-format validation | UNIT (validation), manual |
| 16 | **Startup, config and recovery** | `/api/health` minimal; loopback-only binding; production mode (CSP, `Secure` cookie, AI disabled unless paid tier confirmed); Postgres stopped and restarted under a running server (JSON 500s, then automatic recovery — done by hand once, not automated) | SEC, PRIV, manual |
| 17 | **Headers and error hygiene** | Security headers; `Cache-Control: no-store`; no CORS; JSON errors with no stack traces, paths or SQL | SEC |

## 4. Test suite inventory

| Suite | Command | Needs | Checks | Result |
|---|---|---|---|---|
| Unit — review logic | `tsx tests/test-logic.ts` | nothing | 17 assertions | pass |
| Unit — classifier fail-safe | `tsx tests/test-classifier.ts` | nothing | 18 injected failures + happy path + late-rejection check | pass |
| Unit — classifier through the real SDK | `tsx tests/test-classifier-http.ts` | nothing | 12 HTTP failure modes vs a local fake Gemini | pass |
| Unit — security primitives | `tsx tests/test-security-unit.ts` | nothing | 90 assertions: scrypt, sessions, limiter, validation, log safety, delimiter break-out, CSRF guard | pass |
| Accessibility — contrast | `tsx tests/test-a11y-contrast.ts` | nothing | **142 colour pairs** | pass |
| Accessibility — behaviour | `tsx tests/test-a11y-dom.ts` | nothing | **26 checks** + axe-core on 5 screen states | 26 / 26 |
| API edge cases | `npm run test:api` | Postgres | **58 checks** | 58 / 58 |
| Security end-to-end | `npm run test:security` | Postgres | **60 checks**, 4 server processes | 60 / 60 |
| Privacy (canary) | `npm run test:privacy` | Postgres | **30 checks**, 3 server processes + fake Gemini | 30 / 30 |
| Fail-safe end-to-end | `npm run test:failsafe` | Postgres | **5 Gemini failure modes** through the real server | 5 / 5 |

Fail-safe timings from the run: Gemini hang → `201` in 2,049 ms (the 2 s deadline); HTTP 429 / 503 / 401 / garbage → `201` in 61–69 ms.

## 5. Bugs found and fixed

**How to read this.** *Found by* says how the defect was established: **demonstrated** = reproduced against the running
system before fixing; **test** = surfaced by an automated check; **review** = identified by reading the code (and
then covered by a test that proves the fix, but not reproduced beforehand). Severity is my judgement for a clinical
triage tool.

### 5.1 Functional and resilience defects (round 1: API edge cases and failure handling)

| ID | Sev. | Defect | Found by | Fix | Verified by |
|---|---|---|---|---|---|
| B-01 | Med | Malformed IDs (`/queue/not-a-uuid`, on GET, confirm and override) returned **500** instead of 404 | test | UUID check up front → 404 | API |
| B-02 | Med | Re-confirming an already-reviewed case silently **replaced the original reviewer** | test | Only `pending` can be confirmed; `409` | API |
| B-03 | Med | Confirming an **overridden** case flipped it back to "reviewed" | test | same guard; `409` | API |
| B-04 | Low | A no-op override (nothing changed) was accepted and wrote a misleading audit row | test | `400`, no audit row | API |
| B-05 | Low | Oversized body returned an **HTML** 413 page that the UI could not parse | test | JSON error handler | API, SEC |
| B-06 | **High** | A mistyped `CONFIDENCE_THRESHOLD` (`abc` → `NaN`) made `confidence < NaN` always false: **mandatory review silently disabled** | test | fail-safe comparison (`!(x >= t)`) + startup validation | UNIT, API |
| B-07 | **Crit** | A wrong-typed JSON field (`{"patientName":123}`) threw inside an async Express 4 handler → unhandled rejection → **the whole server process died** | **demonstrated** (server unreachable afterwards) | typed field parsing + async error wrapper on every route | API |
| B-08 | **High** | A **hung Gemini call never returned**: the intake request and the UI spinner waited forever (still waiting after 45 s). HTTP errors already fell back correctly | **demonstrated** | hard deadline (`GEMINI_TIMEOUT_MS`, 10 s) using `AbortSignal` + `Promise.race`; late rejections swallowed | UNIT, FS |
| B-09 | Med | An idle Postgres connection error had no listener → would terminate the process | review | pool `error` handler | manual outage test |
| B-10 | Med | No connection/statement timeouts: an unreachable DB would hang requests | review | 5 s connect, 10 s statement timeouts | manual outage test |
| B-11 | Med | When the AI failed, staff were told "confidence below threshold" — misleading for a case that was never classified | review | `classificationUnavailable` flag; red "AI unavailable — triage manually" banners | A11Y, FS |
| B-12 | Med | If an override **saved** but the follow-up refresh failed, the dialog reported "Failed to save" — inviting a duplicate override | review | refresh separated from the save | *no automated test* |
| B-13 | Med | A slow response for a row the user had clicked away from could show **one patient's data under another's name** | review | stale-response guard | *no automated test* |
| B-14 | Low | A failed detail load produced no visible error | review | error shown in the list area | *no automated test* |
| B-15 | Med | No client request timeout; non-JSON responses threw a cryptic parse error; a render error blanked the whole app | review | 30 s timeout, readable messages, error boundary | *no automated test* |

### 5.2 Security defects (round 2: security audit)

| ID | Sev. | Defect | Found by | Fix | Verified by |
|---|---|---|---|---|---|
| S-01 | **Crit** | **No authentication anywhere.** An anonymous request read all 14 patient records and **overrode a chest-pain patient to Low while forging "Dr. Sarah Chen, MD" into the audit trail** | **demonstrated** | staff accounts, sessions, `requireAuth` on every data route, reviewer taken from the session (body names ignored) | SEC (28 checks fail if removed) |
| S-02 | **High** | **Postgres published on all interfaces with the default password**; a query with the default credentials returned patient rows. The app also bound `0.0.0.0` | **demonstrated** | both bound to `127.0.0.1`; container recreated, data intact | SEC (LAN-address probe), manual |
| S-03 | **High** | Patient symptom text is sent to Google. Under Google's **unpaid** Gemini terms content may be used to improve products and read by human reviewers, and users are told not to submit personal information — while the UI said the text was "discarded" | review + Google's published terms | production AI disabled unless `GEMINI_PAID_TIER_CONFIRMED=true`; dev warning; honest UI copy | PRIV |
| S-04 | Med | Symptom text **leaked into server logs** by two paths: JSON `SyntaxError` messages quote a snippet of the model's output, and upstream error messages can quote the request | **demonstrated** (canary) | log-safe error description; fixed strings for parse errors | UNIT, PRIV |
| S-05 | Med | **Introduced by my own first fix and caught by the privacy suite:** I allowed 5xx upstream messages into the log, and a fake API that quoted the request in an HTTP 500 put the patient text in the log | test (PRIV) | allow-list narrowed to 401/403/404/429/503 | UNIT, PRIV |
| S-06 | Med | Postgres errors carry the failing row (`.detail`: patient name and phone) — logged verbatim by every route | review | central `logError` never prints `.detail`, bodies or upstream text | UNIT |
| S-07 | Med | No input length limits, a 1 MB body cap, no rate limit: 5 anonymous 500 KB intakes were accepted (each forwarded to Gemini) | **demonstrated** | field limits, 16 KB cap, per-user intake rate limit | UNIT, SEC |
| S-08 | Med | Prompt injection: patient text could try to instruct the model | review | text delimited as untrusted data, delimiter break-out stripped, prompt v2 — **residual risk remains (§9)** | UNIT, PRIV |
| S-09 | Low | No CSRF/Origin guard, no security headers, cacheable API responses, `X-Powered-By` | review | see checklist §G | SEC |
| S-10 | Low | Browser autofill and spellcheck could store or transmit PHI typed into the form | review | `autocomplete="off"`, `spellcheck=false` | *no automated test* |
| S-11 | Med | Background polling (added for the accessibility work) would have kept idle sessions alive forever, defeating auto-logoff | review | polls marked `X-Background-Poll`; server does not count them as activity | UNIT, SEC, A11Y |
| S-12 | Info | My exploit demonstration left a forged audit entry in your database | — | rows deleted, verified `0` remaining | manual |

### 5.3 Accessibility defects (round 3: accessibility pass)

| ID | Sev. | Defect | Found by | Fix | Verified by |
|---|---|---|---|---|---|
| A-01 | High | Intake and override-dialog `<label>`s were **not associated** with their inputs — 6 fields had no accessible name | review, axe | `htmlFor`/ids; hints and errors via `aria-describedby` | A11Y (labels + axe) |
| A-02 | High | Override "dialog" was a plain `div`: no role, no name, no focus trap, no Escape, focus not restored, close button unnamed | review | real modal (`role=dialog`, `aria-modal`, trap, Escape, restore) | A11Y |
| A-03 | High | After **Confirm** or **Override** the focused button disappeared and **focus fell to `<body>`** | review | focus moved to the case | A11Y (mutation-checked) |
| A-04 | High | Errors, loading states and results were silent to screen readers | review | `role=alert`/`status` regions, always mounted | A11Y |
| A-05 | High | **The queue never refreshed**, so a new high-urgency case from another workstation appeared only if someone pressed Refresh — nothing to announce | review | polling on every screen + assertive announcer + banner | A11Y (mutation-checked) |
| A-06 | Med | Queue rows: unstructured button text, no list, no selected state, details far from the list in DOM order, no way to close | review | list semantics, full row names, `aria-current`, focus to details, Close/Escape | A11Y |
| A-07 | Med | No landmarks, skip link, `h1` focus on navigation, or page titles; sign-in had no heading/`main` | review | added | A11Y |
| A-08 | High | Contrast failures, **5 distinct kinds** (14 instances): white on `emerald-600` 3.67:1 (**the Confirm button**), white on `sky-600` 4.02:1 (all primary buttons), field borders 1.48:1 (need 3:1), `slate-400` close icon/separator 2.63:1, no placeholder colour | **measured** | `emerald-700`/`sky-700` buttons, `slate-500` field borders, explicit placeholder colour | A11Y (142 pairs) |
| A-09 | Med | Busy buttons used `disabled`, which **drops keyboard focus** | review | `aria-disabled` + submit guard | A11Y |
| A-10 | Med | After a failed sign-in the password was cleared but focus stayed elsewhere | review | focus returned to the password field | A11Y |
| A-11 | Med | Row time text "5m ago" is not speakable and violates "label in name" | review | "5 min ago", same string in the name | A11Y |
| A-12 | Low | `aria-controls` on every row pointed at an element that only exists when details are open (invalid ARIA, flagged **critical** by axe). *Introduced by my own new code* | test (axe) | set only while the panel exists | A11Y |
| A-13 | Low | Inconsistent 1 px focus ring; no `prefers-reduced-motion` handling | review | one 3 px ring; motion disabled under reduce | *no automated test (CSS; not browser-verified)* |

## 6. Security measures implemented

Detailed, with evidence per item, in [`SECURITY_CHECKLIST.md`](SECURITY_CHECKLIST.md). In summary:

- **Authentication and sessions** — scrypt password hashes, server-side sessions in an `HttpOnly`, `SameSite=Strict` cookie, idle and absolute expiry, per-login token rotation, logout invalidation, lockout, generic login errors, bounded credential sizes.
- **Integrity of the audit trail** — reviewer identity comes from the session only.
- **Input validation** — shared validation module, field limits, control-character rejection, phone/UUID/enum checks, 16 KB body cap, database `CHECK` constraints.
- **Data protection** — symptom text never stored, logged, or echoed; log sanitiser; paid-tier gate for Google; loopback-only network exposure; optional DB TLS; no-store caching; browser autofill disabled.
- **Abuse limits** — login lockout and per-user intake rate limit.
- **HTTP hardening** — security headers, production CSP, CSRF/Origin guard, no CORS, JSON-only errors without internals.
- **Resilience** — AI deadline and fail-safe, DB timeouts, process-level handlers, async error wrapper.

## 7. Mutation testing (do the tests actually fail?)

Each row is a deliberate regression, run against the suite, then reverted.

| Regression introduced | Suite | Result |
|---|---|---|
| Remove the `requireAuth` middleware (the "unlinked but not protected" bug) | SEC | **28 of 59 checks failed** — every endpoint's "→ 401" check, every forged-credential check, and more |
| Trust `overriddenBy` from the request body again | SEC | 1 failed: "reviewer/overrider names in the request body are ignored" |
| Remove the cross-site guard | SEC | ≥10 failed (every forged-origin request succeeded) |
| Never announce new high-urgency cases | A11Y | 3 failed |
| Poll only while the queue tab is open (the naive design) | A11Y | 5 failed |
| Stop acknowledging the user's own submission | A11Y | 1 failed |
| Leave focus stranded after Confirm | A11Y | 1 failed |
| Unlabel the patient-name field | A11Y | 1 failed (axe + label check) |
| Remove the override dialog's focus trap | A11Y | 1 failed |
| Stop marking polls as background | A11Y | 1 failed |

## 8. Defects in my own test tooling (found and fixed during development)

Listed for transparency — these are not product defects, but each would have produced a false sense of safety.

| ID | Problem | How it surfaced |
|---|---|---|
| T-1 | The contrast scanner's regex desynchronised on apostrophes in JSX text, silently skipping the Confirm button's colours | an expected failure was missing from the baseline; replaced with the TypeScript AST parser |
| T-2 | The scanner treated `text-sm` (a font size) as a text colour, skipping every button | baseline looked too clean; fixed |
| T-3 | Patch scripts twice converted `\b` and `\n` inside string literals into a backspace character and raw newlines | scanner found 0 pairs; `tsc` reported unterminated strings |
| T-4 | The security suite created its target record through the (broken) API, so removing authentication crashed the *setup* instead of reporting "anonymous access succeeded" | mutation testing; target now inserted directly into the database |
| T-5 | One override test expected a custom message where the browser's native `required` validation intervenes first | test failure; now tests the native path and the whitespace-only path separately |
| T-6 | A hard-coded prompt-version constant went stale when the prompt was versioned | test failure; now imports the real constant |

## 9. Not tested, limitations and open risks

**Not tested at all**

- **A real browser.** Nothing was rendered in Chrome, Firefox, Safari or Edge. The CSP is checked only as a *header*; its effect on the built UI is unverified.
- **A real screen reader** (NVDA, JAWS, VoiceOver). jsdom has no layout engine or speech. In particular, whether the assertive announcement is spoken clearly without cutting off other speech is **unverified**.
- **AI classification quality.** The suites use fakes. Only a couple of real Gemini classifications were ever observed (one low-urgency at 0.9 confidence, one low-urgency at 0.1 that was correctly flagged for review) and none was checked against ground truth; **no evaluation set** was run (does chest pain reliably come back High?). The free-tier quota (20 requests/day/model) was also exhausted during development.
- **Load, performance and soak testing.** The queue has no pagination and polls every 15 s per signed-in user.
- **Penetration testing** by an independent party, and **HTTPS/reverse-proxy** deployment.
- **The `Secure` cookie flag in a real browser** (checked as a header only).

**Known limitations**

- Announcements can lag by one poll (15 s); browsers throttle timers in background tabs (Chrome can reach ≈1/min). The tab-title count is the fallback. A push channel (server-sent events) is not built.
- Sessions and rate limiters are **in memory**: a restart signs everyone out and clears lockouts; they do not work across multiple server instances.
- Account management is command-line only; no roles, MFA, password change or self-service reset; a disabled account's open session lasts until restart.
- Patient names and phone numbers are **plaintext at rest**, with no retention policy.
- **Prompt injection cannot be fully eliminated:** a manipulated high-confidence wrong classification is not routed to human review.
- The contrast scan cannot see colours inherited from a differently-coloured ancestor.
- **No automated regression test** for B-12, B-13, B-14, B-15, S-10 or A-13 (fixed and reviewed, but nothing would fail if they regressed). B-09 and B-10 were verified once by hand (Postgres stopped and restarted). Several items (B-09 to B-15, S-06, S-10, and most of §5.3) were identified by code review rather than reproduced before fixing.

## 10. Reproducing these results

```bash
docker compose up -d && npm run migrate     # Postgres (needed by the live suites only)
npm test                                     # unit + security primitives + accessibility (no database)
npm run test:api                             # 58 checks
npm run test:security                        # 60 checks
npm run test:privacy                         # 30 checks
npm run test:failsafe                        # 5 Gemini failure modes
npm run lint && npm run build && npm audit
```

The live suites need only `DATABASE_URL` in `.env`; they use their own ports (3101–3133), never spend AI quota, and clean up after themselves.
