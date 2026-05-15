# API_STRUCTURE.md

All HTTP endpoints are defined inline in `server.js`. There is **no auth, no rate limiting, no API versioning, no OpenAPI spec, no CSRF protection, no CORS configuration** (Express default = same-origin only). All routes operate on the in-memory `audits` Map.

---

## Base URL

```
http://localhost:3000
```

---

## Conventions

- Request body: `application/json`.
- Response body: `application/json` except where noted (PDF / HTML / JPEG endpoints set their own `Content-Type`).
- IDs: UUID v4 strings.
- Severity in findings: one of `'good' | 'warning' | 'critical'`.
- Scores: integers 0–10 per module; 0–100 overall.

---

## Endpoints

### 1. `POST /api/audit` — Start a new audit

Kicks off an audit. **Returns immediately** with the new audit's ID; the audit itself runs in the background.

**Request**
```json
{
  "url": "https://example.com",
  "competitors": ["https://competitor1.com", "https://competitor2.com"]  // optional, max 2 used
}
```

- `url` (required) — if missing the `https://` scheme, it is auto-prepended.
- `competitors` (optional) — array; only the first 2 are processed.

**Responses**
- `200 OK` — `{ "id": "<uuid>" }`
- `400 Bad Request` — `{ "error": "URL is required" }` or `{ "error": "Invalid URL" }`

**Source:** [server.js:18](server.js#L18)

---

### 2. `GET /api/audit/:id/progress` — Subscribe to live progress (SSE)

Server-Sent Events stream. On connect the server **replays every event already emitted**, then streams new ones as they happen. Closes the stream automatically on `complete` or `error`.

**Response headers**
```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
```

**Event payloads** (each event is `data: <json>\n\n`)

| `type` | Payload |
|---|---|
| `progress` | `{ type, step, total, message }` |
| `module_complete` | `{ type, module, name, score, maxScore, findingCount }` |
| `complete` | `{ type, result }` — full report object (see Schema below) |
| `error` | `{ type, message }` |

**Error response**
- `404 Not Found` — `{ "error": "Audit not found" }` if the ID does not exist in the in-memory Map.

**Source:** [server.js:79](server.js#L79)

---

### 3. `GET /api/audit/:id/report` — Fetch the final report

**Responses**
- `200 OK` — full report JSON (see Schema below).
- `202 Accepted` — `{ "status": "running" | "error" }` while not yet complete.
- `404 Not Found` — `{ "error": "Audit not found" }`.

**Source:** [server.js:110](server.js#L110)

---

### 4. `GET /api/audit/:id/export/pdf` — Download the report as a PDF

The report HTML (from `generateHTML()`) is rendered by a freshly spawned Puppeteer instance into a **single tall page** sized to the content height (no A4 page breaks). All collapsed module sections are programmatically expanded before rendering.

**Responses**
- `200 OK`
  - `Content-Type: application/pdf`
  - `Content-Disposition: attachment; filename="audit-report-<timestamp>.pdf"`
- `404 Not Found` — `{ "error": "Report not ready" }` if no audit or status ≠ `complete`.
- `500 Internal Server Error` — `{ "error": "PDF generation failed: <message>" }`.

**Source:** [server.js:118](server.js#L118)

---

### 5. `GET /api/audit/:id/export/html` — Download the report as standalone HTML

A single self-contained HTML document with inline CSS — no external assets needed except Google Fonts (loaded by `<link>`).

**Responses**
- `200 OK`
  - `Content-Type: text/html`
  - `Content-Disposition: attachment; filename="audit-report-<timestamp>.html"`
- `404 Not Found` — `{ "error": "Report not ready" }`.

**Source:** [server.js:170](server.js#L170)

---

### 6. `GET /api/audit/:id/export/screenshot` — Download the report as a JPEG

Renders the same HTML in Puppeteer at viewport 1440×900, expands all sections, and returns a `fullPage` screenshot at quality 90.

**Responses**
- `200 OK`
  - `Content-Type: image/jpeg`
  - `Content-Disposition: attachment; filename="audit-report-<timestamp>.jpg"`
- `404 Not Found` — `{ "error": "Report not ready" }`.
- `500 Internal Server Error` — `{ "error": "Screenshot failed: <message>" }`.

**Source:** [server.js:182](server.js#L182)

---

## Static files

| Path | Source |
|---|---|
| `/` and `/index.html` | `public/index.html` |
| `/css/style.css` | `public/css/style.css` |
| `/js/app.js` | `public/js/app.js` |

Served by `express.static(path.join(__dirname, 'public'))` at [server.js:12](server.js#L12).

---

## Report JSON schema

The shape returned by `/api/audit/:id/report` and the `complete` SSE event:

```ts
{
  url: string,                       // normalized with https:// prefix
  date: string,                      // ISO 8601
  loadTime: number,                  // milliseconds (wall clock)
  overallScore: number,              // 0..100, weighted
  fullPageScreenshot: string|null,   // base64 JPEG, optional
  modules: Module[],
  executiveSummary: {
    totalFindings: number,
    criticalCount: number,
    warningCount: number,
    goodCount: number,
    priorityFixes: Finding[],        // up to 5
    strengths: Finding[]             // up to 5
  },
  competitor?: CompetitorModule      // only when competitors were supplied
}

type Module = {
  id: 'ux'|'ui'|'performance'|'seo'|'content'|'technical'|'cro'|'security'|'competitor',
  name: string,
  score: number,                     // 0..maxScore
  maxScore: number,                  // 10 for all current modules
  findings: Finding[],
  // Module-specific extras (optional):
  metrics?: object,                  // performance, content
  colorPalette?: string[],           // ui
  headingStructure?: { h1:number,... }, // ui
  comparison?: ComparisonRow[],      // competitor only
  heuristics?: Heuristic[]           // only if heuristics module is ever wired in
}

type Finding = {
  message: string,
  severity: 'good'|'warning'|'critical',
  recommendation?: string,
  screenshot?: string,               // base64 JPEG, optional
  module?: string,                   // only on findings inside executiveSummary
  moduleId?: string                  // only on findings inside executiveSummary
}

type ComparisonRow = {
  url: string,
  isMain: boolean,
  loadTime: number,
  performanceScore: number,
  seoScore: number,
  securityScore: number,
  overallScore: number               // 0..100
}
```

---

## Weighting (used by `overallScore`)

Defined in [src/utils.js:30-39](src/utils.js#L30-L39).

| Module | Weight |
|---|---|
| performance | 18 |
| ux | 15 |
| seo | 15 |
| ui | 12 |
| technical | 12 |
| security | 10 |
| content | 10 |
| cro | 8 |
| _competitor_ | 10 (default — not in the explicit map, falls through to the `|| 10` branch) |

---

## Severity → score per module

Pattern used by every module (e.g. [src/modules/ux.js](src/modules/ux.js)):

1. Start at `score = 10`.
2. Each `critical` finding subtracts 1.5–3 points (module-specific).
3. Each `warning` finding subtracts 0.25–1.5 points.
4. `good` findings do not affect score (positive checks only).
5. `Math.max(0, …)` floors at 0.

The heuristics module (orphan) uses a different formula: `Math.max(0, 10 - criticals * 3 - warnings * 1.5)` per heuristic, averaged across all 10.

---

## Error handling matrix

| Failure | HTTP | Body |
|---|---|---|
| `url` missing | 400 | `{ error: 'URL is required' }` |
| `url` invalid | 400 | `{ error: 'Invalid URL' }` |
| Audit ID unknown | 404 | `{ error: 'Audit not found' }` |
| Audit not complete (report endpoint) | 202 | `{ status: 'running' \| 'error' }` |
| Export with no complete audit | 404 | `{ error: 'Report not ready' }` |
| Puppeteer crash during PDF | 500 | `{ error: 'PDF generation failed: <msg>' }` |
| Puppeteer crash during JPEG | 500 | `{ error: 'Screenshot failed: <msg>' }` |
| Target site unreachable | n/a (audit errors over SSE) | `{ type: 'error', message }` |

---

## CORS, auth, and headers — none

There is no CORS middleware, no API key check, no JWT/session middleware, no IP allowlist, no rate limiter. Anyone able to reach `:3000` can launch unlimited audits and consume PageSpeed / Anthropic quotas.

See [IMPROVEMENTS_SUGGESTIONS.md](IMPROVEMENTS_SUGGESTIONS.md) for hardening recommendations.
