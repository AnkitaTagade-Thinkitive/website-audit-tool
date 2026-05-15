# PROJECT_ARCHITECTURE.md

## 1. Project at a glance

**Name:** Website Audit Tool (`website-audit-tool` v1.0.0)
**Purpose:** A self-hosted web app that takes any public URL, scrapes the page with a headless Chrome browser, runs **8 audit modules** (UX, UI, Performance, SEO, Content, Technical, CRO, Security) plus optional **Competitor benchmarking**, and produces a styled HTML / PDF / JPEG report with severity-tagged findings, screenshots, and an overall 0–100 health score.

It is a **single-process Node.js + Express server**. There is **no separate frontend build** — the UI is plain HTML/CSS/JS files served as static assets. There is **no database** — all audit state lives in an in-memory `Map` and is lost on restart.

---

## 2. Tech stack

| Layer | Technology |
|---|---|
| Runtime | Node.js ≥ 18 |
| Web server | Express 4.21 |
| Headless browser | Puppeteer 24 (bundled Chromium) |
| HTML parsing | Cheerio 1.0 |
| AI analysis | Anthropic Claude SDK 0.39 (`claude-sonnet-4-20250514`) — **declared, but not wired into the pipeline today** (see [PROJECT_FLOW.md](PROJECT_FLOW.md)) |
| Optional perf data | Google PageSpeed Insights v5 (raw HTTPS GET, no SDK) |
| Real-time updates | Server-Sent Events (`text/event-stream`) |
| ID generation | `uuid` v11 |
| Env loading | `dotenv` v16 |
| PDF generation | Puppeteer’s `page.pdf()` (the `pdfkit` dependency is **declared but unused**) |
| Frontend | Vanilla HTML5 + CSS3 + ES2017 JavaScript (no framework, no bundler) |
| Fonts (frontend) | Google Fonts: Inter, DM Mono |

There is **no TypeScript**, **no React/Vue/Angular**, **no Vite/Webpack**, **no test framework**, **no linter config**, **no CI config**.

---

## 3. Folder-by-folder explanation

```
SS_Tool2/
├── .env.example              ← Template for ANTHROPIC_API_KEY, PAGESPEED_API_KEY, PORT
├── .gitignore                ← Excludes node_modules, .env, *.pdf
├── README.md                 ← User-facing setup & feature description
├── package.json              ← Manifest; scripts: "start" and "dev"
├── package-lock.json
├── server.js                 ← Express entry point + all HTTP routes
├── node_modules/             ← Installed deps (gitignored)
│
├── public/                   ← Static assets served by express.static()
│   ├── index.html            ← Single-page UI with 4 views (landing / progress / report / error)
│   ├── css/style.css         ← Full styling, ~21 KB, no preprocessor
│   └── js/app.js             ← Client-side controller: form submit, SSE listener, report renderer
│
└── src/                      ← Server-side audit engine (CommonJS modules)
    ├── auditor.js            ← Orchestrator — wires up 8 modules + optional competitor
    ├── scraper.js            ← Puppeteer wrapper: page load, screenshots, link crawl
    ├── report.js             ← Builds the standalone export HTML (used by PDF + HTML export)
    ├── utils.js              ← Helpers: severity, finding(), Flesch-Kincaid, contrastRatio
    │
    └── modules/              ← One file per audit category
        ├── ux.js             ← Navigation, CTA, ARIA, alt text, skip-nav
        ├── ui.js             ← Typography, colors, contrast, heading hierarchy
        ├── performance.js    ← Load time, TTFB, resource counts, PSI Core Web Vitals
        ├── seo.js            ← Title, meta, OG, canonical, sitemap, robots, JSON-LD
        ├── content.js        ← Word count, readability, paragraph length
        ├── technical.js      ← HTTPS redirects, redirect chains, charset, doctype
        ├── cro.js            ← CTA copy, form length, trust signals, social proof
        ├── security.js       ← Security headers, mixed content, outdated libs
        ├── competitor.js     ← Runs perf+SEO+security on 1–2 competitor URLs
        └── heuristics.js     ← Nielsen's 10 heuristics with Claude AI — ORPHAN (not imported)
```

### Key file responsibilities

| File | Role |
|---|---|
| `server.js` | Boots Express on `PORT` (default 3000), serves `/public`, defines 6 API routes (audit start, SSE progress, report fetch, PDF export, HTML export, JPEG screenshot), auto-opens default browser |
| `src/auditor.js` | Sequentially runs every module against a single `pageData` snapshot, builds the final report object with `executiveSummary` (top 5 fixes) and weighted overall score |
| `src/scraper.js` | Maintains a singleton Puppeteer browser instance, exposes `scrapePage`, `closePage`, `screenshotElement(s)`, `screenshotAboveFold`, `screenshotRegion`, `checkUrl` (HEAD probe), `crawlLinks` (up to 100 same-page links, batched 10× concurrent) |
| `src/report.js` | `generateHTML(report)` returns one self-contained HTML string with inline CSS — used both for HTML export and as the source for the Puppeteer-rendered PDF |
| `src/utils.js` | Pure functions: `severity()`, `finding()`, `overallScore()` (weights: perf 18, ux 15, seo 15, ui 12, tech 12, security 10, content 10, cro 8), `fleschKincaid()`, `contrastRatio()` |
| `public/js/app.js` | Drives view transitions, owns the EventSource SSE client, renders the live report a second time client-side (separate code path from `report.js`) |

---

## 4. Architectural diagram

```
 ┌───────────────────────────┐         ┌──────────────────────────────────────┐
 │ Browser (public/index.html│         │  Node.js process (server.js, :3000)  │
 │  + app.js + style.css)    │         │                                      │
 │                           │POST     │  ┌────────────────────────────────┐  │
 │  Landing → form submit ───┼────────►│  │ /api/audit  → uuid + audits.set│  │
 │                           │JSON     │  │              + runAudit()      │  │
 │                           │         │  └────────────────────────────────┘  │
 │  Progress ←──── SSE ──────┼─────────│  ┌────────────────────────────────┐  │
 │  EventSource              │         │  │ /api/audit/:id/progress (SSE)  │  │
 │                           │         │  └────────────────────────────────┘  │
 │                           │         │  ┌────────────────────────────────┐  │
 │  Report ←─── JSON ────────┼─────────│  │ /api/audit/:id/report          │  │
 │  (rendered by app.js)     │         │  └────────────────────────────────┘  │
 │                           │         │  ┌────────────────────────────────┐  │
 │  Export PDF / HTML / JPEG ┼────────►│  │ /api/audit/:id/export/{pdf,    │  │
 │                           │         │  │   html, screenshot}            │  │
 │                           │         │  └────────────────────────────────┘  │
 └───────────────────────────┘         │                                      │
                                       │  audits: Map<id, AuditState>         │
                                       │  (in-memory, lost on restart)        │
                                       │                                      │
                                       │  ┌────────────────────────────────┐  │
                                       │  │ src/auditor.js (orchestrator)  │  │
                                       │  │  └─ scrapePage (Puppeteer)     │  │
                                       │  │  └─ crawlLinks (HEAD probes)   │  │
                                       │  │  └─ 8 modules in sequence      │  │
                                       │  │  └─ competitor (optional)      │  │
                                       │  └────────────────────────────────┘  │
                                       └──────┬───────────────────────────────┘
                                              │
                                              ▼ external calls
                       ┌────────────────────────────────────────────┐
                       │  • Target site (HTTPS via headless Chrome) │
                       │  • Google PageSpeed Insights API (optional)│
                       │  • Anthropic Claude API (optional, orphan) │
                       └────────────────────────────────────────────┘
```

---

## 5. Entry points

| Entry | What it does |
|---|---|
| `npm start` → `node server.js` | Production / normal run |
| `npm run dev` → `node server.js --dev` | Same command — the `--dev` flag is **passed but never read** anywhere in code |
| `server.js:215` `app.listen(PORT, ...)` | Boots the HTTP server, then shells out (`start` on Windows, `open` on macOS, `xdg-open` on Linux) to auto-launch the default browser at `http://localhost:3000` |
| `public/index.html` | UI entry — loaded automatically when the browser opens |

---

## 6. State management

There is no traditional state management library.

**Server side**
- A single `Map` named `audits` in [server.js:15](server.js#L15) keyed by UUID. Each entry stores: `{ id, url, competitors, status, progress[], result, error, sseClients[] }`.
- Audits are **never evicted** — running the server long enough is a slow memory leak.

**Client side**
- Two module-level variables in [public/js/app.js:4-120](public/js/app.js): `currentAuditId` (string) and `moduleListItems` (Map of name → DOM node).
- View switching is class-toggled (`active` on a `.view` div). No router, no history API.

---

## 7. Routing

**Frontend routing:** none. The page never changes URL — it is a fixed `index.html` with 4 sibling `<div class="view">` blocks, only one of which has the `.active` class at a time (`landing`, `progress`, `report`, `error`).

**Backend routing:** flat Express routes, all defined inline in `server.js`. See [API_STRUCTURE.md](API_STRUCTURE.md).

---

## 8. Environment variables

Defined in `.env` (loaded by `dotenv` on line 1 of `server.js`):

| Var | Required? | Used in | Purpose |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | README says required; **the running pipeline never reads it** (only orphan `heuristics.js` does) | `src/modules/heuristics.js:32` | Powers Claude-based heuristic analysis |
| `PAGESPEED_API_KEY` | Optional | `src/modules/performance.js:88, 131` | Enables Google PageSpeed Insights (LCP, CLS, FID) |
| `PORT` | Optional | `server.js:9` | Server port — defaults to 3000 |

---

## 9. Build & deployment configuration

- **No build step.** The frontend is plain files copied as-is to `/public`.
- **No bundler, transpiler, or minifier** configured.
- **No deployment config** present: no `Dockerfile`, no `docker-compose.yml`, no PM2 ecosystem file, no GitHub Actions, no Vercel/Netlify/Heroku config.
- **No tests** and no `test` script in `package.json`.
- Running in production today = `npm install && npm start` on a Node ≥ 18 host with Chromium runnable.

---

## 10. Third-party integrations

| Service | Required? | How it’s reached |
|---|---|---|
| **Anthropic Claude** | Optional in current state (only used by orphan module) | `@anthropic-ai/sdk` — `client.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 2000 })` |
| **Google PageSpeed Insights v5** | Optional | Raw `https.get()` to `googleapis.com/pagespeedonline/v5/runPagespeed` |
| **Target site** | Always | Loaded inside headless Chrome at viewport 1440×900 |
| **Google Fonts** | Frontend cosmetic | `<link>` in `public/index.html` and `report.js`-generated HTML |

---

## 11. Package dependencies

```json
{
  "@anthropic-ai/sdk": "^0.39.0", // AI (currently only the orphan module uses it)
  "cheerio": "^1.0.0",            // jQuery-like HTML parsing of page.content()
  "dotenv": "^16.4.7",            // .env loader
  "express": "^4.21.2",           // HTTP server
  "pdfkit": "^0.18.0",            // DECLARED BUT UNUSED — PDF is rendered via Puppeteer
  "puppeteer": "^24.2.1",         // Headless Chrome (scraping + PDF + JPEG)
  "uuid": "^11.1.0"               // v4 UUIDs for audit IDs
}
```

No dev dependencies. No optional dependencies. No `peerDependencies`.

---

## 12. Reusable components & utilities

These are the cross-cutting building blocks any new feature should reuse:

- **`finding(message, severity, recommendation)`** — every audit module returns an array of these. Severity is one of `'good' | 'warning' | 'critical'`. This is the canonical issue format.
- **`severity(score, max)`** — converts a numeric score into one of those three labels.
- **`overallScore(modules)`** — weighted aggregator (weights live in `utils.js`).
- **`scrapePage(url)`** — returns a `pageData` bundle: `{ url, html, $, page, loadTime, performanceTiming, resources, requests, responses, redirectChain, pageMetrics, fullPageScreenshot, responseHeaders, statusCode }`. **The `page` field is kept open** so modules can take element screenshots; the auditor closes it with `closePage(pageData)` after all modules finish.
- **`screenshotElement / screenshotElements / screenshotAboveFold / screenshotRegion`** — used by UX, UI, CRO to attach JPEG evidence to findings.
- **`checkUrl(url)`** — HEAD probe used by SEO (sitemap/robots) and the link crawler.
- **`generateHTML(report)`** — the only canonical HTML template for export.

---

## 13. Styling system

- Single stylesheet at `public/css/style.css` (~21 KB, ~700+ lines).
- Uses **CSS Custom Properties** (`--primary-900`, `--neutral-700`, `--risk-high`, `--shadow-md`, `--radius-lg`) as a design-token layer.
- Mobile breakpoint at `640px` (in both `style.css` and the report HTML).
- The **report export HTML** ([src/report.js:125-233](src/report.js#L125-L233)) carries its own inline `<style>` block — fully self-contained so exports don’t need any external CSS. There is intentional duplication between `style.css` and `report.js`.

---

## 14. Identified issues (high-level — full list in IMPROVEMENTS_SUGGESTIONS.md)

- **Orphan module:** `src/modules/heuristics.js` is the only file that uses Anthropic and the only file that delivers the "Nielsen's 10 Heuristics" feature advertised in `README.md`, but it is never imported by `auditor.js`. The README says "10 audit modules" — the running app delivers **8 + 1 optional competitor = 9**.
- **Unused dependency:** `pdfkit` is in `package.json` but no `require('pdfkit')` exists.
- **Unused flag:** `--dev` in `npm run dev` is never read.
- **Memory leak:** `audits` Map is never cleaned up.
- **No auth / no rate limiting:** anyone reachable on the port can trigger audits, each of which can call paid APIs and spawn a Chromium instance.
- **SSRF surface:** URL validation accepts internal addresses (`http://169.254.169.254`, `http://localhost:5432`, etc.).
- **Competitor leak:** `competitor.js` calls `scrapePage` but never `closePage` — leaves Puppeteer pages open.
- **Fragile async-in-each:** `cro.js:74-86` fires an async screenshot inside `.each()` and waits 500ms — race condition.
- **Deprecation:** `headless: 'new'` is the old opt-in syntax in Puppeteer; from v22+ the value should be `true`.

See [IMPROVEMENTS_SUGGESTIONS.md](IMPROVEMENTS_SUGGESTIONS.md) for the full list and prioritization.
