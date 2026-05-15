const { finding } = require('../utils');
const { checkUrl } = require('../scraper');
const { URL } = require('url');

async function runSeoAudit(pageData, linkData) {
  const { $, url, responseHeaders } = pageData;
  const results = {
    id: 'seo',
    name: 'SEO Audit',
    score: 0,
    maxScore: 10,
    findings: []
  };

  let score = 10;
  const parsed = new URL(url);

  // Meta title
  const title = $('title').text().trim();
  if (!title) {
    results.findings.push(finding('Missing meta title', 'critical', 'Add a descriptive <title> tag (50-60 characters)'));
    score -= 2;
  } else if (title.length < 30) {
    results.findings.push(finding(`Meta title too short (${title.length} chars): "${title}"`, 'warning', 'Expand title to 50-60 characters with primary keywords'));
    score -= 0.5;
  } else if (title.length > 60) {
    results.findings.push(finding(`Meta title too long (${title.length} chars)`, 'warning', 'Trim title to under 60 characters'));
    score -= 0.5;
  } else {
    results.findings.push(finding(`Meta title present (${title.length} chars)`, 'good'));
  }

  // Meta description
  const metaDesc = $('meta[name="description"]').attr('content')?.trim();
  if (!metaDesc) {
    results.findings.push(finding('Missing meta description', 'critical', 'Add a meta description (120-160 characters) with target keywords'));
    score -= 2;
  } else if (metaDesc.length < 70) {
    results.findings.push(finding(`Meta description too short (${metaDesc.length} chars)`, 'warning', 'Expand to 120-160 characters'));
    score -= 0.5;
  } else if (metaDesc.length > 160) {
    results.findings.push(finding(`Meta description too long (${metaDesc.length} chars)`, 'warning', 'Trim to under 160 characters'));
    score -= 0.5;
  } else {
    results.findings.push(finding(`Meta description present (${metaDesc.length} chars)`, 'good'));
  }

  // Open Graph tags
  const ogTitle = $('meta[property="og:title"]').attr('content');
  const ogDesc = $('meta[property="og:description"]').attr('content');
  const ogImage = $('meta[property="og:image"]').attr('content');
  const ogMissing = [];
  if (!ogTitle) ogMissing.push('og:title');
  if (!ogDesc) ogMissing.push('og:description');
  if (!ogImage) ogMissing.push('og:image');

  if (ogMissing.length === 0) {
    results.findings.push(finding('Open Graph tags present (title, description, image)', 'good'));
  } else if (ogMissing.length >= 3) {
    results.findings.push(finding(`All OG tags missing: ${ogMissing.join(', ')}`, 'critical', 'Add Open Graph tags — essential for social media sharing and link previews'));
    score -= 1.5;
  } else {
    results.findings.push(finding(`Missing OG tags: ${ogMissing.join(', ')}`, 'warning', 'Add Open Graph tags for better social media sharing'));
    score -= 0.75;
  }

  // Twitter Card
  const twitterCard = $('meta[name="twitter:card"]').attr('content');
  if (!twitterCard) {
    results.findings.push(finding('Missing Twitter Card meta tags', 'warning', 'Add twitter:card meta for better Twitter link previews'));
    score -= 0.25;
  }

  // Heading structure
  const h1Count = $('h1').length;
  if (h1Count === 0) {
    results.findings.push(finding('No H1 heading found', 'critical', 'Add a single H1 tag with primary keyword'));
    score -= 2;
  } else if (h1Count > 1) {
    results.findings.push(finding(`Multiple H1 tags (${h1Count})`, 'warning', 'Use only one H1 per page'));
    score -= 0.5;
  } else {
    results.findings.push(finding('Single H1 present', 'good'));
  }

  // Check heading nesting
  let prevLevel = 0;
  let headingIssues = 0;
  $('h1, h2, h3, h4, h5, h6').each((_, el) => {
    const level = parseInt(el.tagName[1]);
    if (prevLevel > 0 && level > prevLevel + 1) headingIssues++;
    prevLevel = level;
  });
  if (headingIssues > 0) {
    results.findings.push(finding(`${headingIssues} heading level skip(s) detected`, 'warning', 'Use sequential heading levels (H1→H2→H3)'));
    score -= 0.5;
  }

  // URL structure
  const urlPath = parsed.pathname;
  if (urlPath.length > 100) {
    results.findings.push(finding(`Long URL path (${urlPath.length} chars)`, 'warning', 'Keep URLs short and descriptive'));
    score -= 0.5;
  }
  if (urlPath.includes('_')) {
    results.findings.push(finding('URL uses underscores instead of hyphens', 'warning', 'Use hyphens (-) as word separators in URLs'));
    score -= 0.25;
  }
  if (/[A-Z]/.test(urlPath)) {
    results.findings.push(finding('URL contains uppercase characters', 'warning', 'Use lowercase URLs to avoid duplicate content'));
    score -= 0.25;
  }

  // Canonical tag
  const canonical = $('link[rel="canonical"]').attr('href');
  if (!canonical) {
    results.findings.push(finding('Missing canonical tag — risk of duplicate content penalties', 'critical', 'Add <link rel="canonical"> to prevent duplicate content indexing'));
    score -= 1.5;
  } else {
    results.findings.push(finding('Canonical tag present', 'good'));
  }

  // sitemap.xml and robots.txt
  const sitemapResult = await checkUrl(`${parsed.origin}/sitemap.xml`);
  if (sitemapResult.ok) {
    results.findings.push(finding('sitemap.xml found', 'good'));
  } else {
    results.findings.push(finding('sitemap.xml not found', 'warning', 'Create a sitemap.xml for better search engine crawling'));
    score -= 0.5;
  }

  const robotsResult = await checkUrl(`${parsed.origin}/robots.txt`);
  if (robotsResult.ok) {
    results.findings.push(finding('robots.txt found', 'good'));
  } else {
    results.findings.push(finding('robots.txt not found', 'warning', 'Create a robots.txt to guide search engine crawlers'));
    score -= 0.5;
  }

  // Internal vs external links
  if (linkData) {
    results.findings.push(finding(`${linkData.internal.length} internal links, ${linkData.external.length} external links`, 'good'));
    if (linkData.broken.length > 0) {
      results.findings.push(finding(`${linkData.broken.length} broken links detected`, 'critical', 'Fix or remove broken links'));
      score -= Math.min(2, linkData.broken.length * 0.5);
    }
  }

  // Structured data
  const jsonLd = $('script[type="application/ld+json"]');
  if (jsonLd.length > 0) {
    results.findings.push(finding(`${jsonLd.length} structured data block(s) found (JSON-LD)`, 'good'));
  } else {
    const microdata = $('[itemscope]').length;
    if (microdata > 0) {
      results.findings.push(finding(`${microdata} microdata elements found`, 'good'));
    } else {
      results.findings.push(finding('No structured data (JSON-LD or microdata) found', 'warning', 'Add structured data for rich search results'));
      score -= 0.5;
    }
  }

  results.score = Math.max(0, Math.round(score * 10) / 10);
  return results;
}

module.exports = { runSeoAudit };
