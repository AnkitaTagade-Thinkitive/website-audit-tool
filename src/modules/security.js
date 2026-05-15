const { finding } = require('../utils');
const { URL } = require('url');

async function runSecurityAudit(pageData) {
  const { $, url, responseHeaders, html, resources } = pageData;
  const results = {
    id: 'security',
    name: 'Security Audit',
    score: 0,
    maxScore: 10,
    findings: []
  };

  let score = 10;
  const parsed = new URL(url);

  // HTTPS check
  if (parsed.protocol === 'https:') {
    results.findings.push(finding('Site is served over HTTPS', 'good'));
  } else {
    results.findings.push(finding('Site is NOT served over HTTPS', 'critical', 'Migrate to HTTPS with a valid SSL certificate'));
    score -= 3;
  }

  // Security headers
  const headers = responseHeaders || {};
  const headerChecks = [
    {
      name: 'Content-Security-Policy',
      key: 'content-security-policy',
      severity: 'critical',
      rec: 'Implement Content-Security-Policy — #1 defense against XSS attacks (OWASP requirement)'
    },
    {
      name: 'X-Frame-Options',
      key: 'x-frame-options',
      severity: 'critical',
      rec: 'Add X-Frame-Options: DENY or SAMEORIGIN — prevents clickjacking attacks'
    },
    {
      name: 'X-Content-Type-Options',
      key: 'x-content-type-options',
      severity: 'critical',
      rec: 'Add X-Content-Type-Options: nosniff — prevents MIME-type sniffing attacks'
    },
    {
      name: 'Strict-Transport-Security',
      key: 'strict-transport-security',
      severity: 'critical',
      rec: 'Add HSTS header — enforces HTTPS and prevents downgrade attacks'
    },
    {
      name: 'Referrer-Policy',
      key: 'referrer-policy',
      severity: 'warning',
      rec: 'Add Referrer-Policy to control referrer information leakage'
    },
    {
      name: 'Permissions-Policy',
      key: 'permissions-policy',
      severity: 'warning',
      rec: 'Add Permissions-Policy to control browser feature access'
    },
    {
      name: 'X-XSS-Protection',
      key: 'x-xss-protection',
      severity: 'warning',
      rec: 'Add X-XSS-Protection: 1; mode=block (legacy browser protection)'
    }
  ];

  let presentHeaders = 0;
  for (const check of headerChecks) {
    if (headers[check.key]) {
      results.findings.push(finding(`${check.name} header present: ${headers[check.key]}`, 'good'));
      presentHeaders++;
    } else {
      results.findings.push(finding(`Missing ${check.name} header`, check.severity, check.rec));
      score -= (check.severity === 'critical' ? 1 : 0.5);
    }
  }

  // Mixed content detection
  const httpResources = [];
  if (parsed.protocol === 'https:') {
    $('script[src], link[href], img[src], iframe[src], video[src], audio[src]').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('href') || '';
      if (src.startsWith('http://')) {
        httpResources.push(src);
      }
    });

    if (httpResources.length > 0) {
      results.findings.push(finding(
        `${httpResources.length} mixed content resource(s) loaded over HTTP`,
        'critical',
        'Load all resources over HTTPS to prevent mixed content warnings'
      ));
      score -= 2;
    } else {
      results.findings.push(finding('No mixed content detected', 'good'));
    }
  }

  // Outdated library detection
  const scriptSrcs = [];
  $('script[src]').each((_, el) => {
    scriptSrcs.push($(el).attr('src') || '');
  });

  const oldLibraries = [];
  const libraryPatterns = [
    { pattern: /jquery[.-]1\./i, name: 'jQuery 1.x' },
    { pattern: /jquery[.-]2\./i, name: 'jQuery 2.x' },
    { pattern: /angular[.-]1\./i, name: 'AngularJS 1.x' },
    { pattern: /bootstrap[.-][23]\./i, name: 'Bootstrap 2.x/3.x' },
    { pattern: /moment[.-]2\.([0-9]|1[0-9])\./i, name: 'Moment.js (old)' },
    { pattern: /lodash[.-][0-3]\./i, name: 'Lodash (old)' }
  ];

  for (const src of scriptSrcs) {
    for (const lib of libraryPatterns) {
      if (lib.pattern.test(src)) {
        oldLibraries.push(lib.name);
      }
    }
  }

  // Also check inline script content for library versions
  const inlineScripts = $.html();
  for (const lib of libraryPatterns) {
    if (lib.pattern.test(inlineScripts) && !oldLibraries.includes(lib.name)) {
      oldLibraries.push(lib.name);
    }
  }

  if (oldLibraries.length > 0) {
    results.findings.push(finding(
      `Potentially outdated libraries detected: ${oldLibraries.join(', ')}`,
      'warning',
      'Update libraries to latest stable versions for security patches'
    ));
    score -= 1;
  }

  // Exposed information in HTML comments
  const commentCount = (html.match(/<!--[\s\S]*?-->/g) || []).length;
  const sensitiveComments = (html.match(/<!--[\s\S]*?(password|api_key|secret|token|TODO|FIXME|HACK|debug)[\s\S]*?-->/gi) || []).length;
  if (sensitiveComments > 0) {
    results.findings.push(finding(
      `${sensitiveComments} HTML comment(s) with potentially sensitive content`,
      'warning',
      'Remove comments containing passwords, API keys, or debug information'
    ));
    score -= 1;
  }

  // Form security
  const insecureForms = $('form[action^="http://"]').length;
  if (insecureForms > 0) {
    results.findings.push(finding(
      `${insecureForms} form(s) submitting over HTTP`,
      'critical',
      'Ensure all form actions use HTTPS'
    ));
    score -= 2;
  }

  // Autocomplete on sensitive fields
  const passwordFields = $('input[type="password"]');
  passwordFields.each((_, el) => {
    if ($(el).attr('autocomplete') !== 'off' && $(el).attr('autocomplete') !== 'new-password') {
      // This is actually recommended now, so just note it
    }
  });

  results.score = Math.max(0, Math.round(score * 10) / 10);
  return results;
}

module.exports = { runSecurityAudit };
