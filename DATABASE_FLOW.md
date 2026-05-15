# DATABASE_FLOW.md

## There is no database.

This project has **no persistent storage layer**. No SQL, no MongoDB, no Redis, no SQLite file, no ORM (Prisma/Sequelize/TypeORM/Mongoose), no in-process embedded store (LowDB, NeDB), no cloud storage SDK. There is no `models/`, `migrations/`, `prisma/`, or `db/` folder.

If you `grep` for SQL, ORM names, or `connect(`-style database calls in this codebase, you will find nothing.

---

## What stores state instead

All state is held in a **single in-process JavaScript `Map`**:

```js
// server.js:15
const audits = new Map();
```

Each entry is keyed by the audit's UUID and holds:

```js
{
  id:          string,        // UUID v4
  url:         string,        // normalized URL
  competitors: string[],      // up to 2
  status:      'running' | 'complete' | 'error',
  progress:    object[],      // every SSE event ever emitted for this audit
  result:      ReportObject | null,
  error:       string | null,
  sseClients:  Response[]     // currently-connected SSE writers
}
```

### Reads
- `GET /api/audit/:id/progress` — `audits.get(id)` to replay history and attach a new SSE client.
- `GET /api/audit/:id/report` — `audits.get(id).result`.
- `GET /api/audit/:id/export/{pdf,html,screenshot}` — same.

### Writes
- `POST /api/audit` — `audits.set(id, initialState)`.
- Progress callback (closure in `server.js:43`) — `audit.progress.push(event)`.
- Completion `.then` — `audit.status = 'complete'; audit.result = result`.
- Failure `.catch` — `audit.status = 'error'; audit.error = err.message`.
- SSE connect/disconnect — adds to / filters `audit.sseClients`.

There is **no delete path**. Audits live until the process is restarted.

---

## What this means in practice

| Concern | Reality |
|---|---|
| Persistence across restarts | None. Restarting `server.js` discards every audit, every report, every screenshot. |
| Sharing audits across users / machines | None. The Map is local to this process. Running two instances behind a load balancer would return 404 about half the time. |
| Bookmarking a report URL | Doesn't survive a restart. The "report URL" is `/api/audit/:id/report`, which 404s if the server restarted since the audit was generated. |
| Audit history view | Not implementable in the current architecture without adding storage. There is no `GET /api/audits` listing endpoint. |
| Memory growth | Each audit stores the full report (including base64 screenshots — `fullPageScreenshot` can be 50–500 KB on its own, plus per-finding evidence shots). After N audits the process holds N reports forever. This is a slow leak. |
| Backup / disaster recovery | N/A — there's nothing to back up. |

---

## External data sources (read-only — these are not databases)

| Source | What we read | Where |
|---|---|---|
| The target website | Full HTML, computed styles, network log, headers, screenshots | `src/scraper.js` |
| `/robots.txt` and `/sitemap.xml` on the target origin | Presence (status check) + `robots.txt` body | `src/modules/seo.js`, `src/modules/technical.js` |
| Google PageSpeed Insights v5 (optional) | LCP, CLS, FID, performance score | `src/modules/performance.js:129` |
| Anthropic Claude API (optional, currently orphan) | UX heuristic findings | `src/modules/heuristics.js:185` |

None of these are written to — they are upstream services queried per audit.

---

## Data flow (without a database)

```
[POST /api/audit]
       │
       ▼
audits.set(id, { status:'running', progress:[], result:null, ... })
       │
       ▼
runAudit() in background ─── pushes events into audit.progress[]
       │                  └─ writes to every res in audit.sseClients[]
       ▼
audit.status = 'complete'
audit.result = { url, date, overallScore, modules[], executiveSummary }
       │
       ▼
[GET /api/audit/:id/report]   reads audit.result
[GET /api/audit/:id/export/*] reads audit.result, regenerates HTML/PDF/JPEG on the fly
```

Nothing ever touches a disk except:
- The Puppeteer browser cache (managed by Chromium itself, not our code).
- `node_modules`.

---

## If you were to add a database

The minimum-viable schema would look like this:

```sql
CREATE TABLE audits (
  id            UUID PRIMARY KEY,
  url           TEXT NOT NULL,
  competitors   JSONB,
  status        TEXT NOT NULL,         -- running | complete | error
  error_message TEXT,
  created_at    TIMESTAMPTZ DEFAULT now(),
  completed_at  TIMESTAMPTZ,
  result        JSONB,                 -- the entire report object
  -- Optional: extract for querying
  overall_score INT,
  total_findings INT,
  critical_count INT
);

CREATE INDEX idx_audits_status_created ON audits (status, created_at DESC);
```

Two practical caveats before doing this:
1. **Screenshots inflate row size.** A typical complete report with `fullPageScreenshot` + several evidence shots is comfortably 1–5 MB of base64 in the JSON. If you store reports in Postgres `JSONB`, expect TOAST-sized rows. Strongly consider stripping screenshots out to object storage (S3 / Azure Blob / local `uploads/`) and keeping only URLs in the JSON.
2. **Progress events are noisy.** If you want a "resume in another tab" feature you'd want to persist `progress[]` too — but treating it as audit-replay log (append-only) is cleaner than embedding it in the row.

A lighter alternative: a `data/` folder of JSON files keyed by UUID, with `data/<id>.json` and `data/<id>-screenshot.jpg`. Trivial to implement, survives restarts, no new dependency.

See [IMPROVEMENTS_SUGGESTIONS.md](IMPROVEMENTS_SUGGESTIONS.md) §"Persistence" for the recommended path forward.

---

## Sessions / auth tokens / cookies — also none

The same answer applies to user identity: there is no users table, no sessions table, no token storage. The audit `id` itself acts as a **bearer-style capability** — anyone who knows the UUID can fetch the report. UUIDv4 is random enough that this is acceptable for a localhost tool, but is **not safe for a public deployment**.
