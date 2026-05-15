# IMPROVEMENTS_SUGGESTIONS.md

Findings from the read-only walkthrough of `SS_Tool2/`. Each item lists the impact, the location, and a concrete recommendation. Nothing has been modified yet.

Priority key: **P0** = ship-blocker if deploying to anything other than personal localhost. **P1** = correctness / leaks. **P2** = polish.

---

## P0 — Correctness / Security

### 0.1 Orphan module: Nielsen's Heuristics is advertised but not running
[src/modules/heuristics.js](src/modules/heuristics.js) is fully implemented (rule-based checks + a Claude AI call) and is the only file that uses `ANTHROPIC_API_KEY`. **It is never imported by `auditor.js`.**

The README at the project root and the heading of `landing` (`"AI-Powered Analysis"`) both promise Nielsen's 10 heuristics. Today the running pipeline runs 8 modules + competitor, with no heuristics, no AI.

Fix: add it to the `MODULES` array in [src/auditor.js:14](src/auditor.js#L14):
```js
{ id: 'heuristics', name: "Nielsen's Heuristic Evaluation", fn: (pd) => runHeuristicsAudit(pd) }
```
And import `runHeuristicsAudit` at the top.

If the intent is *not* to ship it, delete the file and update README so the product description matches reality.

### 0.2 No authentication and no rate limiting
`POST /api/audit` is unauthenticated. Anyone reachable on `:3000`:
- Can trigger arbitrarily many Puppeteer audits (CPU-heavy).
- Can burn through your Anthropic and PageSpeed quotas.
- Can use this server as an HTTP scanner aimed at any URL they like.

Minimum fix for localhost-only: bind to `127.0.0.1` not `0.0.0.0`. For any deployment: add an API key middleware *and* `express-rate-limit`.

### 0.3 SSRF surface in audit URL
`server.js:23-26` uses `new URL()` for validation, which gleefully accepts `http://localhost:5432`, `http://169.254.169.254/`, `http://10.0.0.1/`, `file://`, etc. The headless browser will then attempt to load that URL.

Fix: resolve the hostname, reject if it falls into private/loopback/link-local CIDR ranges, reject non-http(s) schemes. The `is-private-net` / `ipaddr.js` packages cover this in a few lines.

### 0.4 Memory leak: `audits` Map is never cleaned up
[server.js:15](server.js#L15). Reports include base64 screenshots — easily 1–5 MB each. After enough audits the process bloats indefinitely.

Fix: TTL-evict completed audits (e.g. 1 hour after `complete`), or cap the Map size to N most recent.

### 0.5 Competitor module leaks Puppeteer pages
[src/modules/competitor.js:29](src/modules/competitor.js#L29) calls `scrapePage(normalizedUrl)` for each competitor but never `closePage(pageData)`. Each competitor audit leaves a Chromium tab open until the process dies.

Fix: wrap in `try/finally` and call `closePage(pageData)`.

### 0.6 No graceful Puppeteer shutdown
`scraper.js` exposes `closeBrowser()` but nothing calls it. On SIGINT / SIGTERM the Chromium process may be orphaned (especially on Windows).

Fix in `server.js`:
```js
const { closeBrowser } = require('./src/scraper');
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { await closeBrowser(); process.exit(0); });
}
```

---

## P1 — Reliability bugs

### 1.1 Fire-and-forget async inside `.each()` in `cro.js`
[src/modules/cro.js:67-95](src/modules/cro.js#L67-L95): the screenshot for "too-many-fields" forms is wrapped in an IIFE that mutates the finding object asynchronously, then the loop pauses with `setTimeout(500ms)` hoping the screenshots finished.

Fix: collect form indices in a first pass, run screenshots in a proper `await Promise.all(...)`, then build findings.

### 1.2 `headless: 'new'` is deprecated
[src/scraper.js:12](src/scraper.js#L12), [server.js:127, 191](server.js). Puppeteer 22+ accepts only `headless: true`. Today it still works (`'new'` is mapped internally with a warning), but a Puppeteer upgrade will silently break this.

Fix: use `headless: true` everywhere.

### 1.3 `browserInstance.connected` may not exist
[src/scraper.js:10](src/scraper.js#L10). Older Puppeteer exposes `browser.isConnected()` as a method; the boolean property `.connected` is newer. Cross-version this works only because v24 happens to define both. Pin or feature-detect.

Fix: `if (!browserInstance || !browserInstance.isConnected()) { ... }`.

### 1.4 PageSpeed `fid` is actually `max-potential-fid`
[src/modules/performance.js:145](src/modules/performance.js#L145). The audit label says "FID" but the value comes from `max-potential-fid` — a lab metric, not the real FID. Worse, **FID has been retired by Google and replaced by INP** as of 2024.

Fix: rename to `maxPotentialFid`, or migrate to `interaction-to-next-paint` (`audits['interaction-to-next-paint']`).

### 1.5 PDF/JPEG export spawns a fresh browser every time
[server.js:127](server.js#L127) and [server.js:191](server.js#L191) call `puppeteer.launch()` rather than `getBrowser()`. Each export costs ~1–2 s of Chromium startup. Reusing the singleton (or a separate export-only singleton) would cut the latency dramatically.

### 1.6 Two divergent report renderers
[src/report.js](src/report.js) (server-side, used by exports) and [public/js/app.js](public/js/app.js)`:buildClientReport` (in-app view) both render the same shape but have **subtly different HTML and behavior** (e.g. the server version uses `onclick=...` for collapse toggles; the client uses an `addEventListener`). They will drift.

Fix: extract a single template helper, or render server-side once and `innerHTML =` it client-side via a new endpoint like `GET /api/audit/:id/report/html-fragment`.

### 1.7 Hardcoded Claude model is stale
[src/modules/heuristics.js:215](src/modules/heuristics.js#L215): `model: 'claude-sonnet-4-20250514'`. When you wire heuristics back in, also update to current Sonnet (`claude-sonnet-4-6` as of writing) — see the `/claude-api` skill.

### 1.8 Hardcoded Origin assumption for `/sitemap.xml`
[src/modules/seo.js:124](src/modules/seo.js#L124): always checks `${parsed.origin}/sitemap.xml`. Many real sites publish a sitemap index referenced from `robots.txt` (e.g. `Sitemap: https://example.com/sitemaps/news.xml`). Consider parsing `robots.txt` first and following the `Sitemap:` directive.

### 1.9 SSE replays even after `complete`/`error` but still attempts to push
After completion, late SSE subscribers get the full replay + one final message and the response is `end()`-ed. That's correct. But the `req.on('close', ...)` filter on `audit.sseClients` still runs against a stream that was never added — harmless, but a `try/catch` on `client.write` would protect against writing to closed sockets when many audits run concurrently.

### 1.10 `audit.sseClients = []` race
After `complete`, the `.then()` in `server.js:51` writes to every client, ends each stream, then replaces the array. If a client disconnected between `write` and `end`, the disconnect callback runs and `.filter(...)`s an already-emptied array — harmless but worth noting.

---

## P1 — Code health

### 1.11 Unused dependency: `pdfkit`
PDF generation uses `puppeteer.pdf()`. The `pdfkit` package in `package.json` is dead weight (~600 KB).

Fix: `npm uninstall pdfkit`.

### 1.12 Unused CLI flag `--dev`
`npm run dev` passes `--dev` to `server.js` but nothing inspects `process.argv`. Either implement it (e.g. enable verbose logging, nodemon-style auto-restart) or remove the script.

### 1.13 `_` parameter convention is inconsistent
Mixed `_` for unused params (`auditor.js:14`) and named-but-unused (`runUxAudit(pd, ld)` where `ld` isn't passed in `auditor.js:15` because UX doesn't need it). Pick one style.

### 1.14 `cheerio` may be redundant
Every place that uses `$` (cheerio) has access to the live Puppeteer page. Either commit to Puppeteer-only DOM access (`page.evaluate`) or to cheerio (then drop the live page after extracting HTML). Holding both doubles memory and complicates the lifecycle (closePage timing).

### 1.15 `analyzeStructure` in `heuristics.js` ignores empty alt attributes
[src/modules/heuristics.js:135-148](src/modules/heuristics.js#L135-L148) checks for inputs without labels/aria/placeholder — but `placeholder` is **not** an accessible label. A screen-reader-only span or visible `<label>` is. This will let many failing inputs pass.

### 1.16 `runUxAudit` duplicates `runUiAudit`'s contrast check and `runSeoAudit`'s H1 check
Multiple modules compute the same things from `pageData`. Not a bug, but the same H1 issue may appear under both UX, UI, and SEO. Consider a shared "facts about this page" computation phase that all modules consume.

---

## P2 — Polish & UX

### 2.1 Tighter URL field
The `<input type="url">` rejects URLs without a scheme on submit (HTML validation). The JS handler then re-adds `https://`. Inconsistent — accept it on the input too.

### 2.2 No "audit in progress" tab-close warning
A long audit (30–90 s) is interrupted with no warning if the user closes the tab. Add `beforeunload`.

### 2.3 Progress bar percentage is approximate
`step / total` in `auditor.js:33` counts module starts, not work done. A 10-second SEO audit and a 2-second content audit each tick the bar by the same amount. Cosmetic.

### 2.4 Reports view has no permalink
After the audit completes, the URL bar still reads `/`. Push `?audit=<id>` to history so the user can copy/share within their browser session.

### 2.5 Screenshot quality is hardcoded
JPEG 60–90 quality is fine but should be a configurable knob — exporting a JPEG report at quality 90 with many evidence shots becomes large fast.

### 2.6 README claims "Real-time progress indicators via Server-Sent Events" — verified ✓
### 2.7 README claims "Overall score (0-100) with weighted module scores" — verified ✓
### 2.8 README claims "10 audit modules" — **incorrect** today (see 0.1)

---

## Persistence (when you outgrow the Map)

The simplest practical upgrade: write `audits` entries to disk as JSON.

```js
// pseudo
const fs = require('fs/promises');
const DIR = path.join(__dirname, 'data');

async function persist(audit) {
  await fs.mkdir(DIR, { recursive: true });
  // Strip screenshots into separate files, keep refs in the JSON
  await fs.writeFile(path.join(DIR, audit.id + '.json'), JSON.stringify(audit));
}
```

On startup, scan `data/` and rehydrate `audits`. No new dependency, survives restart, easy to delete (`rm data/<id>.json` or a sweep cron).

If you ever need search, history listing, multi-instance, or sharing across users: introduce SQLite (with `better-sqlite3`) as the first real database; the schema in [DATABASE_FLOW.md](DATABASE_FLOW.md) maps directly to that.

---

## Suggested next implementation steps (safe order)

If you want to start making changes, this is the lowest-risk sequence:

1. **Verify the install runs cleanly.** `npm install` and `npm start` against a known-friendly URL like `https://example.com`. Confirm progress, report, and all three exports work.
2. **Decide on heuristics:** either wire it in (0.1) or remove it + update README. This is the single biggest gap between docs and reality.
3. **Add a `process.on('SIGINT')`** to close the browser cleanly (0.6) — one-line safety net.
4. **Patch the competitor leak** (0.5) — also one line.
5. **TTL-evict the audits Map** (0.4) — protects long-running deployments.
6. **Bind to `127.0.0.1`** (0.2 minimum) — one line. Or, if needing public-facing, add API key middleware and `express-rate-limit`.
7. **Reject private/loopback URLs** (0.3) — small library, large security impact.
8. **Replace `'new'` headless with `true`** (1.2) — prevents future Puppeteer upgrade breakage.
9. **Persistence** if needed — start with the JSON-on-disk approach.
10. **Refactor the two report renderers into one** (1.6) — biggest maintenance win, but the most invasive change; do it last.
