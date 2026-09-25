# TriageAssist — Security Checklist

| | |
|---|---|
| **Scope** | The TriageAssist web app, its API, its Postgres database, and its use of Google Gemini |
| **Date / code** | 2026-09-25 · `main` at commit `a7b22c7` |
| **Companion** | [`TESTING_REPORT.md`](TESTING_REPORT.md) (defect IDs such as S-01 refer to it) |

**Legend.** ✅ implemented **and verified** — by an automated test, or, where the evidence says *manual*, by a one-off check made by hand ·
🟡 implemented but **not** automatically tested, or only partly implemented · ❌ **not** implemented (a known gap).
**Evidence** names the suite: UNIT = `npm test` · API = `test:api` · SEC = `test:security` · PRIV = `test:privacy` ·
FS = `test:failsafe` · A11Y = `test:a11y` · *manual* = checked by hand once.

> **This checklist describes what the code does. It is not a certification.** No independent penetration test has been done,
> the app has not been deployed behind HTTPS, and §J lists open risks that matter before it holds real patient data.

---

## A. Authentication and session management

| Control | Status | How it works | Evidence |
|---|---|---|---|
| Every data endpoint requires a signed-in user | ✅ | `requireAuth` mounted before all `/api` routes except `/api/health` and `/api/auth/*`; unknown `/api` paths also return 401 to anonymous callers | SEC (12 endpoints × anonymous → 401; **28 checks fail if the middleware is removed**) |
| Anonymous requests have no side effects | ✅ | Target record and row counts verified unchanged after the anonymous attempts | SEC |
| Passwords hashed with a slow, salted KDF | ✅ | scrypt (N=16384, r=8, p=1, 64-byte key, 16-byte random salt); NFKC-normalised; stored as `scrypt$N$r$p$salt$hash` so parameters can be raised later | UNIT |
| Constant-time comparison; malformed hashes fail closed | ✅ | `timingSafeEqual`; tampered/short/foreign-scheme hashes verify as false without throwing | UNIT |
| No user enumeration | ✅ | Unknown user still runs a full scrypt verification against a dummy hash; identical 401 body for unknown user and wrong password | SEC (bodies compared byte-for-byte) |
| Brute-force lockout | ✅ | 5 failures per (client, username) or 20 per client in 15 min → `429` + `Retry-After`; even the correct password is refused while locked | SEC |
| Bounded work for unauthenticated callers | ✅ | Username ≤ 64, password ≤ 256 characters, non-strings rejected (`400`) — keeps scrypt cost bounded | SEC |
| Session tokens | ✅ | 32 random bytes (base64url); the server keeps only the **SHA-256** of each token | UNIT |
| Session cookie flags | ✅ | `HttpOnly`, `SameSite=Strict`, `Path=/`, session cookie (no `Max-Age`); `Secure` when `NODE_ENV=production` or `COOKIE_SECURE=true` | SEC (header inspected; **not** tested in a real browser) |
| Session fixation | ✅ | New token on every login; the session presented with the login request is destroyed | SEC |
| Idle and absolute expiry | ✅ | 30 min idle (`SESSION_IDLE_MINUTES`), 12 h absolute (`SESSION_MAX_HOURS`); expired sessions purged | UNIT (injected clock), SEC (3-second server) |
| Automatic polling does not extend a session | ✅ | Polls send `X-Background-Poll: 1`; the server does not count them as activity | UNIT, SEC, A11Y |
| Logout invalidates the token server-side | ✅ | Replaying a captured token after logout → 401 | SEC |
| Forged credentials grant nothing | ✅ | Random/empty/other-name cookies, `Authorization: Bearer/Basic`, `X-User`/`X-Role` headers, SQL in the cookie → 401 | SEC |
| Client auto-logoff clears patient data from the screen | 🟡 | 30 min without input → sign-out; unmounting the pages discards PHI held in state. Sign-out is tested; the **idle timer is not**. The UI's 30 min is hard-coded and does not follow `SESSION_IDLE_MINUTES` | A11Y (sign-out only) |
| No public signup | ✅ | By design: accounts are provisioned by an administrator (`npm run create-user`) | design; SEC (no such route) |
| Generated passwords; never on the command line | ✅ | 20 characters from an alphabet without look-alikes; printed once; not accepted as an argument (shell history) | UNIT (generator), *manual* |
| Multi-factor authentication | ❌ | — | — |
| Password change / reset flow, password policy for self-chosen passwords | ❌ | Reset is CLI-only (`--reset`) | — |
| Immediate revocation of an open session when a user is disabled | ❌ | Takes effect on server restart | — |

## B. Authorization and audit-trail integrity

| Control | Status | How it works | Evidence |
|---|---|---|---|
| Reviewer/overrider identity comes from the session only | ✅ | `req.user.username` is recorded; `confirmedBy`, `overriddenBy`, `reviewedBy`, `username`, `user` in the body are ignored | SEC, API (mutation: trusting the body fails a test) |
| Audit rows cannot be edited or deleted through the API | ✅ | No update/delete endpoints for `override_logs` or `classification_history` | SEC (`PUT`/`DELETE` → 401 anonymous; no such routes) |
| Every override is logged atomically | ✅ | Row lock (`FOR UPDATE`) + `BEGIN…COMMIT`; previous→new chain verified, including under concurrency | API |
| A rejected override writes nothing | ✅ | 9+ invalid-input cases each leave the log count unchanged | API |
| The AI's original suggestion is preserved | ✅ | Overrides change only `final_*` columns | API |
| The fail-safe is recorded as such | ✅ | `classification_history.model_name = 'unavailable-fallback'` | FS |
| Confirm only applies to pending cases | ✅ | `409` if already confirmed/overridden; the first reviewer is never replaced | API |
| Roles / least privilege | ❌ | Every signed-in user can confirm **and** override; no admin/clinical split | — |
| Tamper-evidence of the audit tables at database level | ❌ | A DB administrator could edit rows; no hash chain or append-only enforcement | — |

## C. Data protection (patient data)

| Control | Status | How it works | Evidence |
|---|---|---|---|
| **Raw symptom text is never persisted** | ✅ | One code path touches it (intake route → classifier); no table has a column that could hold it | PRIV (every column of every table searched; schema scanned for free-text columns) |
| …never logged | ✅ | Sanitising logger (see §H); a canary planted in the text was searched for in the server log across 18 hostile scenarios | PRIV |
| …never returned by the API | ✅ | Absent from every response, including error responses and echoed-back attempts | PRIV |
| …not in Postgres's own log | ✅ | Searched in the database container's log | PRIV |
| Only the symptom text is sent to Gemini | ✅ | The patient's **name and phone are never sent**; the API key travels in a header, not the URL | PRIV |
| Sending patient text to Google is gated | ✅ | **Production:** AI is disabled (safe manual-review path) unless `GEMINI_PAID_TIER_CONFIRMED=true`. **Development:** works, with a startup warning. UI copy says the text is sent to an AI service | PRIV |
| Google's terms are acceptable for the intended use | ❌ | The app cannot know the tier of a key. Unpaid terms allow product improvement and human review; **the terms do not address HIPAA — a BAA with a suitable provider is the operator's decision** | — |
| Data minimisation of what is stored | ✅ | Only name, optional phone, classification, review state, timestamps and reviewer are stored | PRIV, API |
| Network exposure | ✅ | App binds `127.0.0.1` (`HOST` to change); Postgres published on `127.0.0.1:5432` only | SEC (server unreachable via the LAN address); *manual* (port listing) |
| Database credentials | 🟡 | Ships with a **development** password (`triageassist`) in `docker-compose.yml`/`.env.example`; fine on loopback, unacceptable elsewhere | — |
| Encryption in transit to the database | 🟡 | `DATABASE_SSL=true` enables TLS with certificate verification; off by default; untested | — |
| Encryption in transit to the browser | ❌ | The app speaks plain HTTP; **HTTPS must be provided by a reverse proxy**. `NODE_ENV=production` then makes the cookie `Secure` | — |
| Encryption at rest | ❌ | Names and phone numbers are **plaintext** in Postgres | — |
| Retention / deletion / right to erasure | ❌ | Records are kept until manually deleted; no retention job, no delete endpoint | — |
| PHI in the browser | 🟡 | API responses are `Cache-Control: no-store`; `autocomplete=off` and `spellcheck=false` on PHI fields; no `localStorage`/`sessionStorage`/JS-readable cookies used; PHI cleared from the DOM on sign-out. Headers and sign-out are tested; the autofill attributes are **not** | SEC, A11Y |
| PHI in URLs | ✅ | Paths carry only random UUIDs, never names or symptoms (the URL-path canary is not echoed or logged) | PRIV |
| Backups | ❌ | Out of scope; none exist | — |

## D. Input validation rules

All rules are enforced **on the server** (`shared/validation.ts`, route handlers). The forms' `maxLength`/`required` are conveniences only.
All database access uses bound parameters.

| Input | Rule | Rejected with | Evidence |
|---|---|---|---|
| `patientName` | required string; trimmed; 1–100 characters; **no control characters** (newline, NUL, …) | `400` | UNIT, API, SEC |
| `contactPhone` | optional; must be a string; blank → `null`; otherwise 3–30 characters from `0-9 + ( ) - . x #` and spaces | `400` | UNIT, SEC |
| `symptomText` | required string; trimmed; 3–2,000 characters; control characters rejected **except** tab/newline/CR; never stored | `400` | UNIT, API, SEC, PRIV |
| Override `newUrgencyLevel` | exactly `high` \| `medium` \| `low` (case-sensitive; non-strings rejected) | `400` | API |
| Override `newDepartment` | exactly one of the 6 defined departments | `400` | API |
| Override `reason` | required; trimmed; 1–1,000 characters; control characters rejected except tab/newline/CR | `400` | UNIT, API |
| Override that changes nothing | same urgency **and** department as now | `400` | API |
| `:id` path parameter | must be a UUID; anything else is a definite miss | `404` | UNIT, API |
| Login `username` / `password` | strings only; username trimmed, lower-cased, ≤ 64; password ≤ 256 | `400` | SEC |
| Request body | JSON only; **≤ 16 KB** | `400` invalid JSON · `413` too large (JSON body) | API, SEC |
| Cross-site state changes | non-GET must not be `Sec-Fetch-Site: cross-site` and any `Origin` must equal `Host` (incl. `null`, other ports, unparseable) | `403` | UNIT, SEC |
| `create-user` username | `^[a-z0-9][a-z0-9._-]{2,31}$` (3–32 characters) | CLI error | UNIT |
| `CONFIDENCE_THRESHOLD` (env) | number in [0, 1]; empty → 0.7; anything else refuses to start | startup error | UNIT (the parser; **starting the server with a bad value is not tested**) |
| AI output | `urgencyLevel` and `suggestedDepartment` in their enums; `confidenceScore` a finite number, **clamped** to [0, 1]; anything else → fail-safe | fail-safe result | UNIT, FS |
| Wrong JSON types on every field (numbers, objects, arrays, `null`) | treated as "not provided" → validation error; never reaches `.trim()` | `400`, server stays up | API, SEC |
| Database `CHECK` constraints (defence in depth) | urgency/review-status enums, confidence 0–1, non-blank override reason, lower-case 3–32 character usernames | error → generic `500` | 🟡 schema-level; **not individually tested** |

## E. Injection and output handling

| Threat | Status | Control | Evidence |
|---|---|---|---|
| SQL injection | ✅ | Every statement is static SQL with `$n` parameters (grep found no string-built queries); hostile names/usernames/cookies stored or rejected harmlessly | API, SEC |
| Cross-site scripting | 🟡 | React escapes all output; no `dangerouslySetInnerHTML`, `innerHTML`, `eval`; production CSP (`script-src 'self'`). `<script>` text stored verbatim and returned as data. CSP is tested as a **header only** | API, SEC |
| Prompt injection | 🟡 | Patient text is wrapped in `<patient_intake>` tags, any attempt to close/reopen the tag is stripped, and the system prompt tells the model to treat it as data and lower its confidence if suspicious. **Model behaviour under attack is not tested; a manipulated high-confidence answer still skips human review** | UNIT (delimiting), PRIV (what is sent) |
| CSRF | ✅ | `SameSite=Strict` cookie **plus** Origin / `Sec-Fetch-Site` rejection; login CSRF covered; `text/plain` "simple requests" and sandboxed-iframe (`Origin: null`) covered | SEC |
| Log forging | ✅ | Control characters stripped and length capped in every logged string | UNIT |
| Command / path injection | ✅ | No shell, `exec`, or file access driven by request data | grep |
| Open redirect / SSRF | ✅ | No redirects; the only outbound request is to the Gemini endpoint. It can be redirected only by the operator's environment (`GOOGLE_GEMINI_BASE_URL`, which the tests use to point at a fake), never by request data | review |

## F. Error handling coverage

Every row below is a failure that was deliberately provoked.

| Failure | Behaviour | Staff / caller sees | Evidence |
|---|---|---|---|
| **Gemini: no key, network error, hang, stalled body, dropped connection** | **Fail-safe: High urgency, confidence 0, mandatory review**; hard 10 s deadline (`GEMINI_TIMEOUT_MS`) with the request aborted | `201`, red "AI unavailable — triage manually" banner | UNIT (18), UNIT/HTTP (12), FS |
| **Gemini: HTTP 401 / 403 / 404 / 429 / 500 / 503** | Same fail-safe | same | UNIT/HTTP, FS |
| **Gemini: HTML or non-JSON body; JSON `null`/array/string; missing fields; unknown enum; string/`null` confidence; fenced JSON** | Same fail-safe | same | UNIT, UNIT/HTTP |
| Gemini: confidence outside 0–1 | **Clamped**, not failed | normal result | UNIT |
| Gemini: rejection arrives *after* the deadline | Swallowed — no unhandled rejection | — | UNIT (`unhandledRejection` listener) |
| Database down at request time | JSON `500` "Failed to…", no internals; server stays up; **recovers automatically** when the DB returns | error message | *manual* (run once) |
| Database idle-connection error | Logged (sanitised), pool reconnects | — | *manual* |
| Database connect / statement timeout | 5 s / 10 s, then `500` | error message | 🟡 configured; not tested |
| Transaction failure | `ROLLBACK`; no partial intake or override | `500` | API (atomicity of override log) |
| Malformed JSON · oversized body | `400` / `413` as JSON | readable message | API, SEC |
| Wrong-typed fields | `400`; **the process no longer dies** | validation message | API |
| Unknown route · malformed ID | JSON `404` | "Not found" | API, SEC |
| Unauthenticated / expired session | `401` → UI returns to sign-in with a notice; patient data cleared | "Your session has ended" | SEC, A11Y |
| Cross-site request | `403` | — | SEC |
| Rate limit / lockout | `429` + `Retry-After` | "Too many…" | SEC |
| Conflicting state (confirm non-pending) · no-op override | `409` · `400` | explanatory message | API |
| Two concurrent overrides | Serialised by a row lock; audit chain consistent | both succeed | API |
| Unexpected exception in a route | Caught by the async wrapper → JSON `500`, sanitised log line | "Internal server error." | API |
| Unhandled promise rejection (anywhere) | Logged (sanitised); server keeps running | — | 🟡 handler present; not directly tested |
| Uncaught exception | Logged; process exits with code 1 so it can be restarted cleanly | — | 🟡 handler present; **not tested** |
| Server unreachable / slow (browser) | 30 s timeout with a readable message; polling shows a warning banner + announcement, keeps the last list, announces recovery | banner | A11Y |
| React render error | Error boundary; "Reload" button | alert | 🟡 present; not tested |
| Invalid `CONFIDENCE_THRESHOLD` at startup | Server refuses to start | startup error | 🟡 UNIT for the parser; **booting with a bad value is not tested** |
| Errors never leak internals | No stack traces, file paths, SQL or driver names in any error body | — | SEC |

**Error-handling coverage: 24 failure scenarios — 17 are covered in full by an automated test; 7 are only partly tested or checked by hand once (marked 🟡 or *manual*): database down, database idle-connection error, database timeouts, unhandled rejection, uncaught exception, React render error, and startup with an invalid threshold.**

## G. Network and HTTP hardening

| Control | Status | Detail | Evidence |
|---|---|---|---|
| Loopback-only bind | ✅ | `HOST` defaults to `127.0.0.1` | SEC |
| CORS | ✅ | Not enabled; no `Access-Control-Allow-Origin` on GET or preflight | SEC |
| `X-Content-Type-Options: nosniff` | ✅ | | SEC |
| `X-Frame-Options: DENY` · CSP `frame-ancestors 'none'` | ✅ | | SEC |
| `Referrer-Policy: no-referrer` | ✅ | | SEC |
| `Cross-Origin-Opener-Policy` / `Cross-Origin-Resource-Policy: same-origin` · `Permissions-Policy` | 🟡 | Set; not asserted by a test | — |
| Content-Security-Policy (production) | 🟡 | `default-src 'self'`; `script-src 'self'` (no inline/eval); `style-src 'self' 'unsafe-inline'` (deliberate, see below); `img-src 'self' data:`; `connect-src 'self'`; `object-src 'none'`; `base-uri 'none'`; `form-action 'self'`; `frame-ancestors 'none'`. Header verified; **effect on the built UI not verified in a browser** | SEC |
| `Cache-Control: no-store` on `/api` (including 401s) | ✅ | Keeps patient data out of browser and proxy caches | SEC |
| `X-Powered-By` removed | ✅ | | SEC |
| Request-size cap | ✅ | 16 KB JSON | API, SEC |
| Rate limiting | ✅ | Login (above) and intake: **30/min per user** (`INTAKE_RATE_LIMIT_PER_MINUTE`), `429` + `Retry-After`, other users unaffected | SEC |
| HTTPS / HSTS | ❌ | Not provided by the app; add at the reverse proxy | — |
| `Secure` cookie over real HTTPS | 🟡 | Flag set in production; not tested in a browser | SEC (header) |

*`style-src 'unsafe-inline'` is deliberate: the app has no HTML-injection sinks and UI libraries commonly set inline style attributes. Removing it is a possible hardening step once verified in a browser.*

## H. Logging and monitoring

| Control | Status | Detail | Evidence |
|---|---|---|---|
| Central sanitising logger | ✅ | `server/lib/log.ts`: prints error class, code and a safe message; **never** Postgres `.detail` (patient name/phone), request bodies, or upstream text that could quote the request | UNIT, PRIV |
| `SyntaxError` messages withheld | ✅ | Node's JSON errors quote input | UNIT, PRIV |
| Gemini errors: allow-list | ✅ | Google's own text is logged only for **401 / 403 / 404 / 429 / 503** (decided before content is processed — diagnostic value for key/quota/capacity problems). **400 and 5xx bodies are withheld** because a fake API that quoted the request in a 500 leaked the canary (S-05) | UNIT, PRIV |
| Control-character / newline stripping | ✅ | Prevents forged log lines | UNIT |
| No access log of request bodies | ✅ | None is written | PRIV |
| Operator visibility of AI outages | ✅ | Each fail-safe event logs a one-line reason (e.g. `HTTP 429 RESOURCE_EXHAUSTED: You exceeded your current quota`) | PRIV |
| Security-event logging (failed logins, lockouts, forbidden origins) | ❌ | Not logged; no alerting or monitoring | — |
| Central log retention / SIEM | ❌ | Console only | — |

## I. Secrets, configuration and dependencies

| Control | Status | Detail | Evidence |
|---|---|---|---|
| `.env` is git-ignored and was **never committed** | ✅ | `git log --all -- .env` is empty | *manual* |
| No real secrets in git history | ✅ | History scanned for Gemini key shapes (`AIza…`, `AQ.…`), key assignments and DB URLs: only the placeholders/dev defaults in `.env.example` | *manual* |
| No key in the client bundle | ✅ | Built `dist/` searched for the key value and key-shaped strings; the client never reads `process.env` | *manual* |
| Secrets scanned before committing | ✅ | The staged diff was checked for the real key and the generated account password before the two large commits (`696aab3`, `a7b22c7`); the earlier history was scanned separately (row above). Not automated: there is no pre-commit hook | *manual* |
| API key handling | ✅ | Sent as `x-goog-api-key` (verified by capturing the SDK's request), never in a URL or log | PRIV |
| Dependency vulnerabilities | ✅ | `npm audit`: **0** | *manual* (re-run for this report) |
| New dependencies | ✅ | None at runtime; dev-only `jsdom`, `axe-core`, `@types/jsdom` | — |
| **Node.js runtime version** | 🟡 | This machine runs **Node 20.3.1 (mid-2023)**, which has had many security fixes since. `package.json` only requires `>=20`. **Upgrade to a current LTS** | — |
| Container image | 🟡 | `postgres:16-alpine` is a floating tag; pin and update deliberately | — |
| Startup validation of security-relevant config | 🟡 | `CONFIDENCE_THRESHOLD` validated; no check that `HOST`/`COOKIE_SECURE`/HTTPS are sane for production | — |

## J. Open risks and not implemented (read before using with real patient data)

| # | Risk | Impact | Suggested mitigation |
|---|---|---|---|
| 1 | **Plaintext names and phone numbers at rest; no retention or erasure** | breach exposes PHI; compliance | encrypt the volume/database; define retention; add a deletion job |
| 2 | **No HTTPS in the app** | credentials and PHI in clear text on the network | terminate TLS at a reverse proxy; set `NODE_ENV=production` |
| 3 | **Google terms / no BAA** | patient text may be used to improve products (unpaid tier); HIPAA not addressed | paid tier and a BAA (or a provider that offers one); set `GEMINI_PAID_TIER_CONFIRMED` only when true |
| 4 | **Prompt injection cannot be fully prevented** | a manipulated high-confidence wrong answer skips human review | keep clinical staff in the loop; consider sampling high-confidence results for review |
| 5 | **Behind a reverse proxy, `req.ip` is the proxy's address** (Express `trust proxy` is not configured) | the login lockout would apply to **all users at once** (one attacker could lock everyone out for 15 min) | configure `trust proxy` correctly, or key limits on a trusted forwarded address |
| 6 | **Sessions and rate limits are in memory** | restart signs everyone out and clears lockouts; no multi-instance support | move to a shared store (e.g. Redis or Postgres) |
| 7 | **No roles, MFA, password self-service, or immediate revocation** | every user can override; a stolen password is enough | admin role + in-app account screen, MFA, revocation |
| 8 | **Audit tables are not tamper-evident at the database level** | a DB admin can alter history | append-only permissions, hash chaining, external log shipping |
| 9 | **No security-event logging or alerting** | brute-force and abuse go unnoticed | log failed logins/lockouts/403s and alert on thresholds |
| 10 | **Development database password and floating image tag** | weak credentials if the port is ever exposed | strong secret from the environment; pin the image |
| 11 | **Outdated Node.js on this machine** | known runtime vulnerabilities | upgrade to a current LTS |
| 12 | **No independent penetration test; no load test** | unknown unknowns | commission one before go-live |
| 13 | **UI idle sign-out is hard-coded to 30 min** | drifts from `SESSION_IDLE_MINUTES` (the server always wins) | expose the setting to the client |

## K. Pre-production checklist for the operator

- [ ] Serve over **HTTPS** (reverse proxy); set `NODE_ENV=production`; confirm the `triage_sid` cookie shows `Secure`
- [ ] Configure `trust proxy` (or equivalent) so login limits use real client addresses (risk 5)
- [ ] Use a **strong, unique database password** from the environment; `DATABASE_SSL=true` if the DB is not local; do **not** publish port 5432
- [ ] Decide the AI provider terms: paid-tier Gemini **and** a BAA if this is a HIPAA workflow; only then set `GEMINI_PAID_TIER_CONFIRMED=true`
- [ ] Encrypt the database volume; define **retention and deletion** for patient names and phone numbers
- [ ] Upgrade **Node.js** to a current LTS; pin the Postgres image; run `npm audit`
- [ ] Provision **individual** staff accounts (`npm run create-user -- <name>`); store the printed passwords securely; disable leavers and restart
- [ ] Add monitoring/alerting for failed logins, lockouts, `403`s and repeated "AI unavailable" events
- [ ] Verify the production **CSP** in the target browsers (the built UI must load with no violations)
- [ ] Test the interface with **NVDA/JAWS and VoiceOver**, including the new-high-urgency announcement
- [ ] Evaluate AI classification quality on a set of realistic, synthetic intakes (including deliberately vague and hostile ones)
- [ ] Commission an independent penetration test

## L. Summary of status

Counted from the tables above (✅ = implemented and verified, automated or manual as marked).

| Area | Controls | ✅ verified | 🟡 partial | ❌ not implemented |
|---|---|---|---|---|
| A. Authentication and sessions | 20 | 16 | 1 | 3 |
| B. Authorization and audit integrity | 9 | 7 | 0 | 2 |
| C. Data protection | 17 | 9 | 3 | 5 |
| D. Input validation | 16 rules | 14 | 2 | 0 |
| E. Injection and output handling | 7 | 5 | 2 | 0 |
| F. Error handling | 24 scenarios | 17 | 7 | 0 |
| G. Network and HTTP hardening | 13 | 9 | 3 | 1 |
| H. Logging and monitoring | 8 | 6 | 0 | 2 |
| I. Secrets, configuration, dependencies | 10 | 7 | 3 | 0 |
| **Total** | **124** | **90** | **21** | **13** |

The ❌ items are the ones in §J. None of them is hidden by the test results: every suite passing means the *implemented* controls
work as described, not that the gaps above do not exist.
