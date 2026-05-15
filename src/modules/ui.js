const { finding, parseColor, contrastRatio } = require('../utils');
const { screenshotElement, screenshotElements } = require('../scraper');

async function runUiAudit(pageData) {
  const { $, pageMetrics, page } = pageData;
  const results = {
    id: 'ui',
    name: 'UI / Visual Design Audit',
    score: 0,
    maxScore: 10,
    findings: []
  };

  let score = 10;

  // Typography: font families (no screenshot — metric)
  const fonts = (pageMetrics.fonts || []).filter(f => f && !['inherit', 'initial', 'sans-serif', 'serif', 'monospace'].includes(f));
  if (fonts.length === 0) {
    results.findings.push(finding('No custom fonts detected — using browser defaults', 'warning', 'Define a consistent typography system'));
    score -= 1;
  } else if (fonts.length > 4) {
    results.findings.push(finding(`Too many font families (${fonts.length}): ${fonts.slice(0, 6).join(', ')}`, 'warning', 'Limit to 2-3 font families'));
    score -= 1.5;
  } else {
    results.findings.push(finding(`${fonts.length} font families: ${fonts.join(', ')}`, 'good'));
  }

  // Color palette extraction (no screenshot — extracted data)
  const colors = (pageMetrics.colors || []).filter(c => c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent');
  const uniqueColors = [...new Set(colors)];
  results.colorPalette = uniqueColors.slice(0, 20);

  if (uniqueColors.length > 15) {
    results.findings.push(finding(`Large color palette (${uniqueColors.length} unique colors) — may lack consistency`, 'warning', 'Define a color system with 8-12 core colors'));
    score -= 1;
  } else {
    results.findings.push(finding(`${uniqueColors.length} unique colors in use`, 'good'));
  }

  // Contrast compliance
  const textColors = colors.filter(c => c.startsWith('rgb'));
  const bgColors = pageMetrics.colors ? pageMetrics.colors.filter(c => c.startsWith('rgb')) : [];
  let contrastIssues = 0;

  for (let i = 0; i < Math.min(textColors.length, 10); i++) {
    const text = parseColor(textColors[i]);
    for (let j = 0; j < Math.min(bgColors.length, 5); j++) {
      const bg = parseColor(bgColors[j]);
      if (text && bg) {
        const ratio = contrastRatio(text, bg);
        if (ratio < 4.5 && ratio > 1.1) {
          contrastIssues++;
        }
      }
    }
  }

  if (contrastIssues > 5) {
    results.findings.push(finding(`${contrastIssues} potential contrast issues detected (below WCAG AA 4.5:1)`, 'critical', 'Ensure all text meets WCAG AA contrast minimums'));
    score -= 2;
  } else if (contrastIssues > 0) {
    results.findings.push(finding(`${contrastIssues} minor contrast issues found`, 'warning', 'Review text contrast ratios against backgrounds'));
    score -= 1;
  } else {
    results.findings.push(finding('Color contrast appears adequate in sampled pairs', 'good'));
  }

  // Visual hierarchy: heading structure — screenshot H1
  const headingCounts = {};
  for (let i = 1; i <= 6; i++) {
    headingCounts[`h${i}`] = $(`h${i}`).length;
  }
  results.headingStructure = headingCounts;

  if (headingCounts.h1 === 0) {
    const f = finding('No H1 heading found', 'critical', 'Add a single H1 as the primary page heading');
    // Screenshot the top of the page where H1 should be
    if (page) f.screenshot = await screenshotElement(page, 'header, main, body > div:first-child');
    results.findings.push(f);
    score -= 2;
  } else if (headingCounts.h1 > 1) {
    const f = finding(`Multiple H1 headings (${headingCounts.h1})`, 'warning', 'Use only one H1 per page');
    if (page) {
      const shots = await screenshotElements(page, 'h1', 2);
      if (shots.length > 0) f.screenshot = shots[0].base64;
    }
    results.findings.push(f);
    score -= 1;
  } else {
    results.findings.push(finding('Single H1 heading present — good hierarchy', 'good'));
  }

  // Check for heading level skips (no screenshot — structural)
  const levels = Object.entries(headingCounts).filter(([_, count]) => count > 0).map(([tag]) => parseInt(tag[1]));
  for (let i = 1; i < levels.length; i++) {
    if (levels[i] - levels[i - 1] > 1) {
      results.findings.push(finding(`Heading level skip: H${levels[i - 1]} → H${levels[i]}`, 'warning', 'Use sequential heading levels (H1 → H2 → H3)'));
      score -= 0.5;
      break;
    }
  }

  // Image quality — screenshot oversized images
  const images = $('img');
  const totalImages = images.length;
  let hugeImages = 0;
  let svgImages = 0;

  images.each((_, el) => {
    const src = $(el).attr('src') || '';
    const width = parseInt($(el).attr('width') || '0');
    const height = parseInt($(el).attr('height') || '0');
    if (src.endsWith('.svg')) svgImages++;
    if (width > 2000 || height > 2000) hugeImages++;
  });

  if (totalImages > 0) {
    results.findings.push(finding(`${totalImages} images (${svgImages} SVG)`, 'good'));
    if (hugeImages > 0) {
      const f = finding(`${hugeImages} oversized images detected (>2000px)`, 'warning', 'Optimize and resize large images');
      if (page) {
        const shots = await screenshotElements(page, 'img', 1);
        if (shots.length > 0) f.screenshot = shots[0].base64;
      }
      results.findings.push(f);
      score -= 1;
    }
  }

  // Images without dimensions (no screenshot — attribute check)
  const imagesNoDimensions = $('img:not([width]):not([style*="width"])').length;
  if (imagesNoDimensions > 3) {
    results.findings.push(finding(`${imagesNoDimensions} images without explicit dimensions`, 'warning', 'Set width/height on images to prevent layout shift'));
    score -= 0.5;
  }

  // Inline styles (no screenshot — code quality)
  const inlineStyleElements = $('[style]').length;
  if (inlineStyleElements > 20) {
    results.findings.push(finding(`${inlineStyleElements} elements with inline styles — may lack design system`, 'warning', 'Use CSS classes instead of inline styles'));
    score -= 1;
  }

  results.score = Math.max(0, Math.round(score * 10) / 10);
  return results;
}

module.exports = { runUiAudit };
