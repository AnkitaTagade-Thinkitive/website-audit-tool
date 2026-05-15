const puppeteer = require('puppeteer');
const cheerio = require('cheerio');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { URL } = require('url');

let browserInstance = null;

// Standard candidates for a system-installed Chromium / Chrome on Linux.
// Order matters: the first existing path wins.
const SYSTEM_BROWSER_CANDIDATES = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium'
];

let _resolvedExecutable;  // memoized {path, source}

/**
 * Resolve which Chromium/Chrome binary to launch.
 * Precedence:
 *   1. PUPPETEER_EXECUTABLE_PATH env var (explicit operator choice)
 *   2. First existing path from SYSTEM_BROWSER_CANDIDATES (system install)
 *   3. Puppeteer's bundled Chromium (fallback for local dev)
 *
 * Returns { path, source } — path may be undefined to mean "use Puppeteer's bundled".
 */
function resolveExecutable() {
  if (_resolvedExecutable) return _resolvedExecutable;

  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    _resolvedExecutable = {
      path: process.env.PUPPETEER_EXECUTABLE_PATH,
      source: 'PUPPETEER_EXECUTABLE_PATH env'
    };
    return _resolvedExecutable;
  }

  for (const p of SYSTEM_BROWSER_CANDIDATES) {
    try { if (fs.existsSync(p)) { _resolvedExecutable = { path: p, source: 'system install' }; return _resolvedExecutable; } } catch {}
  }

  _resolvedExecutable = { path: undefined, source: 'Puppeteer bundled' };
  return _resolvedExecutable;
}

// Standard launch options — single source of truth so every launch site
// (singleton scraper, PDF export, screenshot export) behaves identically.
function getLaunchOptions() {
  const opts = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  };
  const { path } = resolveExecutable();
  if (path) opts.executablePath = path;
  return opts;
}

function isBrowserAlive(b) {
  if (!b) return false;
  // Puppeteer v22+ exposes the `connected` property; older versions only have isConnected().
  if (typeof b.connected === 'boolean') return b.connected;
  if (typeof b.isConnected === 'function') return b.isConnected();
  return false;
}

async function getBrowser() {
  if (!isBrowserAlive(browserInstance)) {
    try {
      browserInstance = await puppeteer.launch(getLaunchOptions());
    } catch (err) {
      throw enrichLaunchError(err);
    }
  }
  return browserInstance;
}

async function closeBrowser() {
  if (isBrowserAlive(browserInstance)) {
    try { await browserInstance.close(); } catch { /* ignore — process may be tearing down */ }
  }
  browserInstance = null;
}

/**
 * Startup probe — try launching and closing a browser once.
 * Returns { ok, executablePath?, source?, error? } so callers can log readable
 * diagnostics without crashing the HTTP server. Use at boot to surface
 * "Chrome missing" early.
 */
async function verifyBrowser() {
  const { path: resolvedPath, source } = resolveExecutable();
  let probe;
  try {
    probe = await puppeteer.launch(getLaunchOptions());
    const executablePath = typeof probe.process === 'function'
      ? (probe.process()?.spawnfile || resolvedPath || null)
      : (resolvedPath || null);
    await probe.close();
    return { ok: true, executablePath, source };
  } catch (err) {
    if (probe) { try { await probe.close(); } catch {} }
    return { ok: false, error: enrichLaunchError(err), attemptedPath: resolvedPath, source };
  }
}

function enrichLaunchError(err) {
  const msg = String(err && err.message || err);
  // Puppeteer's "Could not find Chrome" message is the canonical missing-binary signal.
  if (/Could not find (Chrome|Chromium|browser)/i.test(msg) || /ENOENT/.test(msg)) {
    const e = new Error(
      'Puppeteer cannot find a Chrome/Chromium binary.\n' +
      '  → Install the bundled browser:  npx puppeteer browsers install chrome\n' +
      '  → Or point Puppeteer at an existing Chrome/Edge install via the\n' +
      '    PUPPETEER_EXECUTABLE_PATH environment variable.\n' +
      '  Original error: ' + msg
    );
    e.code = 'PUPPETEER_BROWSER_MISSING';
    e.cause = err;
    return e;
  }
  return err;
}

/**
 * Fetch a page with Puppeteer, returning rich data about the page.
 * The Puppeteer page is kept open and returned as `page` so audit modules
 * can capture targeted screenshots before it's closed.
 */
async function scrapePage(url, options = {}) {
  const t0 = Date.now();
  const browser = await getBrowser();
  const page = await browser.newPage();
  const timeout = options.timeout || 25000;

  await page.setViewport({ width: 1440, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  const resourceData = { images: [], scripts: [], stylesheets: [], fonts: [] };
  const requests = [];
  const responses = [];
  let redirectChain = [];

  page.on('request', req => {
    requests.push({ url: req.url(), type: req.resourceType(), method: req.method() });
  });

  page.on('response', resp => {
    responses.push({
      url: resp.url(),
      status: resp.status(),
      headers: resp.headers(),
      type: resp.request().resourceType()
    });
    const type = resp.request().resourceType();
    const entry = { url: resp.url(), status: resp.status(), size: parseInt(resp.headers()['content-length'] || '0', 10) };
    if (type === 'image') resourceData.images.push(entry);
    else if (type === 'script') resourceData.scripts.push(entry);
    else if (type === 'stylesheet') resourceData.stylesheets.push(entry);
    else if (type === 'font') resourceData.fonts.push(entry);
  });

  const startTime = Date.now();
  let navigationResponse;
  try {
    // `load` fires when document + subresources are loaded. We deliberately
    // avoid `networkidle2` because long-lived analytics / chat-widget / polling
    // connections keep many real sites from ever reaching network idle, which
    // forced previous audits to wait the full 30 s timeout.
    navigationResponse = await page.goto(url, { waitUntil: 'load', timeout });
  } catch (err) {
    await page.close();
    throw new Error(`Failed to load ${url}: ${err.message}`);
  }
  const loadTime = Date.now() - startTime;
  console.log(`[scrape] goto=${loadTime}ms status=${navigationResponse?.status() || 0} url=${url}`);

  if (navigationResponse) {
    redirectChain = navigationResponse.request().redirectChain().map(r => ({
      url: r.url(),
      status: r.response()?.status()
    }));
  }

  const html = await page.content();
  const $ = cheerio.load(html);

  const performanceTiming = await page.evaluate(() => {
    const timing = performance.getEntriesByType('navigation')[0];
    if (!timing) return null;
    return {
      domContentLoaded: timing.domContentLoadedEventEnd - timing.startTime,
      domInteractive: timing.domInteractive - timing.startTime,
      loadComplete: timing.loadEventEnd - timing.startTime,
      ttfb: timing.responseStart - timing.startTime,
      transferSize: timing.transferSize,
      encodedBodySize: timing.encodedBodySize,
      decodedBodySize: timing.decodedBodySize
    };
  });

  const pageMetrics = await page.evaluate(() => {
    const body = document.body;
    const allElements = document.querySelectorAll('*');
    const fonts = new Set();
    const colors = new Set();
    const fontSizes = new Set();

    for (let i = 0; i < Math.min(allElements.length, 500); i++) {
      const computed = window.getComputedStyle(allElements[i]);
      fonts.add(computed.fontFamily.split(',')[0].trim().replace(/['"]/g, ''));
      colors.add(computed.color);
      colors.add(computed.backgroundColor);
      fontSizes.add(computed.fontSize);
    }

    return {
      fonts: [...fonts],
      colors: [...colors],
      fontSizes: [...fontSizes],
      viewportMeta: document.querySelector('meta[name="viewport"]')?.getAttribute('content') || null,
      bodyText: body?.innerText?.substring(0, 50000) || '',
      title: document.title,
      lang: document.documentElement.lang || null
    };
  });

  // Take a full-page screenshot for reference
  let fullPageScreenshot = null;
  const ssStart = Date.now();
  try {
    const ssBuffer = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 50 });
    fullPageScreenshot = Buffer.from(ssBuffer).toString('base64');
  } catch { /* non-fatal */ }
  console.log(`[scrape] fullPageScreenshot=${Date.now() - ssStart}ms total=${Date.now() - t0}ms`);

  const result = {
    url,
    html,
    $,
    page,  // Keep page open for element screenshots
    loadTime,
    performanceTiming,
    resources: resourceData,
    requests,
    responses,
    redirectChain,
    pageMetrics,
    fullPageScreenshot,
    responseHeaders: navigationResponse ? Object.fromEntries(
      Object.entries(navigationResponse.headers())
    ) : {},
    statusCode: navigationResponse?.status() || 0
  };

  // NOTE: page is NOT closed here — caller must call closePage(pageData) when done
  return result;
}

/**
 * Close the Puppeteer page after screenshots are captured
 */
async function closePage(pageData) {
  if (pageData && pageData.page && !pageData.page.isClosed()) {
    await pageData.page.close();
  }
}

/**
 * Capture a screenshot of a specific CSS selector on the live page.
 * Returns base64 JPEG string or null if element not found / error.
 */
async function screenshotElement(page, selector, options = {}) {
  try {
    const el = await page.$(selector);
    if (!el) return null;

    // Scroll element into view
    await el.scrollIntoView();
    await new Promise(r => setTimeout(r, 200));

    const ssBuffer = await el.screenshot({
      type: 'jpeg',
      quality: options.quality || 65
    });
    return Buffer.from(ssBuffer).toString('base64');
  } catch {
    return null;
  }
}

/**
 * Capture a screenshot of a page region (clip area).
 * Returns base64 JPEG string or null on error.
 */
async function screenshotRegion(page, clip, options = {}) {
  try {
    const ssBuffer = await page.screenshot({
      type: 'jpeg',
      quality: options.quality || 65,
      clip
    });
    return Buffer.from(ssBuffer).toString('base64');
  } catch {
    return null;
  }
}

/**
 * Capture above-the-fold screenshot (first viewport).
 */
async function screenshotAboveFold(page) {
  try {
    // Scroll to top first
    await page.evaluate(() => window.scrollTo(0, 0));
    await new Promise(r => setTimeout(r, 300));
    const ssBuffer = await page.screenshot({
      type: 'jpeg',
      quality: 65,
      clip: { x: 0, y: 0, width: 1440, height: 900 }
    });
    return Buffer.from(ssBuffer).toString('base64');
  } catch {
    return null;
  }
}

/**
 * Capture multiple elements matching a selector (max N).
 * Returns array of { selector, index, base64 }.
 */
async function screenshotElements(page, selector, maxCount = 3) {
  const results = [];
  try {
    const elements = await page.$$(selector);
    for (let i = 0; i < Math.min(elements.length, maxCount); i++) {
      try {
        await elements[i].scrollIntoView();
        await new Promise(r => setTimeout(r, 150));
        const ssBuffer = await elements[i].screenshot({ type: 'jpeg', quality: 60 });
        results.push({
          index: i,
          base64: Buffer.from(ssBuffer).toString('base64')
        });
      } catch { /* skip this element */ }
    }
  } catch { /* non-fatal */ }
  return results;
}

/**
 * Quick HTTP HEAD/GET check for a URL — returns status code
 */
function checkUrl(targetUrl, timeoutMs = 5000) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(targetUrl);
      const client = parsed.protocol === 'https:' ? https : http;
      const req = client.request(targetUrl, { method: 'HEAD', timeout: timeoutMs }, (res) => {
        resolve({ url: targetUrl, status: res.statusCode, ok: res.statusCode < 400 });
      });
      req.on('error', () => resolve({ url: targetUrl, status: 0, ok: false }));
      req.on('timeout', () => { req.destroy(); resolve({ url: targetUrl, status: 0, ok: false }); });
      req.end();
    } catch {
      resolve({ url: targetUrl, status: 0, ok: false });
    }
  });
}

/**
 * Crawl links from a page up to a given depth
 */
async function crawlLinks(baseUrl, $, depth = 1) {
  const base = new URL(baseUrl);
  const links = new Set();
  const internal = [];
  const external = [];

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) return;
    try {
      const resolved = new URL(href, baseUrl);
      const link = resolved.origin + resolved.pathname;
      if (!links.has(link)) {
        links.add(link);
        if (resolved.hostname === base.hostname) {
          internal.push(link);
        } else {
          external.push(link);
        }
      }
    } catch { /* skip malformed */ }
  });

  // Cap at 30 links with 12 in flight. Worst case ~12.5 s instead of ~80 s.
  // Auditors care about a representative sample of broken-link signal, not
  // a 100% crawl of the site.
  const t0 = Date.now();
  const allLinks = [...internal, ...external].slice(0, 30);
  const results = [];
  const batchSize = 12;
  for (let i = 0; i < allLinks.length; i += batchSize) {
    const batch = allLinks.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(l => checkUrl(l)));
    results.push(...batchResults);
  }

  const broken = results.filter(r => !r.ok);
  console.log(`[crawlLinks] checked=${results.length} broken=${broken.length} dur=${Date.now() - t0}ms`);

  return { internal, external, broken, allChecked: results };
}

module.exports = {
  scrapePage, closePage, closeBrowser, checkUrl, crawlLinks, getBrowser,
  screenshotElement, screenshotRegion, screenshotAboveFold, screenshotElements,
  verifyBrowser, getLaunchOptions, resolveExecutable
};
