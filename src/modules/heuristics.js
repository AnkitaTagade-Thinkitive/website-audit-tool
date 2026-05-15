const Anthropic = require('@anthropic-ai/sdk');
const { finding } = require('../utils');

const HEURISTICS = [
  { id: 'visibility', name: 'Visibility of System Status', desc: 'The design should always keep users informed about what is going on.' },
  { id: 'match', name: 'Match Between System and Real World', desc: 'The design should speak the users\' language.' },
  { id: 'control', name: 'User Control and Freedom', desc: 'Users need a clearly marked emergency exit.' },
  { id: 'consistency', name: 'Consistency and Standards', desc: 'Users should not have to wonder whether different words, situations, or actions mean the same thing.' },
  { id: 'errorPrevention', name: 'Error Prevention', desc: 'Good error messages are important, but the best designs prevent problems from occurring.' },
  { id: 'recognition', name: 'Recognition Rather Than Recall', desc: 'Minimize the user\'s memory load.' },
  { id: 'flexibility', name: 'Flexibility and Efficiency of Use', desc: 'Shortcuts — hidden from novice users — may speed up interaction for experts.' },
  { id: 'aesthetic', name: 'Aesthetic and Minimalist Design', desc: 'Interfaces should not contain information that is irrelevant or rarely needed.' },
  { id: 'errorRecovery', name: 'Help Users Recognize, Diagnose, and Recover from Errors', desc: 'Error messages should be expressed in plain language.' },
  { id: 'help', name: 'Help and Documentation', desc: 'It may be necessary to provide documentation to help users understand how to complete their tasks.' }
];

async function runHeuristicsAudit(pageData) {
  const results = {
    id: 'heuristics',
    name: "Nielsen's 10 Heuristic Evaluation",
    score: 0,
    maxScore: 10,
    findings: [],
    heuristics: []
  };

  // Structural analysis first (rule-based)
  const structuralFindings = analyzeStructure(pageData);

  // AI-powered analysis
  let aiFindings = [];
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      aiFindings = await analyzeWithClaude(pageData);
    } catch (err) {
      results.findings.push(finding(
        `AI analysis unavailable: ${err.message}`,
        'warning',
        'Check your ANTHROPIC_API_KEY in .env'
      ));
    }
  }

  // Merge structural + AI findings per heuristic
  let totalScore = 0;
  for (const h of HEURISTICS) {
    const structural = structuralFindings.filter(f => f.heuristic === h.id);
    const ai = aiFindings.filter(f => f.heuristic === h.id);
    const allFindings = [...structural, ...ai];

    const criticals = allFindings.filter(f => f.severity === 'critical').length;
    const warnings = allFindings.filter(f => f.severity === 'warning').length;
    const score = Math.max(0, 10 - criticals * 3 - warnings * 1.5);

    totalScore += score;
    results.heuristics.push({
      ...h,
      score: Math.round(score * 10) / 10,
      maxScore: 10,
      findings: allFindings
    });
  }

  results.score = Math.round((totalScore / 100) * 10 * 10) / 10;
  results.findings = results.heuristics.flatMap(h => h.findings);

  return results;
}

function analyzeStructure(pageData) {
  const { $, pageMetrics, html } = pageData;
  const findings = [];

  // Visibility: loading indicators, progress bars, feedback elements
  const hasLoadingIndicators = $('[aria-busy], .loading, .spinner, [role="progressbar"], .loader').length > 0;
  if (!hasLoadingIndicators) {
    findings.push({
      heuristic: 'visibility',
      ...finding('No loading indicators or progress elements detected', 'warning', 'Add visual feedback for async operations')
    });
  }

  const hasBreadcrumbs = $('[aria-label="breadcrumb"], .breadcrumb, nav.breadcrumbs').length > 0;
  if (!hasBreadcrumbs) {
    findings.push({
      heuristic: 'visibility',
      ...finding('No breadcrumb navigation found', 'warning', 'Add breadcrumbs to help users understand their location')
    });
  }

  // Match: language attribute, jargon-free labels
  if (!pageMetrics.lang) {
    findings.push({
      heuristic: 'match',
      ...finding('Missing lang attribute on <html> element', 'critical', 'Add lang attribute (e.g., lang="en") for accessibility and localization')
    });
  }

  // Control: back buttons, undo, close buttons on modals
  const hasBackNav = $('a[href*="back"], button:contains("Back"), button:contains("Cancel"), [aria-label="Close"]').length > 0;
  if (!hasBackNav) {
    findings.push({
      heuristic: 'control',
      ...finding('Limited "undo" or "go back" navigation options detected', 'warning', 'Ensure users can easily reverse actions and navigate back')
    });
  }

  // Consistency: multiple font families, inconsistent buttons
  if (pageMetrics.fonts && pageMetrics.fonts.length > 4) {
    findings.push({
      heuristic: 'consistency',
      ...finding(`${pageMetrics.fonts.length} different font families detected — may indicate inconsistency`, 'warning', 'Limit to 2-3 font families for visual consistency')
    });
  }

  // Error prevention: form validation
  const forms = $('form');
  const formsWithoutValidation = [];
  forms.each((_, form) => {
    const inputs = $(form).find('input[type="text"], input[type="email"], input[type="tel"], input[type="number"]');
    const hasRequired = $(form).find('[required], [aria-required]').length > 0;
    const hasPattern = $(form).find('[pattern]').length > 0;
    if (inputs.length > 0 && !hasRequired && !hasPattern) {
      formsWithoutValidation.push(true);
    }
  });
  if (formsWithoutValidation.length > 0) {
    findings.push({
      heuristic: 'errorPrevention',
      ...finding(`${formsWithoutValidation.length} form(s) found without validation attributes`, 'warning', 'Add required, pattern, and type attributes to form inputs')
    });
  }

  // Recognition: labels, placeholders
  const inputsWithoutLabels = $('input:not([type="hidden"]):not([type="submit"]):not([type="button"])').filter((_, el) => {
    const id = $(el).attr('id');
    const hasLabel = id && $(`label[for="${id}"]`).length > 0;
    const hasAriaLabel = $(el).attr('aria-label') || $(el).attr('aria-labelledby');
    const hasPlaceholder = $(el).attr('placeholder');
    return !hasLabel && !hasAriaLabel && !hasPlaceholder;
  }).length;

  if (inputsWithoutLabels > 0) {
    findings.push({
      heuristic: 'recognition',
      ...finding(`${inputsWithoutLabels} input(s) without labels, aria-labels, or placeholders`, 'critical', 'Add descriptive labels to all form inputs')
    });
  }

  // Flexibility: search, keyboard shortcuts
  const hasSearch = $('input[type="search"], [role="search"], input[placeholder*="search" i], .search').length > 0;
  if (!hasSearch) {
    findings.push({
      heuristic: 'flexibility',
      ...finding('No search functionality detected', 'warning', 'Consider adding site search for efficient navigation')
    });
  }

  // Aesthetic: content density analysis
  const textLength = (pageMetrics.bodyText || '').length;
  const linkCount = $('a').length;
  if (linkCount > 100) {
    findings.push({
      heuristic: 'aesthetic',
      ...finding(`High link density (${linkCount} links) — may overwhelm users`, 'warning', 'Reduce visible links; consider progressive disclosure')
    });
  }

  // Error recovery: custom error page signals
  const has404Content = html.includes('404') && html.includes('not found');
  // This is just a signal check — not definitive

  // Help: FAQ, help links, documentation
  const hasHelpLinks = $('a[href*="help"], a[href*="faq"], a[href*="support"], a[href*="docs"], a:contains("Help"), a:contains("FAQ")').length > 0;
  if (!hasHelpLinks) {
    findings.push({
      heuristic: 'help',
      ...finding('No help, FAQ, or documentation links detected', 'warning', 'Add accessible help/support links for users')
    });
  }

  return findings;
}

async function analyzeWithClaude(pageData) {
  const client = new Anthropic();
  const { $, pageMetrics, url } = pageData;

  // Build a concise page summary for the AI
  const title = $('title').text();
  const headings = [];
  $('h1, h2, h3').each((_, el) => headings.push($(el).text().trim()));
  const navItems = [];
  $('nav a, header a').each((_, el) => navItems.push($(el).text().trim()));
  const ctaButtons = [];
  $('a.btn, a.button, button, [role="button"], a.cta, .cta a').each((_, el) => ctaButtons.push($(el).text().trim()));
  const forms = $('form').length;
  const images = $('img').length;
  const imagesWithAlt = $('img[alt]').filter((_, el) => $(el).attr('alt').trim().length > 0).length;

  const pageSummary = `
URL: ${url}
Title: ${title}
Language: ${pageMetrics.lang || 'not set'}
Headings: ${headings.slice(0, 20).join(' | ')}
Navigation items: ${navItems.slice(0, 20).join(' | ')}
CTA/Buttons: ${ctaButtons.slice(0, 15).join(' | ')}
Forms: ${forms}
Images: ${images} (${imagesWithAlt} with alt text)
Font families: ${(pageMetrics.fonts || []).slice(0, 8).join(', ')}
Body text preview: ${(pageMetrics.bodyText || '').substring(0, 2000)}
  `.trim();

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: `You are a UX expert evaluating a website against Nielsen's 10 usability heuristics. Based on the following page data, identify 5-10 specific issues.

${pageSummary}

Respond ONLY with a JSON array. Each item must have:
- "heuristic": one of [visibility, match, control, consistency, errorPrevention, recognition, flexibility, aesthetic, errorRecovery, help]
- "message": specific issue found (1 sentence)
- "severity": "critical", "warning", or "good"
- "recommendation": actionable fix (1 sentence)

Focus on the most impactful findings. Return valid JSON only, no markdown.`
    }]
  });

  try {
    const text = response.content[0].text.trim();
    const json = JSON.parse(text);
    return json.map(item => ({
      heuristic: item.heuristic,
      message: item.message,
      severity: item.severity,
      recommendation: item.recommendation
    }));
  } catch {
    return [];
  }
}

module.exports = { runHeuristicsAudit };
