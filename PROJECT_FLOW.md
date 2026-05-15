# PROJECT_FLOW.md

End-to-end walkthrough of what happens from the moment a user types a URL until they download a PDF report.

---

## 1. Boot

1. `npm start` → `node server.js`.
2. `server.js:1` loads `.env` (`ANTHROPIC_API_KEY`, `PAGESPEED_API_KEY`, `PORT`).
3. Express is created, `express.json()` parses request bodies, `express.static('public')` serves the UI.
4. `app.listen(PORT)` starts the server on port 3000 (default).
5. After listening, the server **shells out to the OS** (`start` / `open` / `xdg-open`) to auto-launch the user's default browser at `http://localhost:3000`.

There is no startup health check or warm-up — the first audit will be the one that creates the singleton Puppeteer browser instance.

---

## 2. Landing page

`public/index.html` loads. `public/js/app.js` wires up:
- A form submit handler on `#auditForm`.
- A toggle for the optional competitor URL inputs.
- Click handlers on `#exportPdf`, `#exportHtml`, `#exportScreenshot`, `#newAuditBtn`, `#retryBtn`.

The user enters a URL (and up to 2 optional competitor URLs) and clicks **Run Audit**.

---

## 3. Audit kick-off (client → server)

`app.js:39`:
```js
const res = await fetch('/api/audit', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ url, competitors })
});
```

`server.js:18` handles it:
1. Validates the URL (`new URL()` — accepts anything `URL` accepts, including internal IPs).
2. Normalizes (adds `https://` if missing).
3. Generates a UUID v4.
4. Stores audit state in the `audits` Map: `{ id, url, competitors, status: 'running', progress: [], result: null, error: null, sseClients: [] }`.
5. **Calls `runAudit()` without awaiting** — the audit runs in the background while the route returns `{ id }` immediately.

`app.js:50` receives the `{ id }`, switches to the **progress view**, and opens an EventSource to `/api/audit/:id/progress`.

---

## 4. Real-time progress (SSE)

`server.js:79` registers an SSE connection:
- Replays any `progress` events that already happened (because `runAudit` may already have emitted some before the client connected).
- If the audit is already complete or errored, sends the final event and ends.
- Otherwise pushes the response stream onto `audit.sseClients` and forwards every new event there.

`runAudit()` (in `src/auditor.js`) accepts an `onProgress` callback. Each emit pushes the event into the in-memory `audit.progress` array **and** writes to all open SSE clients.

Event shapes:
```js
{ type: 'progress',        step, total, message }     // e.g. "Running SEO Audit..."
{ type: 'module_complete', module, name, score, maxScore, findingCount }
{ type: 'complete',        result }                    // full report
{ type: 'error',           message }
```

The client's `app.js:74` `source.onmessage`:
- Updates progress bar and text.
- Maintains a live module checklist with running ⟳ / completed ✓ icons and the per-module score.
- On `complete`, closes the SSE and calls `showReport(result)`.

---

## 5. The audit pipeline (server, `src/auditor.js`)

### Step 1 — Scrape

`scrapePage(url)` in `src/scraper.js:31` does the heavy lifting in one Puppeteer page load:

1. Gets the singleton browser (`getBrowser()`); spawns Chromium with `--no-sandbox` on first call.
2. Opens a new page at viewport 1440×900 with a desktop Chrome 120 user agent.
3. Attaches `page.on('request')` and `page.on('response')` listeners that build a `requests[]`, `responses[]`, and a categorized `resources = { images, scripts, stylesheets, fonts }` list.
4. `page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 })`.
5. Records `loadTime` (wall clock) and `redirectChain` (from the navigation response).
6. Pulls `page.content()` HTML, loads it into Cheerio (`$`) for jQuery-like queries.
7. Runs two `page.evaluate()` snippets:
   - `performanceTiming` — from `PerformanceNavigationTiming`: TTFB, DCL, load, transfer/encoded/decoded bytes.
   - `pageMetrics` — first 500 elements’ computed `font-family`, `color`, `backgroundColor`, `fontSize`; viewport meta; first 50,000 chars of `body.innerText`; `<title>`; `<html lang>`.
8. Captures a full-page JPEG screenshot (quality 60) as base64 → `fullPageScreenshot`.
9. **Returns with the page still open** so audit modules can take targeted screenshots of evidence (broken H1, weak CTA, oversized form, etc.).

### Step 2 — Link crawl

`crawlLinks(baseUrl, $, depth=1)`:
- Collects every `<a href>` that isn't a `#`/`mailto:`/`tel:`/`javascript:` link.
- Normalizes to absolute, dedupes, splits into `internal` (same hostname) and `external`.
- Caps at 100 URLs, then `HEAD`s them in batches of 10 with `checkUrl()` (8s timeout each).
- Returns `{ internal, external, broken, allChecked }`.

### Step 3 — Run the 8 modules in series

```js
const MODULES = [
  { id: 'ux',         ... runUxAudit(pageData)            },
  { id: 'ui',         ... runUiAudit(pageData)            },
  { id: 'performance',... runPerformanceAudit(pageData)   },
  { id: 'seo',        ... runSeoAudit(pageData, linkData) },
  { id: 'content',    ... runContentAudit(pageData)       },
  { id: 'technical',  ... runTechnicalAudit(pageData, linkData) },
  { id: 'cro',        ... runCroAudit(pageData)           },
  { id: 'security',   ... runSecurityAudit(pageData)      }
];
```

Each module:
- Starts with a `score = 10` and subtracts based on findings.
- Pushes `finding()` objects (`{ message, severity, recommendation }`) into a `findings[]` array.
- Some attach `screenshot` (base64 JPEG) for visual evidence.
- Returns `{ id, name, score, maxScore: 10, findings, ...extras }`.

If a module throws, the auditor catches it and substitutes a stub finding so the rest of the pipeline still completes.

Each module emits `{ type: 'module_complete', ... }` via SSE for live UI updates.

### Step 4 — Close the page

`closePage(pageData)` — the Puppeteer page is closed (the **browser** stays open between audits).

### Step 5 — Build the report

```js
{
  url,
  date: ISO string,
  loadTime,
  overallScore: weighted 0–100 (utils.overallScore),
  fullPageScreenshot,
  modules: [...],
  executiveSummary: {
    totalFindings,
    criticalCount, warningCount, goodCount,
    priorityFixes: top 5 (criticals first, then warnings),
    strengths: first 5 'good' findings
  }
}
```

### Step 6 — Optional competitor benchmarking

If competitor URLs were submitted, `runCompetitorAudit()` runs **a new** `scrapePage` + `crawlLinks` on up to 2 competitors and runs only performance, SEO, and security against them, then builds a side-by-side comparison table, generates `warning` findings where a competitor beats the main site, and computes a win-rate score. The result is appended to `result.modules` and also exposed as `result.competitor`.

### Step 7 — Resolve

The `.then()` in `server.js:51` flips `audit.status = 'complete'`, sets `audit.result`, broadcasts `{ type: 'complete', result }` over every active SSE stream, and closes them.

---

## 6. Showing the report

`app.js:176` `showReport(result)`:
- Switches the active view to `#report`.
- Calls `buildClientReport(result)` to render an HTML string — this is a **separate, slightly different implementation** from `src/report.js`. The client renderer is used for the in-app view; the server renderer is used for downloadable HTML/PDF/JPEG exports.
- Wires click handlers for collapsible module sections and zoomable evidence screenshots.

---

## 7. Export flow

User clicks **Save as PDF**, **Export HTML**, or **Screenshot**:

`app.js:355-391` simply triggers a navigation to the export URL with a fake anchor:
```js
a.href = `/api/audit/${currentAuditId}/export/pdf`;
a.download = `audit-report-${Date.now()}.pdf`;
a.click();
```

Server side (`server.js:118 / 170 / 182`):
- **PDF** — calls `generateHTML(audit.result)`, launches Puppeteer, `page.setContent(html)`, expands any `.collapsed` sections, measures the rendered height, then calls `page.pdf({ width, height, printBackground: true })` so the report becomes **one tall page** with no A4 page breaks.
- **HTML** — sends `generateHTML(...)` directly with `Content-Type: text/html` and an attachment disposition.
- **JPEG screenshot** — same as PDF but ends with `page.screenshot({ fullPage: true, type: 'jpeg', quality: 90 })`.

For PDF and JPEG the server **launches a fresh Puppeteer browser** (not the singleton), then closes it. That makes export safe to run while another audit is in progress, at the cost of a fresh Chromium spin-up per export.

---

## 8. Error paths

| Failure point | Behavior |
|---|---|
| Bad URL submission | `server.js:25` returns `400 { error: 'Invalid URL' }`; client switches to error view. |
| Target site unreachable | `scrapePage` throws; `runAudit` rethrows; `.catch()` in `server.js:62` sets `status: 'error'` and broadcasts `{ type: 'error', message }` over SSE. |
| Individual module throws | Caught inside `auditor.js:63`; emits a stub `critical` finding for that module so the audit overall still completes. |
| Anthropic API failure | (Currently only matters for the **orphan** heuristics module.) Caught and turned into a single `warning` finding. |
| PageSpeed API failure | Caught in `performance.js:118`; turned into a `warning` finding. |
| SSE connection drop | Client `source.onerror` schedules one fallback `fetch('/api/audit/:id/report')` after 2 s. |

---

## 9. Data flow summary

```
User input (URL) ──► POST /api/audit ──► audits.set(id, {running}) ──► runAudit() (background)
                                                                              │
                                                                              ▼
                                                                    scrapePage (Puppeteer)
                                                                              │
                                                                              ▼
                                                                    crawlLinks (HEAD probes)
                                                                              │
                                                                              ▼
                                                                    8 module functions, in series
                                                                    (each emits SSE event;
                                                                     some take element screenshots)
                                                                              │
                                                                              ▼
                                                                    closePage → buildExecutiveSummary
                                                                              │
                                                                              ▼
                                                                    (optional) competitor: 2x scrape+perf+seo+sec
                                                                              │
                                                                              ▼
                                              audit.result = {url, date, overallScore, modules[], ...}
                                              SSE → client.onmessage('complete') → showReport()
                                                                              │
                                                                              ▼
                                                User clicks export → /api/audit/:id/export/{pdf|html|screenshot}
                                                                              │
                                                                              ▼
                                                      generateHTML(report) → file download
```

---

## 10. End-of-life of an audit

After a user finishes:
- The audit object **stays in memory indefinitely**. Restarting the server is the only way to free it.
- The singleton Puppeteer browser stays alive between audits and is never explicitly closed; Node’s process exit will tear it down.
- `*.pdf` files are streamed directly to the client; they are not written to disk by the server, so there is nothing to clean up.
