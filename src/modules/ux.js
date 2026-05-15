const { finding } = require('../utils');
const { screenshotElement, screenshotElements, screenshotAboveFold } = require('../scraper');

async function runUxAudit(pageData) {
  const { $, pageMetrics, html, page } = pageData;
  const results = {
    id: 'ux',
    name: 'UX Audit',
    score: 0,
    maxScore: 10,
    findings: []
  };

  let score = 10;

  // Navigation structure & depth
  const navElements = $('nav, [role="navigation"]');
  const navCount = navElements.length;
  if (navCount === 0) {
    const f = finding('No <nav> or navigation landmarks found', 'critical', 'Add semantic navigation elements');
    if (page) f.screenshot = await screenshotElement(page, 'header') || await screenshotAboveFold(page);
    results.findings.push(f);
    score -= 2;
  } else {
    results.findings.push(finding(`${navCount} navigation region(s) detected`, 'good'));
  }

  // Menu hierarchy depth
  const nestedMenus = $('nav ul ul ul').length;
  if (nestedMenus > 0) {
    results.findings.push(finding(`Deep menu nesting detected (${nestedMenus} 3+ level menus)`, 'warning', 'Keep navigation depth to 2 levels maximum'));
    score -= 1;
  }

  // CTA analysis
  const ctaSelectors = 'a.btn, a.button, button:not([type="submit"]), .cta, [class*="cta"], a[class*="btn"], a[class*="button"]';
  const ctas = $(ctaSelectors);
  const ctaCount = ctas.length;

  if (ctaCount === 0) {
    const f = finding('No clear CTA buttons detected', 'critical', 'Add prominent call-to-action buttons');
    if (page) f.screenshot = await screenshotAboveFold(page);
    results.findings.push(f);
    score -= 2;
  } else if (ctaCount > 10) {
    results.findings.push(finding(`Excessive CTAs (${ctaCount}) — may cause decision fatigue`, 'warning', 'Prioritize 1-3 primary CTAs per page'));
    score -= 1;
  } else {
    results.findings.push(finding(`${ctaCount} CTA element(s) found`, 'good'));
  }

  // CTA text analysis — screenshot generic CTA buttons
  const genericCTAs = [];
  ctas.each((_, el) => {
    const text = $(el).text().trim().toLowerCase();
    if (['click here', 'submit', 'read more', 'learn more', 'here', 'more', 'go', 'ok', 'next'].includes(text)) {
      genericCTAs.push(text);
    }
  });
  if (genericCTAs.length > 0) {
    const f = finding(`Generic CTA text found: "${genericCTAs.join('", "')}"`, 'critical', 'Use action-oriented, specific CTA text (e.g., "Start Free Trial", "Get Quote")');
    if (page) {
      const shots = await screenshotElements(page, ctaSelectors, 2);
      if (shots.length > 0) f.screenshot = shots[0].base64;
    }
    results.findings.push(f);
    score -= 1.5;
  }

  // Mobile viewport (no screenshot — invisible meta tag)
  if (pageMetrics.viewportMeta) {
    results.findings.push(finding('Viewport meta tag present', 'good'));
    if (!pageMetrics.viewportMeta.includes('width=device-width')) {
      results.findings.push(finding('Viewport meta missing width=device-width', 'warning', 'Set viewport to width=device-width for proper mobile rendering'));
      score -= 1;
    }
  } else {
    results.findings.push(finding('Missing viewport meta tag — not mobile optimized', 'critical', 'Add <meta name="viewport" content="width=device-width, initial-scale=1">'));
    score -= 2;
  }

  // Responsive indicators (no screenshot — CSS-level check)
  const hasMediaQueries = html.includes('@media');
  const hasFlexGrid = html.includes('flex') || html.includes('grid');
  if (!hasMediaQueries && !hasFlexGrid) {
    results.findings.push(finding('No responsive CSS patterns detected (media queries, flexbox, grid)', 'warning', 'Implement responsive design with CSS media queries'));
    score -= 1;
  }

  // Accessibility: alt text — screenshot images missing alt
  const totalImages = $('img').length;
  const imagesWithAlt = $('img[alt]').filter((_, el) => $(el).attr('alt').trim().length > 0).length;
  const emptyAlt = $('img[alt=""]').length;
  const missingAlt = totalImages - imagesWithAlt - emptyAlt;

  if (totalImages > 0) {
    const coverage = Math.round((imagesWithAlt / totalImages) * 100);
    if (missingAlt > 0) {
      const f = finding(`${missingAlt}/${totalImages} images missing alt text (${coverage}% coverage)`, missingAlt > 3 ? 'critical' : 'warning', 'Add descriptive alt text to all meaningful images');
      if (page) {
        const shots = await screenshotElements(page, 'img:not([alt])', 2);
        if (shots.length > 0) f.screenshot = shots[0].base64;
      }
      results.findings.push(f);
      score -= missingAlt > 3 ? 2 : 1;
    } else {
      results.findings.push(finding(`All ${totalImages} images have alt attributes (${coverage}% with text)`, 'good'));
    }
  }

  // ARIA labels (no screenshot — code-level check)
  const ariaLabels = $('[aria-label], [aria-labelledby], [aria-describedby]').length;
  const roleAttributes = $('[role]').length;
  if (ariaLabels === 0 && roleAttributes === 0) {
    results.findings.push(finding('No ARIA attributes found — fails WCAG 2.1 accessibility requirements', 'critical', 'Add ARIA labels and roles to all interactive elements (WCAG 4.1.2)'));
    score -= 2;
  } else if (ariaLabels < 3) {
    results.findings.push(finding(`Only ${ariaLabels} ARIA labels found — insufficient for accessibility compliance`, 'warning', 'Add ARIA labels to all interactive and landmark regions'));
    score -= 1;
  } else {
    results.findings.push(finding(`${ariaLabels} ARIA labels and ${roleAttributes} role attributes found`, 'good'));
  }

  // Keyboard navigation
  const focusableElements = $('a[href], button, input, select, textarea, [tabindex]').length;
  if (focusableElements === 0) {
    results.findings.push(finding('No focusable interactive elements detected', 'critical', 'Ensure all interactive elements are keyboard accessible'));
    score -= 2;
  }

  // Skip navigation link (no screenshot — invisible link)
  const hasSkipLink = $('a[href="#main"], a[href="#content"], .skip-nav, .skip-link, a:contains("Skip to")').length > 0;
  if (!hasSkipLink) {
    results.findings.push(finding('No skip navigation link found — fails WCAG 2.4.1', 'critical', 'Add a "Skip to content" link for keyboard and screen reader users'));
    score -= 1.5;
  }

  // Font consistency (no screenshot — metric check)
  const fontCount = (pageMetrics.fonts || []).filter(f => f && f !== 'inherit' && f !== 'initial').length;
  if (fontCount > 3) {
    results.findings.push(finding(`${fontCount} distinct font families detected — inconsistent typography`, 'warning', 'Limit to 2-3 font families for design consistency'));
    score -= 1.5;
  } else if (fontCount > 0) {
    results.findings.push(finding(`${fontCount} font families used — good consistency`, 'good'));
  }

  results.score = Math.max(0, Math.round(score * 10) / 10);
  return results;
}

module.exports = { runUxAudit };
