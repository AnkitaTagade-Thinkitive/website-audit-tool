require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { runAudit } = require('./src/auditor');
const { generateHTML } = require('./src/report');
const { verifyBrowser, closeBrowser, getLaunchOptions, resolveExecutable } = require('./src/scraper');
const { isUrlSafe } = require('./src/urlSafety');

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

// Trust the platform's reverse proxy so req.ip reflects the real client IP for rate limiting.
if (isProd) app.set('trust proxy', 1);

// Security headers. CSP is disabled because the generated report HTML embeds inline
// <script> and <style>, and the in-app frontend uses inline onclick handlers in
// dynamically-rendered HTML. The other 13 helmet headers (HSTS, X-Frame-Options,
// X-Content-Type-Options, Referrer-Policy, etc.) still apply.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

// Rate-limit the audit-start endpoint specifically. Other endpoints (SSE, report,
// exports) are read-only against pre-existing audit IDs and are not abuse vectors.
const auditLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many audits requested. Please wait a minute and try again.' }
});

app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// In-memory audit store
const audits = new Map();

// Liveness probe for hosting platforms (Render uses this to verify the service is up).
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Start an audit
app.post('/api/audit', auditLimiter, async (req, res) => {
  const { url, competitors } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const normalizedUrl = url.startsWith('http') ? url : `https://${url}`;

  const mainSafety = await isUrlSafe(normalizedUrl);
  if (!mainSafety.ok) return res.status(400).json({ error: mainSafety.reason });

  const normalizedCompetitors = [];
  for (const c of (competitors || []).slice(0, 2)) {
    if (!c) continue;
    const nc = c.startsWith('http') ? c : `https://${c}`;
    const cs = await isUrlSafe(nc);
    if (!cs.ok) return res.status(400).json({ error: `Competitor URL rejected: ${cs.reason}` });
    normalizedCompetitors.push(nc);
  }

  const id = uuidv4();

  audits.set(id, {
    id,
    url: normalizedUrl,
    competitors: normalizedCompetitors,
    status: 'running',
    progress: [],
    result: null,
    error: null,
    sseClients: []
  });

  // Run audit in background
  runAudit(normalizedUrl, normalizedCompetitors, (event) => {
    const audit = audits.get(id);
    if (!audit) return;
    audit.progress.push(event);
    // Notify SSE clients
    for (const client of audit.sseClients) {
      client.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  }).then(result => {
    const audit = audits.get(id);
    if (audit) {
      audit.status = 'complete';
      audit.result = result;
      for (const client of audit.sseClients) {
        client.write(`data: ${JSON.stringify({ type: 'complete', result })}\n\n`);
        client.end();
      }
      audit.sseClients = [];
    }
  }).catch(err => {
    const audit = audits.get(id);
    if (audit) {
      audit.status = 'error';
      audit.error = err.message;
      for (const client of audit.sseClients) {
        client.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
        client.end();
      }
      audit.sseClients = [];
    }
  });

  res.json({ id });
});

// SSE progress stream
app.get('/api/audit/:id/progress', (req, res) => {
  const audit = audits.get(req.params.id);
  if (!audit) return res.status(404).json({ error: 'Audit not found' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  // Send existing progress
  for (const event of audit.progress) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  if (audit.status === 'complete') {
    res.write(`data: ${JSON.stringify({ type: 'complete', result: audit.result })}\n\n`);
    return res.end();
  }
  if (audit.status === 'error') {
    res.write(`data: ${JSON.stringify({ type: 'error', message: audit.error })}\n\n`);
    return res.end();
  }

  audit.sseClients.push(res);
  req.on('close', () => {
    audit.sseClients = audit.sseClients.filter(c => c !== res);
  });
});

// Get report
app.get('/api/audit/:id/report', (req, res) => {
  const audit = audits.get(req.params.id);
  if (!audit) return res.status(404).json({ error: 'Audit not found' });
  if (audit.status !== 'complete') return res.status(202).json({ status: audit.status });
  res.json(audit.result);
});

// Export PDF — render the HTML report as a real PDF using Puppeteer
app.get('/api/audit/:id/export/pdf', async (req, res) => {
  const audit = audits.get(req.params.id);
  if (!audit || audit.status !== 'complete') {
    return res.status(404).json({ error: 'Report not ready' });
  }
  try {
    const puppeteer = require('puppeteer');
    const html = generateHTML(audit.result);
    const browser = await puppeteer.launch(getLaunchOptions());
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 20000 });
    // Expand all collapsed sections so full report is visible in the PDF
    await page.evaluate(() => {
      document.querySelectorAll('.module-section.collapsed').forEach(el => el.classList.remove('collapsed'));
    });
    await new Promise(r => setTimeout(r, 1000));

    // Measure the full content height so the PDF becomes a single tall page (no A4 breaks)
    const { height, width } = await page.evaluate(() => {
      const body = document.body;
      const html = document.documentElement;
      return {
        height: Math.max(body.scrollHeight, body.offsetHeight, html.clientHeight, html.scrollHeight, html.offsetHeight),
        width: Math.max(body.scrollWidth, html.scrollWidth, 1440)
      };
    });

    const pdf = await page.pdf({
      printBackground: true,
      width: `${width}px`,
      height: `${height + 40}px`,
      margin: { top: '0px', right: '0px', bottom: '0px', left: '0px' },
      preferCSSPageSize: false
    });
    await page.close();
    await browser.close();

    const pdfBuffer = Buffer.from(pdf);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', pdfBuffer.length);
    res.setHeader('Content-Disposition', `attachment; filename="audit-report-${Date.now()}.pdf"`);
    res.end(pdfBuffer);
  } catch (err) {
    res.status(500).json({ error: 'PDF generation failed: ' + err.message });
  }
});

// Export HTML
app.get('/api/audit/:id/export/html', (req, res) => {
  const audit = audits.get(req.params.id);
  if (!audit || audit.status !== 'complete') {
    return res.status(404).json({ error: 'Report not ready' });
  }
  const html = generateHTML(audit.result);
  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Content-Disposition', `attachment; filename="audit-report-${Date.now()}.html"`);
  res.send(html);
});

// Export full-page screenshot as JPEG
app.get('/api/audit/:id/export/screenshot', async (req, res) => {
  const audit = audits.get(req.params.id);
  if (!audit || audit.status !== 'complete') {
    return res.status(404).json({ error: 'Report not ready' });
  }
  try {
    const puppeteer = require('puppeteer');
    const html = generateHTML(audit.result);
    const browser = await puppeteer.launch(getLaunchOptions());
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15000 });
    // Expand all collapsed sections so full report is visible
    await page.evaluate(() => {
      document.querySelectorAll('.module-section.collapsed').forEach(el => el.classList.remove('collapsed'));
    });
    await new Promise(r => setTimeout(r, 800));
    const screenshot = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 90 });
    await page.close();
    await browser.close();
    const buf = Buffer.from(screenshot);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Content-Length', buf.length);
    res.setHeader('Content-Disposition', `attachment; filename="audit-report-${Date.now()}.jpg"`);
    res.end(buf);
  } catch (err) {
    res.status(500).json({ error: 'Screenshot failed: ' + err.message });
  }
});

const server = app.listen(PORT, async () => {
  console.log(`\n  Website Audit Tool running at http://localhost:${PORT}\n`);

  // Boot-time browser probe — surfaces the "Chrome missing" condition immediately
  // instead of waiting for the first audit to fail. Logs which resolution strategy
  // was used so deployment issues (wrong env var, missing system install, etc.)
  // are visible from the runtime logs.
  const resolved = resolveExecutable();
  console.log(`  Resolved browser via [${resolved.source}]${resolved.path ? `: ${resolved.path}` : ''}`);
  console.log('  Verifying headless browser...');
  const probe = await verifyBrowser();
  if (probe.ok) {
    console.log(`  Browser OK${probe.executablePath ? ` (${probe.executablePath})` : ''}\n`);
  } else {
    console.error('\n  ⚠  Headless browser is NOT available. Audits will fail until this is fixed.');
    console.error('  ' + String(probe.error.message).split('\n').join('\n  ') + '\n');
  }

  // Auto-open the user's browser — local dev only. On a headless server (Render,
  // Railway, VPS) there's no display, so `start`/`xdg-open` would fail noisily.
  if (!isProd) {
    const opener = process.platform === 'win32' ? 'start' :
      process.platform === 'darwin' ? 'open' : 'xdg-open';
    require('child_process').exec(`${opener} http://localhost:${PORT}`);
  }
});

// Graceful shutdown — close the singleton Chromium so it doesn't linger on Windows.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n  Received ${signal}, shutting down...`);
  try { await closeBrowser(); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
