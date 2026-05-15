// PDF export uses browser print dialog (Print → Save as PDF)

function scoreColor(score, max) {
  const pct = score / max;
  if (pct >= 0.8) return '#16a34a';
  if (pct >= 0.5) return '#d97706';
  return '#dc2626';
}

function scoreGrade(score, max) {
  const pct = (score / max) * 100;
  if (pct >= 90) return 'A';
  if (pct >= 80) return 'B';
  if (pct >= 65) return 'C';
  if (pct >= 50) return 'D';
  return 'F';
}

function generateHTML(report, options = {}) {
  const date = new Date(report.date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const summary = report.executiveSummary;
  const gradeColor = scoreColor(report.overallScore, 100);

  // ── Score Cards Strip ──
  const moduleCards = report.modules.map(mod => {
    const color = scoreColor(mod.score, mod.maxScore);
    const g = scoreGrade(mod.score, mod.maxScore);
    const critCount = (mod.findings || []).filter(f => f.severity === 'critical').length;
    const warnCount = (mod.findings || []).filter(f => f.severity === 'warning').length;
    return `
      <a href="#module-${mod.id}" class="score-card">
        <div class="score-card-grade" style="color:${color}">${g}</div>
        <div class="score-card-name">${escapeHtml(mod.name.replace(' Audit', '').replace('UI / Visual Design', 'UI Design').replace('CRO (Conversion Rate Optimization)', 'CRO'))}</div>
        <div class="score-card-num" style="color:${color}">${mod.score}/${mod.maxScore}</div>
        ${critCount > 0 ? `<div class="score-card-issues"><span class="dot-critical"></span>${critCount}</div>` : ''}
        ${warnCount > 0 && critCount === 0 ? `<div class="score-card-issues"><span class="dot-warning"></span>${warnCount}</div>` : ''}
        ${critCount === 0 && warnCount === 0 ? `<div class="score-card-issues"><span class="dot-good"></span>OK</div>` : ''}
      </a>`;
  }).join('');

  // ── Module Sections ──
  let moduleSections = '';
  for (const mod of report.modules) {
    const findings = mod.findings || [];
    const criticals = findings.filter(f => f.severity === 'critical');
    const warnings = findings.filter(f => f.severity === 'warning');
    const goods = findings.filter(f => f.severity === 'good');
    const color = scoreColor(mod.score, mod.maxScore);
    const g = scoreGrade(mod.score, mod.maxScore);

    const renderFindingGroup = (items, groupLabel, groupClass) => {
      if (items.length === 0) return '';
      return `
        <div class="finding-group ${groupClass}">
          <div class="finding-group-header">${groupLabel} <span class="finding-count">${items.length}</span></div>
          ${items.map(f => `
            <div class="finding-row">
              ${f.screenshot ? `<div class="finding-ss"><img src="data:image/jpeg;base64,${f.screenshot}" alt="Screenshot evidence" loading="lazy"></div>` : ''}
              <div class="finding-msg">${escapeHtml(f.message)}</div>
              ${f.recommendation ? `<div class="finding-rec">${escapeHtml(f.recommendation)}</div>` : ''}
            </div>
          `).join('')}
        </div>
      `;
    };

    // Competitor comparison table
    let comparisonTable = '';
    if (mod.comparison && mod.comparison.length > 0) {
      comparisonTable = `
        <table class="comparison-table">
          <thead><tr><th>Site</th><th>Load Time</th><th>Performance</th><th>SEO</th><th>Security</th><th>Score</th></tr></thead>
          <tbody>
            ${mod.comparison.map(c => `
              <tr class="${c.isMain ? 'main-row' : ''}">
                <td class="comp-url">${escapeHtml(new URL(c.url).hostname)}${c.isMain ? ' <em>(yours)</em>' : ''}</td>
                <td>${c.loadTime}ms</td>
                <td style="color:${scoreColor(c.performanceScore, 10)};font-weight:600">${c.performanceScore}</td>
                <td style="color:${scoreColor(c.seoScore, 10)};font-weight:600">${c.seoScore}</td>
                <td style="color:${scoreColor(c.securityScore, 10)};font-weight:600">${c.securityScore}</td>
                <td><strong>${c.overallScore}</strong>/100</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
    }

    moduleSections += `
      <div class="module-section" id="module-${mod.id}">
        <div class="module-header" onclick="this.parentElement.classList.toggle('collapsed')">
          <div class="module-left">
            <div class="module-grade" style="background:${color}">${g}</div>
            <div class="module-info">
              <h2>${escapeHtml(mod.name)}</h2>
              <div class="module-meta">
                <span style="color:${color};font-weight:700">${mod.score}/${mod.maxScore}</span>
                <span class="meta-sep">·</span>
                <span>${criticals.length} critical</span>
                <span class="meta-sep">·</span>
                <span>${warnings.length} warnings</span>
                <span class="meta-sep">·</span>
                <span>${goods.length} passed</span>
              </div>
            </div>
          </div>
          <svg class="chevron" width="20" height="20" viewBox="0 0 20 20"><path d="M6 8l4 4 4-4" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>
        </div>
        <div class="module-body">
          ${comparisonTable}
          ${renderFindingGroup(criticals, 'Critical Issues', 'group-critical')}
          ${renderFindingGroup(warnings, 'Warnings', 'group-warning')}
          ${renderFindingGroup(goods, 'Passed Checks', 'group-good')}
        </div>
      </div>
    `;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Audit Report — ${escapeHtml(report.url)}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; background: #f1f5f9; color: #1e293b; line-height: 1.5; -webkit-font-smoothing: antialiased; padding: 56px 0 0; }
  .report { max-width: 880px; margin: 0 auto; padding: 0 16px 48px; }

  /* ── HERO HEADER (reference style) ── */
  .report-header { background: linear-gradient(135deg, #0f172a 0%, #1e3a5f 100%); color: #fff; padding: 36px 36px 28px; border-radius: 20px; margin-bottom: 24px; }
  .report-header h1 { font-size: 26px; font-weight: 800; margin-bottom: 2px; }
  .report-header .hdr-url { font-size: 15px; color: #38bdf8; font-weight: 600; margin-bottom: 6px; word-break: break-all; }
  .report-header .hdr-desc { font-size: 13px; opacity: 0.65; margin-bottom: 20px; }
  .hdr-stats { display: flex; align-items: center; gap: 20px; flex-wrap: wrap; }
  .hdr-score-ring { width: 72px; height: 72px; border-radius: 50%; border: 4px solid ${gradeColor}; display: flex; align-items: center; justify-content: center; flex-direction: column; flex-shrink: 0; }
  .hdr-score-ring .sv { font-size: 24px; font-weight: 800; line-height: 1; color: ${gradeColor}; }
  .hdr-score-ring .sl { font-size: 9px; opacity: 0.6; }
  .hdr-chips { display: flex; gap: 8px; flex-wrap: wrap; }
  .hdr-chip { padding: 6px 14px; border-radius: 8px; font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 6px; }
  .hdr-chip .cn { font-size: 20px; font-weight: 800; }
  .chip-issues { background: rgba(255,255,255,0.1); }
  .chip-crit { background: rgba(220,38,38,0.15); color: #fca5a5; }
  .chip-warn { background: rgba(217,119,6,0.15); color: #fde68a; }
  .chip-good { background: rgba(22,163,74,0.15); color: #bbf7d0; }

  /* ── Score Cards Strip ── */
  .score-strip { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 24px; }
  .score-card { background: #fff; border-radius: 10px; padding: 14px 10px 10px; text-align: center; text-decoration: none; color: inherit; transition: box-shadow 0.15s; border: 1px solid #e2e8f0; }
  .score-card:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.08); }
  .score-card-grade { font-size: 24px; font-weight: 800; line-height: 1; }
  .score-card-name { font-size: 11px; font-weight: 500; color: #64748b; margin: 4px 0 6px; line-height: 1.3; }
  .score-card-num { font-size: 12px; font-weight: 700; }
  .score-card-issues { font-size: 11px; color: #94a3b8; margin-top: 4px; display: flex; align-items: center; justify-content: center; gap: 4px; }
  .dot-critical { width: 6px; height: 6px; border-radius: 50%; background: #dc2626; display: inline-block; }
  .dot-warning { width: 6px; height: 6px; border-radius: 50%; background: #d97706; display: inline-block; }
  .dot-good { width: 6px; height: 6px; border-radius: 50%; background: #16a34a; display: inline-block; }

  /* ── Priority Fixes ── */
  .priority-section { background: #fff; border-radius: 12px; padding: 0; margin-bottom: 20px; border: 1px solid #e2e8f0; overflow: hidden; }
  .priority-section h2 { font-size: 15px; font-weight: 700; color: #fff; margin-bottom: 0; padding: 16px 24px; display: flex; align-items: center; gap: 8px; background: linear-gradient(135deg, #0c1222 0%, #152847 100%); }
  .priority-list-wrap { padding: 20px 24px; }
  .priority-list { list-style: none; }
  .priority-list li { padding: 8px 0; border-bottom: 1px solid #f1f5f9; display: flex; gap: 10px; align-items: flex-start; font-size: 13px; }
  .priority-list li:last-child { border-bottom: none; }
  .priority-num { width: 20px; height: 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; flex-shrink: 0; color: #fff; }
  .priority-num-crit { background: #dc2626; }
  .priority-num-warn { background: #d97706; }
  .priority-text { color: #334155; }
  .priority-rec { font-size: 12px; color: #64748b; margin-top: 2px; }

  /* ── Module Sections ── */
  .module-section { background: #fff; border-radius: 12px; margin-bottom: 10px; border: 1px solid #e2e8f0; overflow: hidden; }
  .module-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 20px; cursor: pointer; user-select: none; background: linear-gradient(135deg, #0c1222 0%, #152847 100%); }
  .module-header:hover { background: linear-gradient(135deg, #101a30 0%, #1a3055 100%); }
  .module-left { display: flex; align-items: center; gap: 14px; }
  .module-grade { width: 36px; height: 36px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 16px; font-weight: 800; color: #fff; flex-shrink: 0; box-shadow: 0 2px 6px rgba(0,0,0,0.2); }
  .module-info h2 { font-size: 15px; font-weight: 600; color: #fff; }
  .module-meta { font-size: 12px; color: rgba(255,255,255,0.55); display: flex; gap: 4px; align-items: center; margin-top: 2px; }
  .meta-sep { opacity: 0.4; }
  .chevron { color: rgba(255,255,255,0.5); transition: transform 0.2s; flex-shrink: 0; }
  .module-section.collapsed .chevron { transform: rotate(-90deg); }
  .module-section.collapsed .module-body { display: none; }
  .module-body { padding: 0 20px 16px; }

  /* ── Finding Groups ── */
  .finding-group { margin-top: 12px; border-radius: 8px; overflow: hidden; }
  .finding-group-header { padding: 8px 12px; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; display: flex; align-items: center; gap: 8px; }
  .finding-count { font-size: 11px; padding: 0 6px; border-radius: 10px; line-height: 18px; }
  .group-critical .finding-group-header { background: #fef2f2; color: #991b1b; }
  .group-critical .finding-count { background: #fecaca; color: #991b1b; }
  .group-warning .finding-group-header { background: #fffbeb; color: #92400e; }
  .group-warning .finding-count { background: #fde68a; color: #92400e; }
  .group-good .finding-group-header { background: #f0fdf4; color: #166534; }
  .group-good .finding-count { background: #bbf7d0; color: #166534; }

  /* ── Findings with screenshots above text ── */
  .finding-row { padding: 10px 12px; border-bottom: 1px solid #f8fafc; font-size: 13px; }
  .finding-row:last-child { border-bottom: none; }
  .finding-ss { margin-bottom: 8px; }
  .finding-ss img { width: 100%; max-width: 600px; border-radius: 8px; border: 2px dashed #e2e8f0; display: block; cursor: pointer; transition: transform 0.2s; }
  .group-critical .finding-ss img { border-color: #fca5a5; }
  .group-warning .finding-ss img { border-color: #fde68a; }
  .finding-ss img:hover { transform: scale(1.01); }
  .finding-ss img.zoomed { position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%); max-width: 92vw; max-height: 92vh; z-index: 1000; border: 3px solid #dc2626; border-radius: 10px; box-shadow: 0 24px 64px rgba(0,0,0,0.4); }
  .finding-msg { color: #334155; }
  .finding-rec { color: #94a3b8; font-size: 12px; margin-top: 2px; }
  .group-good .finding-row { color: #64748b; }
  .group-good .finding-msg { color: #64748b; }

  /* ── Comparison Table ── */
  .comparison-table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 13px; }
  .comparison-table th { background: #f8fafc; padding: 8px 10px; text-align: left; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #64748b; }
  .comparison-table td { padding: 8px 10px; border-bottom: 1px solid #f1f5f9; }
  .comparison-table .main-row { background: #eff6ff; }
  .comp-url { font-weight: 500; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .footer { text-align: center; padding: 20px; color: #94a3b8; font-size: 11px; }

  @media (max-width: 640px) {
    .report-header { padding: 24px 20px 20px; }
    .hdr-stats { flex-direction: column; align-items: flex-start; }
    .score-strip { grid-template-columns: repeat(2, 1fr); }
    .module-left { flex-direction: column; align-items: flex-start; }
  }
  @media print {
    .module-section.collapsed .module-body { display: block !important; }
    .chevron { display: none; }
    body { background: #fff; }
    .module-section, .priority-section, .score-card { break-inside: avoid; }
  }
</style>
</head>
<body>
<div class="report">

  <!-- HERO HEADER -->
  <div class="report-header">
    <h1>Website Health Report</h1>
    <div class="hdr-url">${escapeHtml(report.url)}</div>
    <div class="hdr-desc">Comprehensive audit covering UX, visual design, performance, SEO, content, technical, CRO, and security. Generated ${date}.</div>
    <div class="hdr-stats">
      <div class="hdr-score-ring">
        <span class="sv">${report.overallScore}</span>
        <span class="sl">/100</span>
      </div>
      <div class="hdr-chips">
        <div class="hdr-chip chip-issues"><span class="cn">${summary.totalFindings}</span> Issues Found</div>
        <div class="hdr-chip chip-crit"><span class="cn">${summary.criticalCount}</span> Critical</div>
        <div class="hdr-chip chip-warn"><span class="cn">${summary.warningCount}</span> Warnings</div>
        <div class="hdr-chip chip-good"><span class="cn">${summary.goodCount}</span> Passed</div>
      </div>
    </div>
  </div>

  <div class="score-strip">${moduleCards}</div>

  <div class="priority-section">
    <h2>&#9888;&#65039; Top Priority Fixes</h2>
    <div class="priority-list-wrap">
    <ol class="priority-list">
      ${summary.priorityFixes.map((f, i) => `
        <li>
          <span class="priority-num ${f.severity === 'critical' ? 'priority-num-crit' : 'priority-num-warn'}">${i + 1}</span>
          <div>
            <div class="priority-text">${escapeHtml(f.message)}</div>
            ${f.recommendation ? `<div class="priority-rec">${escapeHtml(f.recommendation)}</div>` : ''}
          </div>
        </li>
      `).join('')}
    </ol>
    </div>
  </div>

  ${moduleSections}

  <div class="footer">Generated by Website Audit Tool &mdash; ${date}</div>
</div>
<script>
  document.addEventListener('click', (e) => {
    if (e.target.classList.contains('zoomed')) e.target.classList.remove('zoomed');
  });
</script>
${options.printMode ? `<script>window.onload = function() { window.print(); }</script>` : ''}
</body>
</html>`;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { generateHTML };
