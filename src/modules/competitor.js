const { scrapePage, crawlLinks, closePage } = require('../scraper');
const { runPerformanceAudit } = require('./performance');
const { runSeoAudit } = require('./seo');
const { runSecurityAudit } = require('./security');
const { finding } = require('../utils');

async function runCompetitorAudit(mainResult, competitorUrls, onProgress) {
  const results = {
    id: 'competitor',
    name: 'Competitor Benchmarking',
    score: 0,
    maxScore: 10,
    findings: [],
    comparison: []
  };

  if (!competitorUrls || competitorUrls.length === 0) {
    results.findings.push(finding('No competitor URLs provided', 'good', 'Add competitor URLs for side-by-side comparison'));
    results.score = 5;
    return results;
  }

  const competitors = [];
  for (const compUrl of competitorUrls.slice(0, 2)) {
    const normalizedUrl = compUrl.startsWith('http') ? compUrl : `https://${compUrl}`;
    if (onProgress) onProgress({ type: 'progress', module: 'competitor', message: `Auditing competitor: ${normalizedUrl}` });

    let pageData;
    try {
      pageData = await scrapePage(normalizedUrl);
      const linkData = await crawlLinks(normalizedUrl, pageData.$, 1);

      const [perfResult, seoResult, secResult] = await Promise.all([
        runPerformanceAudit(pageData),
        runSeoAudit(pageData, linkData),
        runSecurityAudit(pageData)
      ]);

      competitors.push({
        url: normalizedUrl,
        performance: perfResult,
        seo: seoResult,
        security: secResult,
        loadTime: pageData.loadTime,
        title: pageData.pageMetrics.title
      });
    } catch (err) {
      results.findings.push(finding(`Could not audit competitor ${normalizedUrl}: ${err.message}`, 'warning'));
    } finally {
      // Always close the Puppeteer page — previously this leaked on every competitor.
      if (pageData) await closePage(pageData).catch(() => {});
    }
  }

  // Build comparison table
  const mainPerf = mainResult.modules.find(m => m.id === 'performance');
  const mainSeo = mainResult.modules.find(m => m.id === 'seo');
  const mainSec = mainResult.modules.find(m => m.id === 'security');

  const comparison = [{
    url: mainResult.url,
    isMain: true,
    loadTime: mainResult.loadTime,
    performanceScore: mainPerf?.score || 0,
    seoScore: mainSeo?.score || 0,
    securityScore: mainSec?.score || 0,
    overallScore: mainResult.overallScore
  }];

  for (const comp of competitors) {
    const compOverall = Math.round(((comp.performance.score + comp.seo.score + comp.security.score) / 30) * 100);
    comparison.push({
      url: comp.url,
      isMain: false,
      loadTime: comp.loadTime,
      performanceScore: comp.performance.score,
      seoScore: comp.seo.score,
      securityScore: comp.security.score,
      overallScore: compOverall
    });
  }

  results.comparison = comparison;

  // Generate findings based on comparison
  for (const comp of competitors) {
    if (mainPerf && comp.performance.score > mainPerf.score) {
      results.findings.push(finding(
        `${comp.url} outperforms on performance (${comp.performance.score}/10 vs your ${mainPerf.score}/10)`,
        'warning',
        'Investigate competitor performance optimizations'
      ));
    }
    if (mainSeo && comp.seo.score > mainSeo.score) {
      results.findings.push(finding(
        `${comp.url} has better SEO (${comp.seo.score}/10 vs your ${mainSeo.score}/10)`,
        'warning',
        'Review competitor SEO strategies'
      ));
    }
    if (comp.loadTime < (mainResult.loadTime || 9999)) {
      results.findings.push(finding(
        `${comp.url} loads faster (${comp.loadTime}ms vs your ${mainResult.loadTime}ms)`,
        'warning',
        'Optimize page load speed to match or exceed competitor'
      ));
    }
  }

  if (results.findings.length === 0) {
    results.findings.push(finding('Your site outperforms analyzed competitors', 'good'));
  }

  // Score based on how you compare
  let wins = 0;
  let total = 0;
  for (const comp of comparison.filter(c => !c.isMain)) {
    total += 3;
    if (comparison[0].performanceScore >= comp.performanceScore) wins++;
    if (comparison[0].seoScore >= comp.seoScore) wins++;
    if (comparison[0].securityScore >= comp.securityScore) wins++;
  }

  results.score = total > 0 ? Math.round((wins / total) * 10 * 10) / 10 : 5;

  return results;
}

module.exports = { runCompetitorAudit };
