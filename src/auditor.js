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

// Modules that take element screenshots must run serially — they all share
// the same Puppeteer page's scroll position. Concurrent scrollIntoView calls
// race each other and yield wrong-element screenshots.
const SERIAL_MODULES = [
  { id: 'ux', name: 'UX Audit', fn: (pd, ld) => runUxAudit(pd) },
  { id: 'ui', name: 'UI / Visual Design Audit', fn: (pd, ld) => runUiAudit(pd) },
  { id: 'cro', name: 'CRO Audit', fn: (pd, ld) => runCroAudit(pd) }
];

// Modules that read pageData/linkData only — no page mutation, no shared resources.
// Safe to run concurrently. The 5 of them finish in roughly max(slowest) instead
// of sum(all). Performance is included here because its HTTPS call to PageSpeed
// Insights (when keyed) is the slowest single thing in the audit; running it in
// parallel with the others hides its latency entirely.
const PARALLEL_MODULES = [
  { id: 'performance', name: 'Performance Audit', fn: (pd, ld) => runPerformanceAudit(pd) },
  { id: 'seo', name: 'SEO Audit', fn: (pd, ld) => runSeoAudit(pd, ld) },
  { id: 'content', name: 'Content Audit', fn: (pd, ld) => runContentAudit(pd) },
  { id: 'technical', name: 'Technical Audit', fn: (pd, ld) => runTechnicalAudit(pd, ld) },
  { id: 'security', name: 'Security Audit', fn: (pd, ld) => runSecurityAudit(pd) }
];

// The canonical order shown to users — unchanged from the pre-parallelization
// version, so the report's score strip and section ordering remain identical.
const MODULE_ORDER = ['ux', 'ui', 'performance', 'seo', 'content', 'technical', 'cro', 'security'];
const MODULES = [...SERIAL_MODULES, ...PARALLEL_MODULES];

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
  const auditT0 = Date.now();
  try {
    // Step 1: Scrape page — page stays open for element screenshots
    progress(`Fetching and analyzing ${url}...`);
    pageData = await scrapePage(url);

    // Step 2: Crawl links
    progress('Crawling links and checking status codes...');
    const linkData = await crawlLinks(url, pageData.$, 1);

    // Step 3: Run audit modules. SERIAL_MODULES (ux/ui/cro) share the Puppeteer
    // page's scroll state for element screenshots — they must run one at a time.
    // PARALLEL_MODULES only read pageData/linkData — safe to run concurrently.
    // We run both groups concurrently. Total module time =
    //   max( sum(SERIAL), max(PARALLEL) )
    // instead of sum(everything).
    const completedById = new Map();

    const runOne = async (mod) => {
      const t0 = Date.now();
      progress(`Running ${mod.name}...`);
      let result;
      try {
        result = await mod.fn(pageData, linkData);
      } catch (err) {
        result = {
          id: mod.id,
          name: mod.name,
          score: 0,
          maxScore: 10,
          findings: [{ message: `Module error: ${err.message}`, severity: 'critical', recommendation: 'Check error logs' }]
        };
      }
      const dur = Date.now() - t0;
      console.log(`[module:${mod.id}] dur=${dur}ms score=${result.score}/${result.maxScore} findings=${result.findings.length}`);
      completedById.set(mod.id, result);
      emit({
        type: 'module_complete',
        module: result.id,
        name: result.name,
        score: result.score,
        maxScore: result.maxScore,
        findingCount: result.findings.length
      });
      return result;
    };

    const serialChain = (async () => {
      for (const mod of SERIAL_MODULES) await runOne(mod);
    })();
    const parallelGroup = Promise.all(PARALLEL_MODULES.map(runOne));

    await Promise.all([serialChain, parallelGroup]);

    // Preserve the pre-parallelization order in the result so the report's
    // score strip and section ordering remain identical for users.
    const modules = MODULE_ORDER.map(id => completedById.get(id)).filter(Boolean);

    // Close the Puppeteer page now that all screenshots are done
    await closePage(pageData);
    console.log(`[audit] total=${Date.now() - auditT0}ms modules=${modules.length} url=${url}`);

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
