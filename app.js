'use strict';

// ── State ────────────────────────────────────────────────────────────────────
let agentCount = 0;
let charts = {};

const DEFAULT_AGENTS = [
  { name: 'Agent Alpha',   tests: 120, passed: 108, failed: 12, bugs: 15, hours: 8 },
  { name: 'Agent Beta',    tests:  95, passed:  80, failed: 15, bugs:  9, hours: 6 },
  { name: 'Agent Gamma',   tests: 200, passed: 190, failed: 10, bugs: 22, hours: 12 },
];

// ── DOM refs ──────────────────────────────────────────────────────────────────
const agentsContainer    = document.getElementById('agents-container');
const addAgentBtn        = document.getElementById('add-agent-btn');
const calculateBtn       = document.getElementById('calculate-btn');
const resetBtn           = document.getElementById('reset-btn');
const summarySection     = document.getElementById('summary-section');
const summaryGrid        = document.getElementById('summary-grid');
const resultsSection     = document.getElementById('results-section');
const resultsTbody       = document.getElementById('results-tbody');
const chartsSection      = document.getElementById('charts-section');

// ── Initialise ────────────────────────────────────────────────────────────────
function init() {
  agentsContainer.innerHTML = buildHeaderRow();
  agentCount = 0;
  DEFAULT_AGENTS.forEach(a => addAgentRow(a));
}

function buildHeaderRow() {
  return `
    <div class="agent-header-row">
      <span>Agent Name</span>
      <span>Tests Run</span>
      <span>Passed</span>
      <span>Failed</span>
      <span>Bugs Found</span>
      <span>Hours Spent</span>
      <span></span>
    </div>`;
}

// ── Add / Remove rows ─────────────────────────────────────────────────────────
function addAgentRow(defaults = {}) {
  agentCount++;
  const id = agentCount;
  const row = document.createElement('div');
  row.className = 'agent-row';
  row.dataset.id = id;
  row.innerHTML = `
    <div class="field-group">
      <span>Name</span>
      <input type="text"   class="field-name"   placeholder="Agent ${id}"
             value="${defaults.name  ?? ''}">
    </div>
    <div class="field-group">
      <span>Tests Run</span>
      <input type="number" class="field-tests"  placeholder="0" min="0"
             value="${defaults.tests ?? ''}">
    </div>
    <div class="field-group">
      <span>Passed</span>
      <input type="number" class="field-passed" placeholder="0" min="0"
             value="${defaults.passed ?? ''}">
    </div>
    <div class="field-group">
      <span>Failed</span>
      <input type="number" class="field-failed" placeholder="0" min="0"
             value="${defaults.failed ?? ''}">
    </div>
    <div class="field-group">
      <span>Bugs Found</span>
      <input type="number" class="field-bugs"   placeholder="0" min="0"
             value="${defaults.bugs  ?? ''}">
    </div>
    <div class="field-group">
      <span>Hours Spent</span>
      <input type="number" class="field-hours"  placeholder="0" min="0" step="0.5"
             value="${defaults.hours ?? ''}">
    </div>
    <button class="remove-btn" title="Remove agent" onclick="removeAgentRow(this)">✕</button>
  `;
  agentsContainer.appendChild(row);

  // Auto-fill failed when passed changes and tests is set (and vice-versa)
  const testsInput  = row.querySelector('.field-tests');
  const passedInput = row.querySelector('.field-passed');
  const failedInput = row.querySelector('.field-failed');

  passedInput.addEventListener('input', () => {
    const t = +testsInput.value;
    const p = +passedInput.value;
    if (t > 0 && p >= 0 && p <= t) failedInput.value = t - p;
  });
  failedInput.addEventListener('input', () => {
    const t = +testsInput.value;
    const f = +failedInput.value;
    if (t > 0 && f >= 0 && f <= t) passedInput.value = t - f;
  });
}

function removeAgentRow(btn) {
  const row = btn.closest('.agent-row');
  row.style.opacity = '0';
  row.style.transition = 'opacity .15s';
  setTimeout(() => row.remove(), 150);
}

// ── Collect inputs ────────────────────────────────────────────────────────────
function collectAgents() {
  const rows = agentsContainer.querySelectorAll('.agent-row');
  const agents = [];
  const errors = [];

  rows.forEach((row, i) => {
    const name   = row.querySelector('.field-name').value.trim() || `Agent ${i + 1}`;
    const tests  = parseFloat(row.querySelector('.field-tests').value)  || 0;
    const passed = parseFloat(row.querySelector('.field-passed').value) || 0;
    const failed = parseFloat(row.querySelector('.field-failed').value) || 0;
    const bugs   = parseFloat(row.querySelector('.field-bugs').value)   || 0;
    const hours  = parseFloat(row.querySelector('.field-hours').value)  || 0;

    if (tests <= 0) { errors.push(`Row ${i + 1}: Tests Run must be > 0.`); return; }
    if (passed + failed > tests) { errors.push(`Row ${i + 1}: Passed + Failed exceeds Tests Run.`); return; }

    agents.push({ name, tests, passed, failed, bugs, hours });
  });

  return { agents, errors };
}

// ── Calculate metrics ─────────────────────────────────────────────────────────
function calculateMetrics(agent) {
  const passRate        = agent.tests > 0    ? (agent.passed / agent.tests) * 100 : 0;
  const failRate        = agent.tests > 0    ? (agent.failed / agent.tests) * 100 : 0;
  const bugDetectionRate= agent.tests > 0    ? (agent.bugs   / agent.tests) * 100 : 0;
  const testsPerHour    = agent.hours > 0    ? agent.tests  / agent.hours        : 0;

  // Grade: weighted score = passRate * 0.5 + bugDetectionRate * 0.3 + min(testsPerHour/20,1)*100*0.2
  const score = (passRate * 0.5) + (bugDetectionRate * 0.3) + (Math.min(testsPerHour / 20, 1) * 100 * 0.2);
  const grade = score >= 80 ? 'A' : score >= 60 ? 'B' : score >= 40 ? 'C' : 'D';

  return { ...agent, passRate, failRate, bugDetectionRate, testsPerHour, score, grade };
}

// ── Render summary cards ──────────────────────────────────────────────────────
function renderSummary(metrics) {
  const totalTests    = metrics.reduce((s, m) => s + m.tests,  0);
  const totalPassed   = metrics.reduce((s, m) => s + m.passed, 0);
  const totalFailed   = metrics.reduce((s, m) => s + m.failed, 0);
  const totalBugs     = metrics.reduce((s, m) => s + m.bugs,   0);
  const totalHours    = metrics.reduce((s, m) => s + m.hours,  0);
  const avgPassRate   = metrics.reduce((s, m) => s + m.passRate, 0) / metrics.length;
  const avgFailRate   = metrics.reduce((s, m) => s + m.failRate, 0) / metrics.length;
  const overallBugRate= totalTests > 0 ? (totalBugs / totalTests) * 100 : 0;
  const overallTPH    = totalHours > 0 ? totalTests / totalHours : 0;
  const topAgent      = metrics.reduce((best, m) => m.score > best.score ? m : best, metrics[0]);

  summaryGrid.innerHTML = `
    ${summaryCard('Total Tests Run',     totalTests,               '',              'val-blue')}
    ${summaryCard('Total Passed',        totalPassed,              '',              'val-green')}
    ${summaryCard('Total Failed',        totalFailed,              '',              'val-red')}
    ${summaryCard('Avg Pass Rate',       fmt(avgPassRate) + '%',   '',              'val-green')}
    ${summaryCard('Avg Fail Rate',       fmt(avgFailRate) + '%',   '',              'val-red')}
    ${summaryCard('Bugs Found',          totalBugs,                '',              'val-yellow')}
    ${summaryCard('Bug Detection Rate',  fmt(overallBugRate) + '%','overall',       'val-yellow')}
    ${summaryCard('Tests / Hour',        fmt(overallTPH),          'overall',       'val-accent')}
    ${summaryCard('Top Performer',       topAgent.name,            'Grade ' + topAgent.grade, 'val-accent')}
  `;
  summarySection.classList.remove('hidden');
}

function summaryCard(label, value, sub, valClass) {
  return `
    <div class="summary-card">
      <span class="label">${label}</span>
      <span class="value ${valClass}">${value}</span>
      ${sub ? `<span class="sub">${sub}</span>` : ''}
    </div>`;
}

// ── Render table ──────────────────────────────────────────────────────────────
function renderTable(metrics) {
  resultsTbody.innerHTML = metrics.map(m => `
    <tr>
      <td><strong>${escHtml(m.name)}</strong></td>
      <td>${m.tests}</td>
      <td style="color:var(--green)">${m.passed}</td>
      <td style="color:var(--red)">${m.failed}</td>
      <td style="color:var(--yellow)">${m.bugs}</td>
      <td>${m.hours > 0 ? m.hours : '—'}</td>
      <td>
        <div class="bar-cell">
          <div class="bar-bg"><div class="bar-fill" style="width:${m.passRate}%;background:var(--green)"></div></div>
          <span>${fmt(m.passRate)}%</span>
        </div>
      </td>
      <td>
        <div class="bar-cell">
          <div class="bar-bg"><div class="bar-fill" style="width:${m.failRate}%;background:var(--red)"></div></div>
          <span>${fmt(m.failRate)}%</span>
        </div>
      </td>
      <td>
        <div class="bar-cell">
          <div class="bar-bg"><div class="bar-fill" style="width:${Math.min(m.bugDetectionRate,100)}%;background:var(--yellow)"></div></div>
          <span>${fmt(m.bugDetectionRate)}%</span>
        </div>
      </td>
      <td>${m.hours > 0 ? fmt(m.testsPerHour) : '—'}</td>
      <td><span class="badge badge-${m.grade}">${m.grade}</span></td>
    </tr>
  `).join('');
  resultsSection.classList.remove('hidden');
}

// ── Render charts ─────────────────────────────────────────────────────────────
const CHART_COLORS = ['#6366f1','#22c55e','#f59e0b','#3b82f6','#ec4899','#14b8a6','#f97316','#8b5cf6'];

function renderCharts(metrics) {
  const labels = metrics.map(m => m.name);

  destroyCharts();

  charts.passRate = makeBarChart('passRateChart', labels,
    metrics.map(m => fmt(m.passRate)),
    'Pass Rate (%)', CHART_COLORS);

  charts.productivity = makeBarChart('productivityChart', labels,
    metrics.map(m => m.hours > 0 ? fmt(m.testsPerHour) : 0),
    'Tests / Hour', CHART_COLORS);

  charts.bugRate = makeBarChart('bugRateChart', labels,
    metrics.map(m => fmt(m.bugDetectionRate)),
    'Bug Detection Rate (%)', CHART_COLORS);

  charts.testsDist = makeDoughnutChart('testsDistChart', labels,
    metrics.map(m => m.tests), CHART_COLORS);

  chartsSection.classList.remove('hidden');
}

function makeBarChart(id, labels, data, label, colors) {
  const ctx = document.getElementById(id).getContext('2d');
  return new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label,
        data,
        backgroundColor: colors.slice(0, labels.length).map(c => c + 'cc'),
        borderColor: colors.slice(0, labels.length),
        borderWidth: 1.5,
        borderRadius: 6,
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#8892a4' }, grid: { color: '#2e3348' } },
        y: { ticks: { color: '#8892a4' }, grid: { color: '#2e3348' }, beginAtZero: true }
      }
    }
  });
}

function makeDoughnutChart(id, labels, data, colors) {
  const ctx = document.getElementById(id).getContext('2d');
  return new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data,
        backgroundColor: colors.slice(0, labels.length).map(c => c + 'cc'),
        borderColor: '#1a1d27',
        borderWidth: 2,
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { labels: { color: '#8892a4', boxWidth: 14 } }
      }
    }
  });
}

function destroyCharts() {
  Object.values(charts).forEach(c => c && c.destroy());
  charts = {};
}

// ── Main calculate handler ────────────────────────────────────────────────────
function calculate() {
  const { agents, errors } = collectAgents();

  if (errors.length) {
    alert('Please fix the following:\n\n' + errors.join('\n'));
    return;
  }
  if (agents.length === 0) {
    alert('Add at least one agent row.');
    return;
  }

  const metrics = agents.map(calculateMetrics);
  renderSummary(metrics);
  renderTable(metrics);
  renderCharts(metrics);

  summarySection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── Reset ─────────────────────────────────────────────────────────────────────
function reset() {
  destroyCharts();
  summarySection.classList.add('hidden');
  resultsSection.classList.add('hidden');
  chartsSection.classList.add('hidden');
  init();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(n) { return Math.round(n * 100) / 100; }
function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Event listeners ───────────────────────────────────────────────────────────
addAgentBtn.addEventListener('click', () => addAgentRow());
calculateBtn.addEventListener('click', calculate);
resetBtn.addEventListener('click', reset);

// ── Boot ──────────────────────────────────────────────────────────────────────
init();
