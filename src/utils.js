/**
 * Calculate severity based on score
 */
function severity(score, max = 10) {
  const pct = score / max;
  if (pct >= 0.8) return 'good';
  if (pct >= 0.5) return 'warning';
  return 'critical';
}

function severityIcon(sev) {
  return sev === 'good' ? '✅' : sev === 'warning' ? '⚠️' : '❌';
}

function severityLabel(sev) {
  return sev === 'good' ? 'Good' : sev === 'warning' ? 'Warning' : 'Critical';
}

/**
 * Create a finding object
 */
function finding(message, sev, recommendation = '') {
  return { message, severity: sev, recommendation };
}

/**
 * Calculate weighted overall score from module scores
 */
function overallScore(modules) {
  const weights = {
    ux: 15,
    ui: 12,
    performance: 18,
    seo: 15,
    content: 10,
    technical: 12,
    cro: 8,
    security: 10
  };

  let totalWeight = 0;
  let weightedSum = 0;

  for (const mod of modules) {
    const w = weights[mod.id] || 10;
    totalWeight += w;
    weightedSum += (mod.score / mod.maxScore) * w;
  }

  return Math.round((weightedSum / totalWeight) * 100);
}

/**
 * Flesch-Kincaid reading level estimation
 */
function fleschKincaid(text) {
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
  const words = text.split(/\s+/).filter(w => w.length > 0);
  const syllables = words.reduce((sum, w) => sum + countSyllables(w), 0);

  if (sentences.length === 0 || words.length === 0) return { score: 0, grade: 0 };

  const avgSentLen = words.length / sentences.length;
  const avgSyllPerWord = syllables / words.length;

  const score = 206.835 - 1.015 * avgSentLen - 84.6 * avgSyllPerWord;
  const grade = 0.39 * avgSentLen + 11.8 * avgSyllPerWord - 15.59;

  return {
    score: Math.max(0, Math.min(100, Math.round(score * 10) / 10)),
    grade: Math.max(0, Math.round(grade * 10) / 10),
    wordCount: words.length,
    sentenceCount: sentences.length
  };
}

function countSyllables(word) {
  word = word.toLowerCase().replace(/[^a-z]/g, '');
  if (word.length <= 3) return 1;
  word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '');
  word = word.replace(/^y/, '');
  const matches = word.match(/[aeiouy]{1,2}/g);
  return matches ? matches.length : 1;
}

/**
 * Extract contrast ratio between two RGB colors
 */
function contrastRatio(rgb1, rgb2) {
  const l1 = relativeLuminance(rgb1);
  const l2 = relativeLuminance(rgb2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance([r, g, b]) {
  const [rs, gs, bs] = [r, g, b].map(c => {
    c = c / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

function parseColor(colorStr) {
  if (!colorStr) return null;
  const rgbMatch = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (rgbMatch) return [parseInt(rgbMatch[1]), parseInt(rgbMatch[2]), parseInt(rgbMatch[3])];
  return null;
}

module.exports = {
  severity, severityIcon, severityLabel, finding,
  overallScore, fleschKincaid, contrastRatio, relativeLuminance, parseColor
};
