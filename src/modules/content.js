const { finding, fleschKincaid } = require('../utils');

async function runContentAudit(pageData) {
  const { $, pageMetrics } = pageData;
  const results = {
    id: 'content',
    name: 'Content Audit',
    score: 0,
    maxScore: 10,
    findings: [],
    metrics: {}
  };

  let score = 10;
  const bodyText = pageMetrics.bodyText || '';

  // Word count
  const words = bodyText.split(/\s+/).filter(w => w.length > 0);
  const wordCount = words.length;
  results.metrics.wordCount = wordCount;

  if (wordCount < 150) {
    results.findings.push(finding(`Very low word count (${wordCount} words) — thin content penalty risk`, 'critical', 'Add substantial content (500+ words) — Google penalizes thin pages'));
    score -= 3;
  } else if (wordCount < 500) {
    results.findings.push(finding(`Low word count (${wordCount} words) — below recommended minimum`, 'warning', 'Top-ranking pages average 800+ words — expand content depth'));
    score -= 1.5;
  } else {
    results.findings.push(finding(`Word count: ${wordCount} words — meets content depth standards`, 'good'));
  }

  // Readability
  const readability = fleschKincaid(bodyText);
  results.metrics.readability = readability;

  if (readability.score > 0) {
    let readLevel;
    if (readability.score >= 80) readLevel = 'Easy (6th grade)';
    else if (readability.score >= 60) readLevel = 'Standard (8th-9th grade)';
    else if (readability.score >= 40) readLevel = 'Difficult (college level)';
    else readLevel = 'Very Difficult (professional)';

    const sev = readability.score >= 50 ? 'good' : readability.score >= 30 ? 'warning' : 'critical';
    results.findings.push(finding(
      `Flesch Reading Ease: ${readability.score} — ${readLevel} (Grade ${readability.grade})`,
      sev,
      sev !== 'good' ? 'Simplify language: shorter sentences, common words, active voice' : ''
    ));
    if (sev === 'critical') score -= 1.5;
    else if (sev === 'warning') score -= 0.5;
  }

  // Duplicate title/description
  const title = $('title').text().trim();
  const metaDesc = $('meta[name="description"]').attr('content')?.trim() || '';
  if (title && metaDesc && title.toLowerCase() === metaDesc.toLowerCase()) {
    results.findings.push(finding('Title and meta description are identical', 'warning', 'Write unique, complementary title and description'));
    score -= 1;
  }

  // Content sections analysis
  const sections = [];
  $('section, article, main, .content, [role="main"]').each((_, el) => {
    const text = $(el).text().trim();
    const sectionWords = text.split(/\s+/).filter(w => w.length > 0).length;
    sections.push(sectionWords);
  });

  if (sections.length > 0) {
    const thinSections = sections.filter(w => w < 50);
    if (thinSections.length > sections.length / 2) {
      results.findings.push(finding(`${thinSections.length}/${sections.length} content sections have thin content (<50 words)`, 'warning', 'Expand thin sections or consolidate them'));
      score -= 1;
    }
  }

  // CTA text analysis — conversion-focused language
  const ctaTexts = [];
  $('a.btn, a.button, button, .cta, [class*="cta"]').each((_, el) => {
    ctaTexts.push($(el).text().trim().toLowerCase());
  });

  const actionWords = ['get', 'start', 'try', 'buy', 'sign up', 'join', 'download', 'subscribe', 'book', 'request', 'schedule', 'claim'];
  const hasActionCTAs = ctaTexts.some(t => actionWords.some(a => t.includes(a)));

  if (ctaTexts.length > 0 && !hasActionCTAs) {
    results.findings.push(finding('CTA buttons lack action-oriented language', 'warning', 'Use verbs like "Get Started", "Try Free", "Book Now"'));
    score -= 0.5;
  } else if (hasActionCTAs) {
    results.findings.push(finding('CTAs use conversion-focused language', 'good'));
  }

  // Check for content freshness signals
  const datePatterns = $('time, [datetime], .date, .published, .updated').length;
  if (datePatterns > 0) {
    results.findings.push(finding('Content date/timestamp markers found', 'good'));
  }

  // Paragraph length
  const longParagraphs = $('p').filter((_, el) => {
    const text = $(el).text().trim();
    return text.split(/\s+/).length > 150;
  }).length;

  if (longParagraphs > 3) {
    results.findings.push(finding(`${longParagraphs} long paragraphs (150+ words) — may hurt readability`, 'warning', 'Break long paragraphs into shorter, scannable chunks'));
    score -= 0.5;
  }

  // Lists and scannable content
  const listItems = $('ul li, ol li').length;
  if (wordCount > 500 && listItems === 0) {
    results.findings.push(finding('No lists found on a content-heavy page', 'warning', 'Use bullet/numbered lists to improve scannability'));
    score -= 0.5;
  }

  results.score = Math.max(0, Math.round(score * 10) / 10);
  return results;
}

module.exports = { runContentAudit };
