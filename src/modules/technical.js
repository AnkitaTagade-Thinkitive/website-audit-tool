const { finding } = require('../utils');
const { checkUrl } = require('../scraper');
const { URL } = require('url');
const https = require('https');
const http = require('http');

async function runTechnicalAudit(pageData, linkData) {
  const { $, url, redirectChain, responseHeaders, statusCode, pageMetrics } = pageData;
  const results = {
    id: 'technical',
    name: 'Technical Audit',
    score: 0,
    maxScore: 10,
    findings: []
  };

  let score = 10;
  const parsed = new URL(url);

  // Broken links
  if (linkData) {
    const broken = linkData.broken;
    if (broken.length === 0) {
      results.findings.push(finding(`All ${linkData.allChecked.length} checked links are working`, 'good'));
    } else {
      const details = broken.slice(0, 5).map(b => `${b.url} (${b.status || 'timeout'})`).join('; ');
      results.findings.push(finding(
        `${broken.length} broken links found: ${details}`,
        broken.length > 5 ? 'critical' : 'warning',
        'Fix or remove broken links to improve UX and SEO'
      ));
      score -= Math.min(3, broken.length * 0.5);
    }
  }

  // HTTPS check
  if (parsed.protocol === 'https:') {
    results.findings.push(finding('Site uses HTTPS', 'good'));
  } else {
    results.findings.push(finding('Site does not use HTTPS', 'critical', 'Migrate to HTTPS for security and SEO benefits'));
    score -= 3;
  }

  // HTTP → HTTPS redirect
  if (parsed.protocol === 'https:') {
    try {
      const httpUrl = url.replace('https://', 'http://');
      const httpResult = await checkHttpRedirect(httpUrl);
      if (httpResult.redirectsToHttps) {
        results.findings.push(finding('HTTP properly redirects to HTTPS', 'good'));
      } else {
        results.findings.push(finding('HTTP does not redirect to HTTPS', 'warning', 'Set up 301 redirect from HTTP to HTTPS'));
        score -= 1;
      }
    } catch {
      // Skip if can't check
    }
  }

  // Redirect chains
  if (redirectChain.length > 2) {
    results.findings.push(finding(
      `Redirect chain detected (${redirectChain.length} hops)`,
      'warning',
      'Reduce redirect chains to a single redirect'
    ));
    score -= 1;
  } else if (redirectChain.length > 0) {
    results.findings.push(finding(`${redirectChain.length} redirect(s) — acceptable`, 'good'));
  }

  // Schema / structured data
  const jsonLd = $('script[type="application/ld+json"]');
  const microdata = $('[itemscope]');
  if (jsonLd.length === 0 && microdata.length === 0) {
    results.findings.push(finding('No structured data markup found', 'warning', 'Add JSON-LD structured data for rich search results'));
    score -= 1;
  } else {
    results.findings.push(finding(`Structured data present: ${jsonLd.length} JSON-LD, ${microdata.length} microdata`, 'good'));
  }

  // Viewport meta tag
  if (pageMetrics.viewportMeta) {
    results.findings.push(finding('Viewport meta tag present', 'good'));
  } else {
    results.findings.push(finding('Missing viewport meta tag', 'critical', 'Add <meta name="viewport" content="width=device-width, initial-scale=1">'));
    score -= 2;
  }

  // robots.txt analysis
  try {
    const robotsUrl = `${parsed.origin}/robots.txt`;
    const robotsContent = await fetchText(robotsUrl);
    if (robotsContent) {
      results.findings.push(finding('robots.txt present and accessible', 'good'));

      // Check for Disallow: /
      if (robotsContent.includes('Disallow: /') && !robotsContent.includes('Disallow: / ')) {
        const lines = robotsContent.split('\n');
        const blockAll = lines.some(l => l.trim() === 'Disallow: /');
        if (blockAll) {
          results.findings.push(finding('robots.txt blocks all crawlers (Disallow: /)', 'critical', 'Review robots.txt — this blocks search engines from indexing'));
          score -= 2;
        }
      }
    }
  } catch {
    // Already checked in SEO module
  }

  // Check for common performance-affecting issues
  const inlineScripts = $('script:not([src])').length;
  if (inlineScripts > 10) {
    results.findings.push(finding(`${inlineScripts} inline scripts found`, 'warning', 'Externalize scripts for better caching'));
    score -= 0.5;
  }

  // Charset declaration
  const charset = $('meta[charset]').attr('charset') || $('meta[http-equiv="Content-Type"]').attr('content');
  if (!charset) {
    results.findings.push(finding('No charset declaration found', 'warning', 'Add <meta charset="UTF-8"> in <head>'));
    score -= 0.5;
  }

  // Favicon
  const favicon = $('link[rel="icon"], link[rel="shortcut icon"]').length;
  if (favicon === 0) {
    results.findings.push(finding('No favicon declared', 'warning', 'Add a favicon for browser tab and bookmark identification'));
    score -= 0.25;
  }

  // Doctype
  const html = pageData.html;
  if (!html.toLowerCase().startsWith('<!doctype html>') && !html.toLowerCase().startsWith('<!doctype html')) {
    results.findings.push(finding('Missing or non-standard DOCTYPE', 'warning', 'Ensure page starts with <!DOCTYPE html>'));
    score -= 0.5;
  }

  results.score = Math.max(0, Math.round(score * 10) / 10);
  return results;
}

function checkHttpRedirect(httpUrl) {
  return new Promise((resolve) => {
    const req = http.request(httpUrl, { method: 'HEAD', timeout: 5000 }, (res) => {
      const location = res.headers.location || '';
      resolve({ redirectsToHttps: location.startsWith('https://') });
    });
    req.on('error', () => resolve({ redirectsToHttps: false }));
    req.on('timeout', () => { req.destroy(); resolve({ redirectsToHttps: false }); });
    req.end();
  });
}

function fetchText(targetUrl) {
  return new Promise((resolve) => {
    const client = targetUrl.startsWith('https') ? https : http;
    client.get(targetUrl, { timeout: 5000 }, (res) => {
      if (res.statusCode !== 200) return resolve(null);
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', () => resolve(null));
  });
}

module.exports = { runTechnicalAudit };
