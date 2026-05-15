const { scrapePage, crawlLinks, closePage } = require('./scraper');
const { overallScore } = require('./utils');

const { runUxAudit } = require('./modules/ux');
const { runUiAudit } = require('./modules/ui');
const { runPerformanceAudit } = require('./modules/performance');
const { runSeoAudit } = require('./modules/seo');
const { runContentAudit } = require('./modules/content');
const { runTechnicalAudit } = require('./modules/technical');
const { runCroAudit } = require('./modules/cro');
const { runSecurityAudit } = require('./modules/security');
const { runCompetitorAudit } = require('./modules/competitor');

const MODULES = [
  { id: 'ux', name: 'UX Audit', fn: (pd, ld) => runUxAudit(pd) },
  { id: 'ui', name: 'UI / Visual Design Audit', fn: (pd, ld) => runUiAudit(pd) },
  { id: 'performance', name: 'Performance Audit', fn: (pd, ld) => runPerformanceAudit(pd) },
  { id: 'seo', name: 'SEO Audit', fn: (pd, ld) => runSeoAudit(pd, ld) },
  { id: 'content', name: 'Content Audit', fn: (pd, ld) => runContentAudit(pd) },
  { id: 'technical', name: 'Technical Audit', fn: (pd, ld) => runTechnicalAudit(pd, ld) },
  { id: 'cro', name: 'CRO Audit', fn: (pd, ld) => runCroAudit(pd) },
  { id: 'security', name: 'Security Audit', fn: (pd, ld) => runSecurityAudit(pd) }
];

async function runAudit(url, competitors, onProgress) {
  const emit = (data) => {
    if (onProgress) onProgress(data);
  };

  const totalSteps = MODULES.length + 2 + (competitors.length > 0 ? 1 : 0);
  let currentStep = 0;

  const progress = (message) => {
    currentStep++;
    emit({ type: 'progress', step: currentStep, total: totalSteps, message });
  };

  let pageData;
  try {
    // Step 1: Scrape page — page stays open for element screenshots
    progress(`Fetching and analyzing ${url}...`);
    pageData = await scrapePage(url);

    // Step 2: Crawl links
    progress('Crawling links and checking status codes...');
    const linkData = await crawlLinks(url, pageData.$, 1);

    // Step 3+: Run audit modules (page is still open for screenshots)
    const modules = [];
    for (const mod of MODULES) {
      progress(`Running ${mod.name}...`);
      try {
        const result = await mod.fn(pageData, linkData);
        modules.push(result);
        emit({
          type: 'module_complete',
          module: result.id,
          name: result.name,
          score: result.score,
          maxScore: result.maxScore,
          findingCount: result.findings.length
        });
      } catch (err) {
        modules.push({
          id: mod.id,
          name: mod.name,
          score: 0,
          maxScore: 10,
          findings: [{ message: `Module error: ${err.message}`, severity: 'critical', recommendation: 'Check error logs' }]
        });
      }
    }

    // Close the Puppeteer page now that all screenshots are done
    await closePage(pageData);

    // Build result
    const result = {
      url,
      date: new Date().toISOString(),
      loadTime: pageData.loadTime,
      overallScore: overallScore(modules),
      fullPageScreenshot: pageData.fullPageScreenshot,
      modules,
      executiveSummary: buildExecutiveSummary(modules)
    };

    // Competitor benchmarking
    if (competitors.length > 0) {
      progress('Running competitor benchmarking...');
      const compResult = await runCompetitorAudit(result, competitors, onProgress);
      result.modules.push(compResult);
      result.competitor = compResult;
    }

    return result;

  } catch (err) {
    if (pageData) await closePage(pageData).catch(() => {});
    throw err;
  }
}

function buildExecutiveSummary(modules) {
  const allFindings = [];
  for (const mod of modules) {
    for (const f of mod.findings) {
      allFindings.push({ ...f, module: mod.name, moduleId: mod.id });
    }
  }

  const criticals = allFindings.filter(f => f.severity === 'critical');
  const warnings = allFindings.filter(f => f.severity === 'warning');

  const priorityFixes = [
    ...criticals.slice(0, 5),
    ...warnings.slice(0, Math.max(0, 5 - criticals.length))
  ].slice(0, 5);

  const strengths = allFindings
    .filter(f => f.severity === 'good')
    .slice(0, 5);

  return {
    totalFindings: allFindings.length,
    criticalCount: criticals.length,
    warningCount: warnings.length,
    goodCount: allFindings.filter(f => f.severity === 'good').length,
    priorityFixes,
    strengths
  };
}

module.exports = { runAudit };
