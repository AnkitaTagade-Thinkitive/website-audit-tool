const { finding } = require('../utils');
const { screenshotElement, screenshotElements, screenshotAboveFold } = require('../scraper');

async function runCroAudit(pageData) {
  const { $, pageMetrics, page } = pageData;
  const results = {
    id: 'cro',
    name: 'CRO (Conversion Rate Optimization) Audit',
    score: 0,
    maxScore: 10,
    findings: []
  };

  let score = 10;

  // CTA buttons count — screenshot the above-fold if none found
  const ctaSelectors = 'a.btn, a.button, button:not([type="reset"]):not([type="button"]), .cta, [class*="cta"], a[class*="btn"], a[class*="button"]';
  const allCtas = [];
  $(ctaSelectors).each((_, el) => {
    const text = $(el).text().trim();
    if (text.length > 0 && text.length < 100) {
      allCtas.push({ text, tag: el.tagName });
    }
  });

  if (allCtas.length === 0) {
    const f = finding('No CTA buttons detected on page', 'critical', 'Add clear call-to-action buttons');
    if (page) f.screenshot = await screenshotAboveFold(page);
    results.findings.push(f);
    score -= 3;
  } else {
    results.findings.push(finding(`${allCtas.length} CTA elements found`, allCtas.length >= 2 ? 'good' : 'warning',
      allCtas.length < 2 ? 'Consider adding a secondary CTA for users not ready for primary action' : ''));
    if (allCtas.length < 2) score -= 0.5;
  }

  // CTA text quality (no screenshot — text analysis)
  const ctaTexts = allCtas.map(c => c.text.toLowerCase());
  const strongCTAWords = ['free', 'start', 'get', 'try', 'now', 'today', 'instant', 'save', 'discount', 'offer', 'demo', 'trial'];
  const weakCTAWords = ['submit', 'click here', 'more', 'continue', 'next'];

  const hasStrongCTA = ctaTexts.some(t => strongCTAWords.some(w => t.includes(w)));
  const hasWeakCTA = ctaTexts.some(t => weakCTAWords.some(w => t.includes(w)));

  if (hasStrongCTA) {
    results.findings.push(finding('CTAs use compelling, action-oriented language', 'good'));
  }
  if (hasWeakCTA) {
    const f = finding('Some CTAs use weak/generic text', 'warning', 'Replace generic labels with value-driven text (e.g., "Get Your Free Report")');
    if (page) {
      const shots = await screenshotElements(page, ctaSelectors, 2);
      if (shots.length > 0) f.screenshot = shots[0].base64;
    }
    results.findings.push(f);
    score -= 0.5;
  }

  // Forms — screenshot forms with too many fields
  const forms = $('form');
  const formCount = forms.length;

  if (formCount === 0) {
    results.findings.push(finding('No forms detected — may lack lead capture', 'warning', 'Consider adding a lead capture or contact form'));
    score -= 1;
  } else {
    results.findings.push(finding(`${formCount} form(s) found`, 'good'));

    forms.each((i, form) => {
      const fields = $(form).find('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), select, textarea');
      const fieldCount = fields.length;
      if (fieldCount > 7) {
        const f = finding(`Form ${i + 1} has ${fieldCount} fields — may discourage completion`, 'warning', 'Reduce form fields to 3-5 essential fields');
        // Screenshot this specific form
        (async () => {
          if (page) {
            const formEls = await page.$$('form');
            if (formEls[i]) {
              try {
                await formEls[i].scrollIntoView();
                await new Promise(r => setTimeout(r, 200));
                const ss = await formEls[i].screenshot({ type: 'jpeg', quality: 60 });
                f.screenshot = Buffer.from(ss).toString('base64');
              } catch {}
            }
          }
        })();
        results.findings.push(f);
        score -= 1;
      } else if (fieldCount > 0) {
        results.findings.push(finding(`Form ${i + 1} has ${fieldCount} fields — good length`, 'good'));
      }
    });

    // Wait for async form screenshots
    await new Promise(r => setTimeout(r, 500));
  }

  // Trust signals (no screenshot — keyword search)
  const trustKeywords = ['testimonial', 'review', 'rating', 'star', 'trust', 'badge', 'certified', 'certification', 'award', 'partner', 'client', 'guarantee', 'money-back', 'secure', 'privacy', 'ssl'];
  const pageText = (pageMetrics.bodyText || '').toLowerCase();
  const html = $.html().toLowerCase();

  const foundTrustSignals = trustKeywords.filter(k => pageText.includes(k) || html.includes(k));

  if (foundTrustSignals.length >= 3) {
    results.findings.push(finding(`Strong trust signals found: ${foundTrustSignals.join(', ')}`, 'good'));
  } else if (foundTrustSignals.length > 0) {
    results.findings.push(finding(`Limited trust signals: ${foundTrustSignals.join(', ')}`, 'warning', 'Add testimonials, reviews, certifications, and security badges'));
    score -= 1;
  } else {
    results.findings.push(finding('No trust signals detected (testimonials, reviews, badges)', 'critical', 'Add social proof: testimonials, reviews, partner logos, certifications'));
    score -= 2;
  }

  // Social proof elements — screenshot if found
  const socialProof = $('[class*="testimonial"], [class*="review"], [class*="rating"], [class*="social-proof"], blockquote').length;
  if (socialProof > 0) {
    const f = finding(`${socialProof} social proof element(s) found`, 'good');
    if (page) {
      const ss = await screenshotElement(page, '[class*="testimonial"], [class*="review"], [class*="rating"], blockquote');
      if (ss) f.screenshot = ss;
    }
    results.findings.push(f);
  }

  // Funnel clarity — screenshot above-fold to show value prop + CTA
  const h1Text = $('h1').first().text().trim().toLowerCase();
  const hasValueProp = h1Text.length > 10;
  const hasPrimaryAction = allCtas.length > 0;

  if (hasValueProp && hasPrimaryAction) {
    const f = finding('Page has a clear value proposition (H1) with CTA', 'good');
    if (page) f.screenshot = await screenshotAboveFold(page);
    results.findings.push(f);
  } else if (!hasValueProp) {
    const f = finding('H1 may not communicate a clear value proposition', 'warning', 'Write an H1 that clearly states the benefit to visitors');
    if (page) f.screenshot = await screenshotElement(page, 'h1') || await screenshotAboveFold(page);
    results.findings.push(f);
    score -= 1;
  }

  // Above-the-fold CTA check (no extra screenshot — already captured above)
  const allText = pageMetrics.bodyText || '';
  const firstSection = allText.substring(0, Math.min(500, allText.length / 5));
  const hasEarlyAction = strongCTAWords.some(w => firstSection.toLowerCase().includes(w));
  if (!hasEarlyAction && allCtas.length > 0) {
    results.findings.push(finding('Primary CTA may not be visible above the fold', 'warning', 'Place the main CTA prominently in the first viewport'));
    score -= 0.5;
  }

  // Urgency/scarcity signals (no screenshot — keyword search)
  const urgencyWords = ['limited', 'hurry', 'ending soon', 'last chance', 'only', 'remaining', 'countdown', 'expires'];
  const hasUrgency = urgencyWords.some(w => pageText.includes(w));
  if (hasUrgency) {
    results.findings.push(finding('Urgency/scarcity signals detected', 'good'));
  }

  results.score = Math.max(0, Math.round(score * 10) / 10);
  return results;
}

module.exports = { runCroAudit };
