const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let currentAuditId = null;

// View management
function showView(viewId) {
  $$('.view').forEach(v => v.classList.remove('active'));
  $(`#${viewId}`).classList.add('active');
}

// Toggle competitors
$('#toggleCompetitors').addEventListener('click', () => {
  const fields = $('#competitorFields');
  fields.classList.toggle('hidden');
  $('#toggleCompetitors').textContent = fields.classList.contains('hidden')
    ? '+ Add competitor URLs (optional)'
    : '- Hide competitor URLs';
});

// Form submit
$('#auditForm').addEventListener('submit', async (e) => {
  e.preventDefault();

  let url = $('#urlInput').value.trim();
  if (!url) return;
  if (!url.startsWith('http')) url = 'https://' + url;

  const competitors = [
    $('#comp1')?.value?.trim(),
    $('#comp2')?.value?.trim()
  ].filter(Boolean);

  const btn = $('#runBtn');
  btn.disabled = true;
  btn.querySelector('.btn-text').textContent = 'Starting...';

  try {
    const res = await fetch('/api/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, competitors })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to start audit');
    }

    const { id } = await res.json();
    currentAuditId = id;

    // Show progress view
    $('#auditUrl').textContent = url;
    $('#progressBar').style.width = '0%';
    $('#progressText').textContent = 'Starting audit...';
    $('#moduleProgress').innerHTML = '';
    showView('progress');

    // Connect to SSE
    listenToProgress(id);

  } catch (err) {
    showError(err.message);
  } finally {
    btn.disabled = false;
    btn.querySelector('.btn-text').textContent = 'Run Audit';
  }
});

function listenToProgress(auditId) {
  const source = new EventSource(`/api/audit/${auditId}/progress`);

  source.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.type === 'progress') {
      const pct = data.total ? Math.round((data.step / data.total) * 100) : 0;
      $('#progressBar').style.width = pct + '%';
      $('#progressText').textContent = data.message;

      // Add current step indicator
      updateModuleList(data.message, 'running');
    }

    if (data.type === 'module_complete') {
      updateModuleList(data.name, 'complete', data.score, data.maxScore);
    }

    if (data.type === 'complete') {
      source.close();
      $('#progressBar').style.width = '100%';
      $('#progressText').textContent = 'Audit complete!';
      setTimeout(() => showReport(data.result), 500);
    }

    if (data.type === 'error') {
      source.close();
      showError(data.message);
    }
  };

  source.onerror = () => {
    source.close();
    // Try to fetch the result directly
    setTimeout(async () => {
      try {
        const res = await fetch(`/api/audit/${auditId}/report`);
        if (res.ok) {
          const result = await res.json();
          showReport(result);
        }
      } catch {
        // Already showing progress, will resolve
      }
    }, 2000);
  };
}

const moduleListItems = new Map();

function updateModuleList(name, status, score, maxScore) {
  const container = $('#moduleProgress');

  // Mark previous running items as complete if they don't have a score yet
  if (status === 'running') {
    container.querySelectorAll('.module-item[data-status="running"]').forEach(el => {
      if (!el.dataset.completed) {
        el.querySelector('.status-icon').innerHTML = '<span class="check">&#10003;</span>';
        el.dataset.status = 'complete';
      }
    });
  }

  if (status === 'complete' && moduleListItems.has(name)) {
    const item = moduleListItems.get(name);
    item.querySelector('.status-icon').innerHTML = '<span class="check">&#10003;</span>';
    item.dataset.status = 'complete';
    item.dataset.completed = 'true';
    if (score !== undefined) {
      const scoreEl = item.querySelector('.module-score');
      scoreEl.textContent = `${score}/${maxScore}`;
      scoreEl.style.color = scoreColor(score, maxScore);
    }
    return;
  }

  const item = document.createElement('div');
  item.className = 'module-item';
  item.dataset.status = status;

  const icon = status === 'running'
    ? '<div class="spinner"></div>'
    : '<span class="check">&#10003;</span>';

  const scoreText = score !== undefined ? `${score}/${maxScore}` : '';
  const scoreStyle = score !== undefined ? `color:${scoreColor(score, maxScore)}` : '';

  item.innerHTML = `
    <div class="status-icon">${icon}</div>
    <span class="module-name">${escapeHtml(name)}</span>
    <span class="module-score" style="${scoreStyle}">${scoreText}</span>
  `;

  container.appendChild(item);
  moduleListItems.set(name, item);
}

function scoreColor(score, max) {
  const pct = score / max;
  if (pct >= 0.8) return '#16a34a';
  if (pct >= 0.5) return '#d97706';
  return '#dc2626';
}

function showReport(result) {
  showView('report');
  const reportHtml = buildClientReport(result);
  $('#reportContent').innerHTML = reportHtml;

  // Collapsible module sections
  $$('#reportContent .module-header').forEach(header => {
    header.addEventListener('click', () => header.parentElement.classList.toggle('collapsed'));
  });

  // Screenshot zoom
  document.addEventListener('click', (e) => {
    if (e.target.classList.contains('zoomed')) e.target.classList.remove('zoomed');
  });
}

function scoreGrade(score, max) {
  const pct = (score / max) * 100;
  if (pct >= 90) return 'A';
  if (pct >= 80) return 'B';
  if (pct >= 65) return 'C';
  if (pct >= 50) return 'D';
  return 'F';
}

function buildClientReport(report) {
  const date = new Date(report.date).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const summary = report.executiveSummary;
  const gradeColor = scoreColor(report.overallScore, 100);

  // Score cards strip
  const moduleCards = report.modules.map(mod => {
    const color = scoreColor(mod.score, mod.maxScore);
    const g = scoreGrade(mod.score, mod.maxScore);
    const critCount = (mod.findings || []).filter(f => f.severity === 'critical').length;
    const warnCount = (mod.findings || []).filter(f => f.severity === 'warning').length;
    return `
      <a href="#module-${mod.id}" class="score-card" onclick="event.preventDefault();document.getElementById('module-${mod.id}').scrollIntoView({behavior:'smooth'})">
        <div class="score-card-grade" style="color:${color}">${g}</div>
        <div class="score-card-name">${escapeHtml(mod.name.replace(' Audit', '').replace('UI / Visual Design', 'UI Design').replace('CRO (Conversion Rate Optimization)', 'CRO'))}</div>
        <div class="score-card-num" style="color:${color}">${mod.score}/${mod.maxScore}</div>
        ${critCount > 0 ? `<div class="score-card-issues"><span class="dot-critical"></span>${critCount}</div>` : ''}
        ${warnCount > 0 && critCount === 0 ? `<div class="score-card-issues"><span class="dot-warning"></span>${warnCount}</div>` : ''}
        ${critCount === 0 && warnCount === 0 ? `<div class="score-card-issues"><span class="dot-good"></span>OK</div>` : ''}
      </a>`;
  }).join('');

  // Module sections with grouped findings + screenshots above text
  let moduleSections = '';
  for (const mod of report.modules) {
    const findings = mod.findings || [];
    const criticals = findings.filter(f => f.severity === 'critical');
    const warnings = findings.filter(f => f.severity === 'warning');
    const goods = findings.filter(f => f.severity === 'good');
    const color = scoreColor(mod.score, mod.maxScore);
    const g = scoreGrade(mod.score, mod.maxScore);

    const renderGroup = (items, label, cls) => {
      if (items.length === 0) return '';
      return `
        <div class="finding-group ${cls}">
          <div class="finding-group-header">${label} <span class="finding-count">${items.length}</span></div>
          ${items.map(f => `
            <div class="finding-row">
              ${f.screenshot ? `<div class="finding-ss"><img src="data:image/jpeg;base64,${f.screenshot}" alt="Screenshot" loading="lazy" onclick="this.classList.toggle('zoomed')"></div>` : ''}
              <div class="finding-msg">${escapeHtml(f.message)}</div>
              ${f.recommendation ? `<div class="finding-rec">${escapeHtml(f.recommendation)}</div>` : ''}
            </div>
          `).join('')}
        </div>`;
    };

    let comparisonTable = '';
    if (mod.comparison && mod.comparison.length > 0) {
      comparisonTable = `
        <table class="comparison-table">
          <thead><tr><th>Site</th><th>Load Time</th><th>Performance</th><th>SEO</th><th>Security</th><th>Score</th></tr></thead>
          <tbody>
            ${mod.comparison.map(c => {
              let hostname; try { hostname = new URL(c.url).hostname; } catch { hostname = c.url; }
              return `<tr class="${c.isMain ? 'main-row' : ''}">
                <td class="comp-url">${escapeHtml(hostname)}${c.isMain ? ' <em>(yours)</em>' : ''}</td>
                <td>${c.loadTime}ms</td>
                <td style="color:${scoreColor(c.performanceScore, 10)};font-weight:600">${c.performanceScore}</td>
                <td style="color:${scoreColor(c.seoScore, 10)};font-weight:600">${c.seoScore}</td>
                <td style="color:${scoreColor(c.securityScore, 10)};font-weight:600">${c.securityScore}</td>
                <td><strong>${c.overallScore}</strong>/100</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>`;
    }

    moduleSections += `
      <div class="module-section" id="module-${mod.id}">
        <div class="module-header">
          <div class="module-left">
            <div class="module-grade" style="background:${color}">${g}</div>
            <div class="module-info">
              <h2>${escapeHtml(mod.name)}</h2>
              <div class="module-meta">
                <span style="color:${color};font-weight:700">${mod.score}/${mod.maxScore}</span>
                <span class="meta-sep">&middot;</span>
                <span>${criticals.length} critical</span>
                <span class="meta-sep">&middot;</span>
                <span>${warnings.length} warnings</span>
                <span class="meta-sep">&middot;</span>
                <span>${goods.length} passed</span>
              </div>
            </div>
          </div>
          <svg class="chevron" width="20" height="20" viewBox="0 0 20 20"><path d="M6 8l4 4 4-4" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>
        </div>
        <div class="module-body">
          ${comparisonTable}
          ${renderGroup(criticals, 'Critical Issues', 'group-critical')}
          ${renderGroup(warnings, 'Warnings', 'group-warning')}
          ${renderGroup(goods, 'Passed Checks', 'group-good')}
        </div>
      </div>`;
  }

  return `
    <div class="report">
      <div class="report-header">
        <h1>Website Health Report</h1>
        <div class="hdr-url">${escapeHtml(report.url)}</div>
        <div class="hdr-desc">Comprehensive audit covering UX, visual design, performance, SEO, content, technical, CRO, and security. Generated ${date}.</div>
        <div class="hdr-stats">
          <div class="hdr-score-ring" style="border-color:${gradeColor}">
            <span class="sv" style="color:${gradeColor}">${report.overallScore}</span>
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
    </div>`;
}

function showError(message) {
  $('#errorMessage').textContent = message;
  showView('error');
}

// Retry button
$('#retryBtn').addEventListener('click', () => showView('landing'));
$('#newAuditBtn').addEventListener('click', () => {
  currentAuditId = null;
  moduleListItems.clear();
  showView('landing');
});

// Export buttons
$('#exportPdf').addEventListener('click', () => {
  if (!currentAuditId) return;
  const btn = $('#exportPdf');
  btn.disabled = true;
  const originalText = btn.innerHTML;
  btn.textContent = 'Generating PDF...';
  const a = document.createElement('a');
  a.href = `/api/audit/${currentAuditId}/export/pdf`;
  a.download = `audit-report-${Date.now()}.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => { btn.disabled = false; btn.innerHTML = originalText; }, 4000);
});

$('#exportHtml').addEventListener('click', () => {
  if (!currentAuditId) return;
  const a = document.createElement('a');
  a.href = `/api/audit/${currentAuditId}/export/html`;
  a.download = `audit-report-${Date.now()}.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
});

$('#exportScreenshot').addEventListener('click', () => {
  if (!currentAuditId) return;
  const btn = $('#exportScreenshot');
  btn.disabled = true;
  btn.textContent = 'Capturing...';
  const a = document.createElement('a');
  a.href = `/api/audit/${currentAuditId}/export/screenshot`;
  a.download = `audit-report-${Date.now()}.jpg`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => { btn.disabled = false; btn.innerHTML = '&#128247; Screenshot'; }, 3000);
});

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
