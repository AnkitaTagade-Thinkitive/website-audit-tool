const https = require('https');
const { finding } = require('../utils');

async function runPerformanceAudit(pageData) {
  const { url, loadTime, performanceTiming, resources } = pageData;
  const results = {
    id: 'performance',
    name: 'Performance Audit',
    score: 0,
    maxScore: 10,
    findings: [],
    metrics: {}
  };

  let score = 10;

  // Direct timing metrics
  results.metrics.loadTime = loadTime;
  results.metrics.timing = performanceTiming;

  if (loadTime < 1500) {
    results.findings.push(finding(`Page load time: ${loadTime}ms — excellent`, 'good'));
  } else if (loadTime < 3000) {
    results.findings.push(finding(`Page load time: ${loadTime}ms — needs improvement`, 'warning', 'Optimize assets to achieve sub-1.5s load time (Google recommends <2.5s)'));
    score -= 1.5;
  } else {
    results.findings.push(finding(`Page load time: ${loadTime}ms — critically slow`, 'critical', 'Significant performance optimization needed — target under 2.5s'));
    score -= 3;
  }

  if (performanceTiming) {
    if (performanceTiming.ttfb > 600) {
      results.findings.push(finding(`TTFB: ${Math.round(performanceTiming.ttfb)}ms — slow server response`, 'critical', 'Optimize server response time (CDN, caching, server performance)'));
      score -= 1.5;
    } else if (performanceTiming.ttfb > 200) {
      results.findings.push(finding(`TTFB: ${Math.round(performanceTiming.ttfb)}ms — acceptable`, 'warning', 'Consider CDN or server-side caching'));
      score -= 0.5;
    } else {
      results.findings.push(finding(`TTFB: ${Math.round(performanceTiming.ttfb)}ms — fast`, 'good'));
    }
  }

  // Resource analysis
  const imgCount = resources.images.length;
  const jsCount = resources.scripts.length;
  const cssCount = resources.stylesheets.length;
  const totalResources = imgCount + jsCount + cssCount;

  results.metrics.resources = { images: imgCount, scripts: jsCount, stylesheets: cssCount, total: totalResources };

  if (totalResources > 60) {
    results.findings.push(finding(`High resource count: ${totalResources} requests (${imgCount} images, ${jsCount} JS, ${cssCount} CSS)`, 'critical', 'Reduce HTTP requests via bundling, sprites, and lazy loading — target under 50'));
    score -= 2.5;
  } else if (totalResources > 30) {
    results.findings.push(finding(`${totalResources} resource requests (${imgCount} images, ${jsCount} JS, ${cssCount} CSS)`, 'warning', 'Reduce asset count — top-performing sites use under 30 requests'));
    score -= 1.5;
  } else {
    results.findings.push(finding(`${totalResources} resource requests — efficient`, 'good'));
  }

  // Large images
  const largeImages = resources.images.filter(i => i.size > 200000);
  if (largeImages.length > 0) {
    const totalSize = largeImages.reduce((s, i) => s + i.size, 0);
    results.findings.push(finding(`${largeImages.length} images over 200KB (total: ${Math.round(totalSize / 1024)}KB)`, 'warning', 'Compress and convert images to WebP/AVIF'));
    score -= 1;
  }

  // Lazy loading check
  const { $ } = pageData;
  const lazyImages = $('img[loading="lazy"], img[data-src], img[data-lazy]').length;
  const totalImages = $('img').length;
  if (totalImages > 5 && lazyImages === 0) {
    results.findings.push(finding('No lazy loading detected on images', 'warning', 'Add loading="lazy" to below-the-fold images'));
    score -= 1;
  } else if (lazyImages > 0) {
    results.findings.push(finding(`${lazyImages}/${totalImages} images use lazy loading`, 'good'));
  }

  // Large JS bundles
  const largeScripts = resources.scripts.filter(s => s.size > 300000);
  if (largeScripts.length > 0) {
    results.findings.push(finding(`${largeScripts.length} JavaScript bundles over 300KB`, 'warning', 'Code-split and tree-shake JavaScript bundles'));
    score -= 1;
  }

  // PageSpeed Insights (optional)
  if (process.env.PAGESPEED_API_KEY) {
    try {
      const psi = await fetchPageSpeedInsights(url);
      if (psi) {
        results.metrics.pageSpeed = psi;

        const perfScore = Math.round((psi.performanceScore || 0) * 100);
        results.findings.push(finding(
          `PageSpeed Performance Score: ${perfScore}/100`,
          perfScore >= 90 ? 'good' : perfScore >= 50 ? 'warning' : 'critical',
          perfScore < 90 ? 'Follow PageSpeed recommendations to improve score' : ''
        ));

        if (psi.lcp) {
          const lcpSev = psi.lcp < 2500 ? 'good' : psi.lcp < 4000 ? 'warning' : 'critical';
          results.findings.push(finding(`LCP (Largest Contentful Paint): ${Math.round(psi.lcp)}ms`, lcpSev, lcpSev !== 'good' ? 'Optimize LCP — target under 2.5s' : ''));
        }
        if (psi.cls !== undefined) {
          const clsSev = psi.cls < 0.1 ? 'good' : psi.cls < 0.25 ? 'warning' : 'critical';
          results.findings.push(finding(`CLS (Cumulative Layout Shift): ${psi.cls.toFixed(3)}`, clsSev, clsSev !== 'good' ? 'Reduce layout shifts — set dimensions on media' : ''));
        }
        if (psi.fid) {
          const fidSev = psi.fid < 100 ? 'good' : psi.fid < 300 ? 'warning' : 'critical';
          results.findings.push(finding(`FID (First Input Delay): ${Math.round(psi.fid)}ms`, fidSev, fidSev !== 'good' ? 'Reduce JavaScript main-thread blocking time' : ''));
        }

        // Factor PSI score
        if (perfScore < 50) score -= 2;
        else if (perfScore < 80) score -= 1;
      }
    } catch (err) {
      results.findings.push(finding(`PageSpeed API error: ${err.message}`, 'warning', 'Check PAGESPEED_API_KEY'));
    }
  } else {
    results.findings.push(finding('PageSpeed Insights not available (no API key)', 'warning', 'Add PAGESPEED_API_KEY to .env for Core Web Vitals data'));
  }

  results.score = Math.max(0, Math.round(score * 10) / 10);
  return results;
}

function fetchPageSpeedInsights(url) {
  return new Promise((resolve, reject) => {
    const apiUrl = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}&key=${process.env.PAGESPEED_API_KEY}&category=performance`;
    https.get(apiUrl, { timeout: 60000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(json.error.message));
          const audit = json.lighthouseResult;
          if (!audit) return resolve(null);

          resolve({
            performanceScore: audit.categories?.performance?.score,
            lcp: audit.audits?.['largest-contentful-paint']?.numericValue,
            fid: audit.audits?.['max-potential-fid']?.numericValue,
            cls: audit.audits?.['cumulative-layout-shift']?.numericValue,
            fcp: audit.audits?.['first-contentful-paint']?.numericValue,
            si: audit.audits?.['speed-index']?.numericValue,
            tbt: audit.audits?.['total-blocking-time']?.numericValue
          });
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

module.exports = { runPerformanceAudit };
