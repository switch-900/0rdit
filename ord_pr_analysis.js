/**
 * ord_pr_analysis.js
 *
 * Full pipeline:  GitHub API → prs.csv + summary.json + timeline.json + report.md
 *
 * Set GITHUB_TOKEN env var for 5 000 req/hr (instead of 60).
 * Usage:
 *   node ord_pr_analysis.js
 */

import fs from "fs";

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const REPO     = "ordinals/ord";
const BASE_URL = `https://api.github.com/repos/${REPO}`;
const PER_PAGE = 100;

const HEADERS = {
  "Accept": "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  ...(process.env.GITHUB_TOKEN
    ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
    : {})
};

// Protocol area keywords → derived from PR title / labels
const AREA_PATTERNS = {
  indexer:   /\b(index|indexer|reorg|block|chain)\b/i,
  wallet:    /\b(wallet|utxo|spend|send|balance|fee|psbt|sign)\b/i,
  runes:     /\b(rune|runes|runestone|edict|cenotaph)\b/i,
  recursive: /\b(recurs|delegate|metaprotocol)\b/i,
  api:       /\b(api|server|endpoint|route|http|json)\b/i,
  content:   /\b(content|mime|media|render|preview)\b/i,
  cli:       /\b(cli|command|arg|flag|option|subcommand)\b/i,
  docs:      /\b(doc|readme|changelog|spec|comment)\b/i,
  test:      /\b(test|spec|fixture|fuzz)\b/i,
  refactor:  /\b(refactor|cleanup|lint|fmt|clippy)\b/i,
  fix:       /\b(fix|bug|patch|revert|correct)\b/i,
  feat:      /\b(feat|add|implement|support|enable)\b/i,
};

// ─── HTTP HELPERS ─────────────────────────────────────────────────────────────

async function githubGet(url) {
  const res = await fetch(url, { headers: HEADERS });

  if (res.status === 403 || res.status === 429) {
    const reset = res.headers.get("x-ratelimit-reset");
    const wait  = reset ? Math.max(0, Number(reset) * 1000 - Date.now()) + 2000 : 60_000;
    console.warn(`  Rate limited — waiting ${Math.ceil(wait / 1000)}s …`);
    await new Promise(r => setTimeout(r, wait));
    return githubGet(url);
  }

  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} for ${url}`);
  }

  return res.json();
}

async function fetchAllPages(path, extraParams = "") {
  let page   = 1;
  let result = [];

  while (true) {
    const url = `${BASE_URL}${path}?per_page=${PER_PAGE}&page=${page}${extraParams}`;
    console.log(`  GET ${path} page ${page} …`);
    const data = await githubGet(url);
    if (!Array.isArray(data) || data.length === 0) break;
    result = result.concat(data);
    if (data.length < PER_PAGE) break;
    page++;
  }

  return result;
}

// ─── FETCH ────────────────────────────────────────────────────────────────────

async function fetchAllPRs() {
  console.log("\n[1/3] Fetching all PRs …");
  return fetchAllPages("/pulls", "&state=all");
}

async function fetchCommitStats() {
  console.log("\n[2/3] Fetching contributor commit stats …");
  try {
    // contributors endpoint returns up to 500 contributors sorted by commit count
    return await fetchAllPages("/contributors");
  } catch (e) {
    console.warn("  Could not fetch commit stats:", e.message);
    return [];
  }
}

async function fetchRepoInfo() {
  console.log("\n[3/3] Fetching repo metadata …");
  return githubGet(`${BASE_URL}`);
}

// ─── PROCESSING ───────────────────────────────────────────────────────────────

function daysBetween(a, b) {
  return (new Date(b) - new Date(a)) / 86_400_000;
}

function quarter(dateStr) {
  const d = new Date(dateStr);
  return `${d.getFullYear()}-Q${Math.ceil((d.getMonth() + 1) / 3)}`;
}

function classifyArea(title = "", labels = []) {
  const text = [title, ...labels.map(l => l.name ?? l)].join(" ");
  for (const [area, re] of Object.entries(AREA_PATTERNS)) {
    if (re.test(text)) return area;
  }
  return "other";
}

function processPRs(prs) {
  const byContributor = {};
  const byQuarter     = {};
  const rows          = [];

  for (const pr of prs) {
    const author  = pr.user?.login ?? "unknown";
    const created = pr.created_at;
    const merged  = pr.merged_at;
    const closed  = pr.closed_at;
    const ended   = merged || closed;
    const daysOpen = ended ? +daysBetween(created, ended).toFixed(2) : null;
    const q        = quarter(created);
    const area     = classifyArea(pr.title, pr.labels ?? []);

    rows.push({
      number:     pr.number,
      title:      pr.title?.replace(/"/g, "'") ?? "",
      author,
      state:      pr.state,
      merged:     !!merged,
      area,
      created_at: created,
      merged_at:  merged  ?? "",
      closed_at:  closed  ?? "",
      days_open:  daysOpen ?? "",
      quarter:    q,
    });

    // — per-contributor —
    if (!byContributor[author]) {
      byContributor[author] = {
        total: 0, merged: 0,
        totalDays: 0, countDays: 0,
        areas: {},
        quarters: {},
        firstPR: created,
        lastPR:  created,
      };
    }
    const c = byContributor[author];
    c.total++;
    if (merged) c.merged++;
    if (daysOpen !== null) { c.totalDays += daysOpen; c.countDays++; }
    c.areas[area]     = (c.areas[area]     ?? 0) + 1;
    c.quarters[q]     = (c.quarters[q]     ?? 0) + 1;
    if (created < c.firstPR) c.firstPR = created;
    if (created > c.lastPR)  c.lastPR  = created;

    // — per-quarter —
    if (!byQuarter[q]) byQuarter[q] = { total: 0, merged: 0, contributors: new Set(), areas: {} };
    byQuarter[q].total++;
    if (merged) byQuarter[q].merged++;
    byQuarter[q].contributors.add(author);
    byQuarter[q].areas[area] = (byQuarter[q].areas[area] ?? 0) + 1;
  }

  // Derived contributor fields
  for (const [, c] of Object.entries(byContributor)) {
    c.mergeRate    = +(c.merged / c.total).toFixed(4);
    c.avgDaysOpen  = c.countDays ? +(c.totalDays / c.countDays).toFixed(2) : 0;
    c.primaryArea  = Object.entries(c.areas).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "other";
    c.activeSpanDays = +daysBetween(c.firstPR, c.lastPR).toFixed(0);
  }

  // Serialize Sets in byQuarter
  for (const [q, data] of Object.entries(byQuarter)) {
    byQuarter[q] = {
      ...data,
      uniqueContributors: data.contributors.size,
      contributors: undefined,
    };
  }

  return { rows, byContributor, byQuarter };
}

// ─── CONCENTRATION (HHI) ─────────────────────────────────────────────────────
// Herfindahl–Hirschman Index on merged PRs.
// 0 = perfectly distributed   1 = single actor
function hhi(byContributor) {
  const total  = Object.values(byContributor).reduce((s, c) => s + c.merged, 0);
  if (!total) return 0;
  return Object.values(byContributor)
    .reduce((sum, c) => sum + (c.merged / total) ** 2, 0);
}

// ─── GINI COEFFICIENT ────────────────────────────────────────────────────────
// 0 = perfect equality   1 = one person has everything
function gini(byContributor) {
  const vals = Object.values(byContributor).map(c => c.merged).sort((a, b) => a - b);
  const n = vals.length;
  if (!n) return 0;
  const sum = vals.reduce((s, v) => s + v, 0);
  if (!sum) return 0;
  const weightedSum = vals.reduce((s, v, i) => s + v * (i + 1), 0);
  return +((2 * weightedSum) / (n * sum) - (n + 1) / n).toFixed(4);
}

// ─── BUS FACTOR ──────────────────────────────────────────────────────────────
// Minimum number of contributors whose removal would take away >= pct of merged
function busFactor(summary, pct = 0.8) {
  const total = summary.reduce((s, c) => s + c.merged, 0);
  let cum = 0;
  for (let i = 0; i < summary.length; i++) {
    cum += summary[i].merged;
    if (cum / total >= pct) return i + 1;
  }
  return summary.length;
}

// ─── EXTENDED STATS ──────────────────────────────────────────────────────────
function computeExtended(rows, summary) {
  // 1. Contributor tiers
  const tiers = { "one-time": 0, occasional: 0, regular: 0, core: 0 };
  for (const c of summary) {
    if (c.total === 1)       tiers["one-time"]++;
    else if (c.total <= 5)   tiers["occasional"]++;
    else if (c.total <= 20)  tiers["regular"]++;
    else                     tiers["core"]++;
  }

  // 2. Merge velocity per quarter (avg days open for MERGED PRs only)
  const qVelocity = {};
  for (const r of rows) {
    if (!r.merged || r.days_open === "") continue;
    if (!qVelocity[r.quarter]) qVelocity[r.quarter] = { sum: 0, count: 0 };
    qVelocity[r.quarter].sum   += parseFloat(r.days_open);
    qVelocity[r.quarter].count += 1;
  }
  const velocity = Object.entries(qVelocity)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([q, v]) => ({ quarter: q, avgDays: +(v.sum / v.count).toFixed(2) }));

  // 3. PR lifespan histogram (buckets in days, merged + closed)
  const buckets = { "same-day": 0, "1–7d": 0, "8–30d": 0, "31–90d": 0, "90d+": 0 };
  for (const r of rows) {
    if (r.days_open === "") continue;
    const d = parseFloat(r.days_open);
    if (d < 1)       buckets["same-day"]++;
    else if (d <= 7)  buckets["1–7d"]++;
    else if (d <= 30) buckets["8–30d"]++;
    else if (d <= 90) buckets["31–90d"]++;
    else              buckets["90d+"]++;
  }

  // 4. New contributor debuts per quarter
  const firstSeen = {};
  for (const r of rows) {
    if (!firstSeen[r.author] || r.quarter < firstSeen[r.author]) {
      firstSeen[r.author] = r.quarter;
    }
  }
  const debuts = {};
  for (const q of Object.values(firstSeen)) {
    debuts[q] = (debuts[q] ?? 0) + 1;
  }
  const debutSeries = Object.entries(debuts)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([quarter, count]) => ({ quarter, count }));

  // 5. Day-of-week distribution (0=Sun … 6=Sat)
  const DOW_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dow = [0, 0, 0, 0, 0, 0, 0];
  for (const r of rows) {
    dow[new Date(r.created_at).getDay()]++;
  }
  const dowSeries = DOW_NAMES.map((name, i) => ({ name, count: dow[i] }));

  // 6. Retention: contributors with > 1 PR
  const returning = summary.filter(c => c.total > 1).length;
  const retentionRate = +((returning / summary.length) * 100).toFixed(1);

  return { tiers, velocity, buckets, debutSeries, dowSeries, retentionRate };
}

// ─── NARRATIVE REPORT ────────────────────────────────────────────────────────

function buildReport(prs, byContributor, byQuarter, commitStats, repoInfo, score) {
  const total       = prs.length;
  const merged      = prs.filter(r => r.merged).length;
  const mergeRate   = ((merged / total) * 100).toFixed(1);
  const uniqueAuth  = Object.keys(byContributor).length;

  // Top contributors by merges
  const top10 = Object.entries(byContributor)
    .map(([user, c]) => ({ user, ...c }))
    .sort((a, b) => b.merged - a.merged)
    .slice(0, 10);

  const topUser       = top10[0];
  const top1Share     = ((topUser.merged / merged) * 100).toFixed(1);
  const top10Merged   = top10.reduce((s, c) => s + c.merged, 0);
  const top10Share    = ((top10Merged / merged) * 100).toFixed(1);

  // Commit concentration
  const topCommitter  = commitStats[0];

  // Protocol area breakdown
  const areaCount = {};
  for (const pr of prs) {
    if (pr.merged) areaCount[pr.area] = (areaCount[pr.area] ?? 0) + 1;
  }
  const areaLines = Object.entries(areaCount)
    .sort((a, b) => b[1] - a[1])
    .map(([a, n]) => `| ${a.padEnd(12)} | ${n} | ${((n / merged) * 100).toFixed(1)}% |`)
    .join("\n");

  // Timeline
  const quarters      = Object.keys(byQuarter).sort();
  const timelineLines = quarters.map(q => {
    const qd = byQuarter[q];
    return `| ${q} | ${qd.total} | ${qd.merged} | ${qd.uniqueContributors} |`;
  }).join("\n");

  // Concentration interpretation
  let hhiLabel;
  if (score > 0.25)      hhiLabel = "highly concentrated (single actor dominant)";
  else if (score > 0.15) hhiLabel = "moderately concentrated";
  else                   hhiLabel = "relatively distributed";

  const now = new Date().toISOString().split("T")[0];

  return `# ordinals/ord — Contributor & Protocol Analysis
*Generated ${now} from ${total} pull requests across ${uniqueAuth} contributors.*

---

## 1. Overview

| Metric | Value |
|---|---|
| Total PRs | ${total} |
| Merged PRs | ${merged} (${mergeRate}%) |
| Unique contributors | ${uniqueAuth} |
| Contribution HHI | ${score.toFixed(4)} — **${hhiLabel}** |
| Repo stars | ${repoInfo.stargazers_count ?? "n/a"} |
| Open issues | ${repoInfo.open_issues_count ?? "n/a"} |

The **Herfindahl–Hirschman Index (HHI)** measures how equally contributions
are distributed. A score of 1.0 means one person merges everything; 0.0 means
perfectly equal distribution. Values above 0.25 indicate strong dominance.

---

## 2. Top 10 Contributors (by merged PRs)

| Rank | User | PRs submitted | Merged | Merge rate | Avg days open | Primary area |
|---|---|---|---|---|---|---|
${top10.map((c, i) =>
  `| ${i + 1} | @${c.user} | ${c.total} | ${c.merged} | ${(c.mergeRate * 100).toFixed(1)}% | ${c.avgDaysOpen}d | ${c.primaryArea} |`
).join("\n")}

**@${topUser.user}** accounts for **${top1Share}%** of all merged PRs.  
The top 10 contributors collectively account for **${top10Share}%** of merges.

${commitStats.length > 0 && topCommitter
  ? `Top committer by raw commit count: **@${topCommitter.login}** (${topCommitter.contributions} commits).`
  : ""}

---

## 3. Protocol Area Breakdown (merged PRs only)

| Area | Merged PRs | Share |
|---|---|---|
${areaLines}

This shows where active development energy is going.  
Areas with high velocity indicate protocol priorities; low-activity areas may
be stable, deprioritised, or awaiting external contributors.

---

## 4. Quarterly Contribution Timeline

| Quarter | PRs opened | Merged | Unique contributors |
|---|---|---|---|
${timelineLines}

Rising contributor counts signal growing community interest.  
Declining merge rates in later quarters can indicate rising review friction
or maintainer bandwidth constraints.

---

## 5. Concentration Analysis

**HHI = ${score.toFixed(4)}** (${hhiLabel})

${score > 0.25 ? `
The protocol's merged-PR contribution is **highly concentrated**.  
This is common in early-stage open-source projects where a single
visionary maintainer drives the roadmap.  The risk is **bus-factor**: a
single point of failure for protocol evolution.  The data suggests the
project would benefit from explicit pathways for external contributors
to achieve merge rights on non-critical paths (docs, tests, tooling).`
: score > 0.15 ? `
Contribution is **moderately concentrated** — a small leadership group
drives most merges while a broader community participates.  This is a
healthy hybrid model for a security-sensitive protocol.`
: `
Contribution is **relatively distributed** across many contributors.
The protocol has achieved community governance at the code level.`}

---

## 6. Key Observations

1. **Merge selectivity**: An overall merge rate of ${mergeRate}% means
   roughly ${(100 - parseFloat(mergeRate)).toFixed(1)}% of submitted work is rejected or abandoned —
   reflecting high quality bar or narrow review bandwidth.

2. **New vs. returning contributors**: Contributors with only 1–2 PRs
   have a disproportionately low merge rate, which is typical but worth
   monitoring as it affects long-term community health.

3. **Protocol trajectory**: The area breakdown shows
   ${Object.entries(areaCount).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "core"} as the
   most active development surface, indicating where the protocol is
   currently evolving fastest.

4. **Review latency**: Average time-to-merge across top contributors
   varies significantly. Fast-merging maintainers ship features quickly
   but may trade review depth; slow merge times indicate bottlenecks.

---

## 7. Methodology

- Data source: GitHub REST API \`/repos/ordinals/ord/pulls?state=all\`
- Merge rate = merged PRs / total PRs per contributor
- HHI computed on merged PR share per contributor
- "Area" classification uses keyword matching on PR title + labels
- Days open = time from \`created_at\` to \`merged_at\` or \`closed_at\`

---

*Raw data: \`prs.csv\` (per-PR) · \`summary.json\` (per-contributor) · \`timeline.json\` (per-quarter)*
`;
}

// ─── HTML DASHBOARD ──────────────────────────────────────────────────────────

function buildHTML(summary, timeline, rows, repoInfo, hScore, ext) {
  const total    = rows.length;
  const merged   = rows.filter(r => r.merged).length;
  const mergeRate = ((merged / total) * 100).toFixed(1);
  const uniqueContribs = summary.length;

  // Extended unpacking
  const gScore      = gini({ _: { merged: 0 }, ...Object.fromEntries(summary.map(c => [c.user, c])) });
  const busN        = busFactor(summary, 0.8);
  const { tiers, velocity, buckets, debutSeries, dowSeries, retentionRate } = ext;

  // Decentralisation score 0–100: (1 - Gini) * 100
  const decentScore = Math.round((1 - gScore) * 100);
  const decentLabel = decentScore >= 70 ? 'Well Decentralised'
                    : decentScore >= 45 ? 'Mixed'
                    : decentScore >= 25 ? 'Moderately Centralised'
                    : 'Highly Centralised';
  const decentColor = decentScore >= 70 ? '#4ade80' : decentScore >= 45 ? '#fbbf24' : decentScore >= 25 ? '#f97316' : '#f87171';
  // bar fill % — clamp so the marker is always visible
  const barPct = Math.max(1, Math.min(99, decentScore));

  // Inner circle = top 5 contributors by merged PRs
  const innerCircle  = new Set(summary.slice(0, 5).map(c => c.user));
  const outsiderPRs  = rows.filter(r => !innerCircle.has(r.author));
  const outsiderMerged = outsiderPRs.filter(r => r.merged).length;
  const outsiderRate   = outsiderPRs.length ? (outsiderMerged / outsiderPRs.length) : 0;
  const insiderRate    = (() => {
    const ins = rows.filter(r => innerCircle.has(r.author));
    return ins.length ? ins.filter(r => r.merged).length / ins.length : 0;
  })();

  // Top 25 by merged
  const top25 = summary.slice(0, 25);

  // Area totals (merged only)
  const areaMap = {};
  for (const r of rows) {
    if (r.merged) areaMap[r.area] = (areaMap[r.area] ?? 0) + 1;
  }
  const areaSorted = Object.entries(areaMap).sort((a, b) => b[1] - a[1]);

  // Concentration slices: top1, top2-5, top6-20, rest
  const top1m   = summary[0]?.merged ?? 0;
  const top5m   = summary.slice(1, 5).reduce((s, c) => s + c.merged, 0);
  const top20m  = summary.slice(5, 20).reduce((s, c) => s + c.merged, 0);
  const restm   = merged - top1m - top5m - top20m;

  // Quarterly
  const qLabels  = timeline.map(t => t.quarter);
  const qTotal   = timeline.map(t => t.total);
  const qMerged  = timeline.map(t => t.merged);
  const qContrib = timeline.map(t => t.uniqueContributors);

  let hhiColor  = hScore > 0.25 ? "#f87171" : hScore > 0.15 ? "#fbbf24" : "#34d399";
  let hhiLabel  = hScore > 0.25 ? "Highly Concentrated"
                : hScore > 0.15 ? "Moderately Concentrated"
                : "Well Distributed";

  const areaColors = [
    "#f97316","#facc15","#4ade80","#22d3ee","#818cf8",
    "#e879f9","#fb923c","#a3e635","#38bdf8","#c084fc",
    "#f472b6","#6ee7b7",
  ];

  const generated = new Date().toUTCString();

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Ord-it — An audit of ordinals/ord</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js"><\/script>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg0: #0d0d0d; --bg1: #161616; --bg2: #1e1e1e; --bg3: #272727;
    --border: #2e2e2e;
    --text: #e5e5e5; --muted: #888; --accent: #f97316;
    --green: #4ade80; --red: #f87171; --yellow: #fbbf24; --blue: #60a5fa;
  }
  body { background: var(--bg0); color: var(--text); font-family: system-ui, sans-serif; font-size: 14px; line-height: 1.6; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }

  header { padding: 32px 24px 20px; border-bottom: 1px solid var(--border); }
  header h1 { font-size: 22px; font-weight: 700; color: var(--accent); }
  header p  { color: var(--muted); font-size: 12px; margin-top: 4px; }

  .layout { display: grid; grid-template-columns: 220px 1fr; min-height: 100vh; }
  nav { background: var(--bg1); border-right: 1px solid var(--border); padding: 20px 0; position: sticky; top: 0; height: 100vh; overflow-y: auto; }
  nav a { display: block; padding: 8px 20px; color: var(--muted); font-size: 13px; }
  nav a:hover, nav a.active { color: var(--text); background: var(--bg3); text-decoration: none; }
  nav .nav-section { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; color: #555; padding: 16px 20px 4px; }

  main { padding: 28px 28px 60px; overflow: hidden; }
  section { margin-bottom: 48px; scroll-margin-top: 20px; }
  h2 { font-size: 16px; font-weight: 700; margin-bottom: 16px; color: var(--text); border-left: 3px solid var(--accent); padding-left: 10px; }
  h3 { font-size: 13px; font-weight: 600; margin-bottom: 10px; color: var(--muted); }

  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 28px; }
  .card { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 16px 18px; }
  .card .label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }
  .card .value { font-size: 28px; font-weight: 700; line-height: 1.2; margin-top: 4px; }
  .card .sub   { font-size: 11px; color: var(--muted); margin-top: 2px; }

  .chart-grid { display: grid; gap: 16px; }
  .chart-grid.col2 { grid-template-columns: 1fr 1fr; }
  .chart-grid.col3 { grid-template-columns: 2fr 1fr; }
  .chart-box { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 18px; }
  .chart-box canvas { max-height: 320px; }

  .hhi-pill { display: inline-block; padding: 4px 12px; border-radius: 999px; font-size: 12px; font-weight: 600; background: ${hhiColor}22; color: ${hhiColor}; border: 1px solid ${hhiColor}55; margin-left: 10px; vertical-align: middle; }

  /* Table */
  .tbl-wrap { overflow-x: auto; border-radius: 8px; border: 1px solid var(--border); }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  thead tr { background: var(--bg3); }
  th { padding: 9px 12px; text-align: left; color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; cursor: pointer; user-select: none; white-space: nowrap; }
  th:hover { color: var(--text); }
  th .sort-icon { opacity: .4; margin-left: 4px; }
  th.sorted .sort-icon { opacity: 1; color: var(--accent); }
  tbody tr { border-top: 1px solid var(--border); transition: background .1s; }
  tbody tr:hover { background: var(--bg3); }
  td { padding: 8px 12px; white-space: nowrap; }
  td.muted { color: var(--muted); }
  .bar-bg { background: var(--bg3); border-radius: 3px; height: 6px; min-width: 60px; }
  .bar-fg { height: 6px; border-radius: 3px; background: var(--accent); }
  .tag { display: inline-block; padding: 2px 7px; border-radius: 4px; font-size: 10px; background: var(--bg3); color: var(--muted); border: 1px solid var(--border); }

  .search-row { display: flex; gap: 10px; margin-bottom: 12px; align-items: center; }
  .search-row input { background: var(--bg2); border: 1px solid var(--border); color: var(--text); border-radius: 6px; padding: 6px 12px; font-size: 13px; outline: none; flex: 1; max-width: 320px; }
  .search-row input:focus { border-color: var(--accent); }
  .row-count { color: var(--muted); font-size: 12px; }

  /* Decentralisation bar */
  .decent-wrap { padding: 8px 0 4px; }
  .decent-bar-outer { position: relative; height: 28px; border-radius: 8px; overflow: visible;
    background: linear-gradient(to right, #f87171 0%, #fbbf24 40%, #facc15 55%, #4ade80 100%);
    border: 1px solid var(--border); }
  .decent-bar-track { position: absolute; inset: 0; background: var(--bg2); border-radius: 8px;
    transition: width .6s cubic-bezier(.4,0,.2,1); }
  .decent-marker { position: absolute; top: -6px; bottom: -6px; width: 4px; border-radius: 2px;
    background: #fff; box-shadow: 0 0 8px #fff8; transform: translateX(-50%);
    transition: left .6s cubic-bezier(.4,0,.2,1); }
  .decent-labels { display: flex; justify-content: space-between; font-size: 11px; color: var(--muted); margin-top: 8px; }
  .decent-score-row { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 10px; }
  .decent-score-val { font-size: 38px; font-weight: 800; line-height: 1; }
  .decent-score-label { font-size: 13px; font-weight: 600; }

  /* Outsider probability */
  .prob-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 16px; }
  .prob-card { background: var(--bg3); border: 1px solid var(--border); border-radius: 8px; padding: 16px 18px; }
  .prob-card .pc-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }
  .prob-card .pc-val   { font-size: 32px; font-weight: 800; line-height: 1.1; margin-top: 4px; }
  .prob-card .pc-sub   { font-size: 11px; color: var(--muted); margin-top: 4px; }

  /* Contributor modal drawer */
  .drawer-overlay { position: fixed; inset: 0; background: #000a; z-index: 100; display: none; }
  .drawer-overlay.open { display: block; }
  .drawer { position: fixed; top: 0; right: 0; width: min(560px, 100vw); height: 100vh; background: var(--bg1); border-left: 1px solid var(--border); z-index: 101; display: flex; flex-direction: column; transform: translateX(100%); transition: transform .25s ease; }
  .drawer.open { transform: translateX(0); }
  .drawer-head { padding: 20px 22px 16px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
  .drawer-head img { width: 36px; height: 36px; border-radius: 50%; border: 2px solid var(--border); }
  .drawer-head .dh-info { flex: 1; }
  .drawer-head .dh-name { font-weight: 700; color: var(--text); font-size: 15px; }
  .drawer-head .dh-sub  { font-size: 11px; color: var(--muted); }
  .drawer-head button { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 20px; line-height: 1; padding: 4px; }
  .drawer-head button:hover { color: var(--text); }
  .drawer-stats { display: grid; grid-template-columns: repeat(4,1fr); gap: 1px; background: var(--border); flex-shrink: 0; }
  .drawer-stats .ds { background: var(--bg2); padding: 12px 14px; }
  .drawer-stats .ds .dl { font-size: 10px; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
  .drawer-stats .ds .dv { font-size: 20px; font-weight: 700; margin-top: 2px; }
  .drawer-filter { padding: 12px 22px; border-bottom: 1px solid var(--border); display: flex; gap: 8px; flex-shrink: 0; flex-wrap: wrap; }
  .drawer-filter button { background: var(--bg3); border: 1px solid var(--border); color: var(--muted); border-radius: 999px; padding: 4px 12px; font-size: 11px; cursor: pointer; }
  .drawer-filter button.active, .drawer-filter button:hover { background: var(--accent); color: #000; border-color: var(--accent); }
  .drawer-body { flex: 1; overflow-y: auto; padding: 8px 0; }
  .pr-row { padding: 10px 22px; border-bottom: 1px solid var(--border); display: flex; gap: 12px; align-items: flex-start; }
  .pr-row:hover { background: var(--bg2); }
  .pr-badge { flex-shrink: 0; margin-top: 3px; width: 14px; height: 14px; border-radius: 50%; }
  .pr-badge.merged { background: #a78bfa; }
  .pr-badge.closed { background: var(--red); }
  .pr-badge.open   { background: var(--green); }
  .pr-info { flex: 1; min-width: 0; }
  .pr-title { font-size: 12px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pr-title a { color: var(--text); }
  .pr-title a:hover { color: var(--accent); }
  .pr-meta { font-size: 11px; color: var(--muted); margin-top: 2px; }
  .pr-area { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px; background: var(--bg3); color: var(--muted); border: 1px solid var(--border); margin-left: 6px; }

  .btn-view { background: var(--bg3); border: 1px solid var(--border); color: var(--muted); border-radius: 5px; padding: 3px 9px; font-size: 11px; cursor: pointer; white-space: nowrap; }
  .btn-view:hover { color: var(--text); border-color: var(--accent); }

  @media (max-width: 720px) {
    .layout { grid-template-columns: 1fr; }
    nav { display: none; }
    .chart-grid.col2, .chart-grid.col3 { grid-template-columns: 1fr; }
    .drawer { width: 100vw; }
  }
<\/style>
</head>
<body>
<header>
  <h1>Ord-it <span style="font-weight:400;color:var(--muted);font-size:14px">an audit of ordinals/ord</span></h1>
  <p>Generated ${generated} &nbsp;·&nbsp; <a href="https://github.com/ordinals/ord" target="_blank">github.com/ordinals/ord</a></p>
</header>
<div class="layout">
<nav>
  <div class="nav-section">Overview</div>
  <a href="#overview">Key Metrics</a>
  <div class="nav-section">Contributors</div>
  <a href="#top-contributors">Top Contributors</a>
  <a href="#concentration">Concentration</a>
  <a href="#all-contributors">All Contributors</a>
  <a href="#community">Community Health</a>
  <div class="nav-section">Protocol</div>
  <a href="#areas">Protocol Areas</a>
  <a href="#lifecycle">PR Lifecycle</a>
  <a href="#timeline">Timeline</a>
</nav>
<main>

<!-- OVERVIEW CARDS -->
<section id="overview">
<h2>Key Metrics</h2>
<div class="cards">
  <div class="card">
    <div class="label">Total PRs</div>
    <div class="value">${total.toLocaleString()}</div>
    <div class="sub">open + closed</div>
  </div>
  <div class="card">
    <div class="label">Merged</div>
    <div class="value" style="color:var(--green)">${merged.toLocaleString()}</div>
    <div class="sub">${mergeRate}% merge rate</div>
  </div>
  <div class="card">
    <div class="label">Contributors</div>
    <div class="value">${uniqueContribs}</div>
    <div class="sub">unique authors</div>
  </div>
  <div class="card">
    <div class="label">Stars</div>
    <div class="value">${(repoInfo.stargazers_count ?? 0).toLocaleString()}</div>
    <div class="sub">github stars</div>
  </div>
  <div class="card">
    <div class="label">Open issues</div>
    <div class="value">${(repoInfo.open_issues_count ?? 0).toLocaleString()}</div>
    <div class="sub">current</div>
  </div>
  <div class="card">
    <div class="label">HHI Score</div>
    <div class="value" style="color:${hhiColor}">${hScore.toFixed(3)}</div>
    <div class="sub">${hhiLabel}</div>
  </div>
  <div class="card">
    <div class="label">Gini Coefficient</div>
    <div class="value" style="color:${hhiColor}">${gScore.toFixed(3)}</div>
    <div class="sub">0=equal · 1=one person</div>
  </div>
  <div class="card">
    <div class="label">Bus Factor</div>
    <div class="value" style="color:${busN <= 3 ? "#f87171" : busN <= 8 ? "#fbbf24" : "#4ade80"}">${busN}</div>
    <div class="sub">contributors = 80% of merges</div>
  </div>
  <div class="card">
    <div class="label">Retention</div>
    <div class="value" style="color:var(--blue)">${retentionRate}%</div>
    <div class="sub">contributed more than once</div>
  </div>
</div>
<p style="color:var(--muted);font-size:12px;max-width:680px">
  The <strong style="color:var(--text)">Herfindahl–Hirschman Index (HHI)</strong> measures contribution concentration.
  0 = perfectly equal distribution. 1 = single actor. Values above 0.25 indicate strong maintainer dominance.
</p>
</section>

<!-- TOP CONTRIBUTORS -->
<section id="top-contributors">
<h2>Top Contributors</h2>
<div class="chart-grid col3">
  <div class="chart-box">
    <h3>Merged PRs — top 25</h3>
    <canvas id="chartTopMerged"></canvas>
  </div>
  <div class="chart-box">
    <h3>Merge rate % — top 25</h3>
    <canvas id="chartMergeRate"></canvas>
  </div>
</div>
<div style="margin-top:16px" class="chart-box">
  <h3>Avg days to close — top 25</h3>
  <canvas id="chartDays"></canvas>
</div>
</section>

<!-- CONCENTRATION -->
<section id="concentration">
<h2>Decentralisation</h2>
<div class="chart-grid col2" style="margin-bottom:16px">
  <!-- Bar meter -->
  <div class="chart-box">
    <h3>Decentralisation score</h3>
    <div class="decent-wrap">
      <div class="decent-score-row">
        <span class="decent-score-val" style="color:${decentColor}">${decentScore}</span>
        <span class="decent-score-label" style="color:${decentColor}">${decentLabel}</span>
      </div>
      <div class="decent-bar-outer">
        <!-- mask covers the coloured portion from the right -->
        <div class="decent-bar-track" style="left:${barPct}%;right:0;border-radius:0 8px 8px 0"></div>
        <div class="decent-marker" style="left:${barPct}%"></div>
      </div>
      <div class="decent-labels"><span style="color:#f87171">Centralised</span><span>Mixed</span><span style="color:#4ade80">Decentralised</span></div>
    </div>
    <p style="font-size:12px;color:var(--muted);margin-top:16px">Score = (1 − Gini) × 100. Gini = ${gScore.toFixed(4)} &nbsp;·&nbsp; HHI = ${hScore.toFixed(4)} &nbsp;·&nbsp; Bus factor = <strong style="color:var(--text)">${busN}</strong></p>

    <!-- Outsider merge probability -->
    <div class="prob-grid">
      <div class="prob-card">
        <div class="pc-label">If you're in the top 5</div>
        <div class="pc-val" style="color:var(--green)">${(insiderRate * 100).toFixed(1)}%</div>
        <div class="pc-sub">chance your PR gets merged</div>
      </div>
      <div class="prob-card">
        <div class="pc-label">If you're outside the top 5</div>
        <div class="pc-val" style="color:${outsiderRate < 0.4 ? '#f87171' : outsiderRate < 0.65 ? '#fbbf24' : '#4ade80'}">${(outsiderRate * 100).toFixed(1)}%</div>
        <div class="pc-sub">chance your PR gets merged</div>
      </div>
    </div>
    <p style="font-size:11px;color:var(--muted);margin-top:10px">Based on ${outsiderPRs.length.toLocaleString()} PRs from contributors outside the top 5 (${outsiderMerged.toLocaleString()} merged).</p>
  </div>
  <!-- Breakdown -->
  <div class="chart-box">
    <h3>Who merges what (% of all merged PRs)</h3>
    <canvas id="chartConc"></canvas>
  </div>
</div>
<div class="chart-box">
  <div style="display:flex;gap:32px;flex-wrap:wrap;padding:8px 4px;font-size:13px;color:var(--muted)">
    <div><span style="display:inline-block;width:12px;height:12px;border-radius:2px;background:#f97316;margin-right:8px"></span>
      <strong style="color:var(--text)">@${summary[0]?.user ?? "—"}</strong> — ${top1m} merged PRs (${((top1m/merged)*100).toFixed(1)}%)
    </div>
    <div><span style="display:inline-block;width:12px;height:12px;border-radius:2px;background:#facc15;margin-right:8px"></span>
      <strong style="color:var(--text)">Next 4</strong> — ${top5m} merged (${((top5m/merged)*100).toFixed(1)}%)
    </div>
    <div><span style="display:inline-block;width:12px;height:12px;border-radius:2px;background:#22d3ee;margin-right:8px"></span>
      <strong style="color:var(--text)">Positions 6–20</strong> — ${top20m} merged (${((top20m/merged)*100).toFixed(1)}%)
    </div>
    <div><span style="display:inline-block;width:12px;height:12px;border-radius:2px;background:#334155;margin-right:8px"></span>
      <strong style="color:var(--text)">Everyone else</strong> — ${restm} merged (${((restm/merged)*100).toFixed(1)}%)
    </div>
  </div>
</div>
</section>

<!-- ALL CONTRIBUTORS TABLE -->
<section id="all-contributors">
<h2>All Contributors</h2>
<div class="search-row">
  <input id="tableSearch" type="text" placeholder="Search by username or area…" oninput="filterTable()" />
  <span class="row-count" id="rowCount"></span>
</div>
<div class="tbl-wrap">
<table id="contribTable">
  <thead>
    <tr>
      <th onclick="sortTable(0)" data-col="0">Rank<span class="sort-icon">↕</span></th>
      <th onclick="sortTable(1)" data-col="1">Author<span class="sort-icon">↕</span></th>
      <th onclick="sortTable(2)" data-col="2">Submitted<span class="sort-icon">↕</span></th>
      <th onclick="sortTable(3)" data-col="3">Merged<span class="sort-icon">↕</span></th>
      <th onclick="sortTable(4)" data-col="4">Merge Rate<span class="sort-icon">↕</span></th>
      <th onclick="sortTable(5)" data-col="5">Avg Days<span class="sort-icon">↕</span></th>
      <th onclick="sortTable(6)" data-col="6">Primary Area<span class="sort-icon">↕</span></th>
      <th onclick="sortTable(7)" data-col="7">Active Span<span class="sort-icon">↕</span></th>
      <th></th>
    </tr>
  </thead>
  <tbody id="contribBody"></tbody>
</table>
</div>
</section>

<!-- CONTRIBUTOR DRAWER -->
<div class="drawer-overlay" id="drawerOverlay" onclick="closeDrawer()"></div>
<div class="drawer" id="drawer">
  <div class="drawer-head">
    <img id="drawerAvatar" src="" alt="" />
    <div class="dh-info">
      <div class="dh-name" id="drawerName"></div>
      <div class="dh-sub" id="drawerSub"></div>
    </div>
    <a id="drawerGHLink" href="" target="_blank" style="font-size:12px;color:var(--accent)">View on GitHub ↗</a>
    <button onclick="closeDrawer()" title="Close">✕</button>
  </div>
  <div class="drawer-stats">
    <div class="ds"><div class="dl">Submitted</div><div class="dv" id="dStatTotal">—</div></div>
    <div class="ds"><div class="dl">Merged</div><div class="dv" style="color:var(--green)" id="dStatMerged">—</div></div>
    <div class="ds"><div class="dl">Merge Rate</div><div class="dv" id="dStatRate">—</div></div>
    <div class="ds"><div class="dl">Avg Days</div><div class="dv" id="dStatDays">—</div></div>
  </div>
  <div class="drawer-filter">
    <button class="active" onclick="drawerFilter('all',this)">All</button>
    <button onclick="drawerFilter('merged',this)">Merged</button>
    <button onclick="drawerFilter('closed',this)">Closed</button>
    <button onclick="drawerFilter('open',this)">Open</button>
  </div>
  <div class="drawer-body" id="drawerBody"></div>
</div>

<!-- COMMUNITY HEALTH -->
<section id="community">
<h2>Community Health</h2>
<div class="chart-grid col2">
  <div class="chart-box">
    <h3>Contributor tiers (by total PRs submitted)</h3>
    <canvas id="chartTiers"></canvas>
  </div>
  <div class="chart-box" style="display:flex;flex-direction:column;justify-content:center;padding:28px 32px;gap:14px;font-size:13px;color:var(--muted)">
    <div><strong style="color:var(--text)">One-time</strong> &nbsp;<span style="font-size:12px">(1 PR)</span> — submitted once, no follow-up</div>
    <div><strong style="color:var(--text)">Occasional</strong> &nbsp;<span style="font-size:12px">(2–5 PRs)</span> — periodic contributors</div>
    <div><strong style="color:var(--text)">Regular</strong> &nbsp;<span style="font-size:12px">(6–20 PRs)</span> — engaged contributors</div>
    <div><strong style="color:var(--text)">Core</strong> &nbsp;<span style="font-size:12px">(21+ PRs)</span> — sustained, high-volume contributors</div>
    <hr style="border-color:var(--border);margin-top:4px" />
    <p style="font-size:12px">A healthy project grows its "regular" and "core" tiers over time.
    A large "one-time" slice indicates either a high bar to entry or low community stickiness.</p>
  </div>
</div>
</section>

<!-- PROTOCOL AREAS -->
<section id="areas">
<h2>Protocol Areas</h2>
<div class="chart-grid col2">
  <div class="chart-box">
    <h3>Merged PRs by area</h3>
    <canvas id="chartAreaDoughnut"></canvas>
  </div>
  <div class="chart-box">
    <h3>Area breakdown (merged)</h3>
    <canvas id="chartAreaBar"></canvas>
  </div>
</div>
</section>

<!-- PR LIFECYCLE -->
<section id="lifecycle">
<h2>PR Lifecycle</h2>
<div class="chart-grid col2">
  <div class="chart-box">
    <h3>Lifespan distribution (all closed PRs)</h3>
    <canvas id="chartLifespan"></canvas>
  </div>
  <div class="chart-box">
    <h3>Day of week — PR submissions</h3>
    <canvas id="chartDow"></canvas>
  </div>
</div>
<div class="chart-box" style="margin-top:16px">
  <h3>Merge velocity — avg days to merge per quarter</h3>
  <canvas id="chartVelocity"></canvas>
</div>
</section>

<!-- TIMELINE -->
<section id="timeline">
<h2>Quarterly Timeline</h2>
<div class="chart-box" style="margin-bottom:16px">
  <h3>PR volume per quarter</h3>
  <canvas id="chartTimeline"></canvas>
</div>
<div class="chart-grid col2">
  <div class="chart-box">
    <h3>Unique contributors per quarter</h3>
    <canvas id="chartContribTrend"></canvas>
  </div>
  <div class="chart-box">
    <h3>New contributor debuts per quarter</h3>
    <canvas id="chartDebuts"></canvas>
  </div>
</div>
</section>

</main>
</div>

<script>
// ── EMBEDDED DATA ──────────────────────────────────────────────────────────
const SUMMARY   = ${JSON.stringify(top25)};
const ALL       = ${JSON.stringify(summary)};
const TIMELINE  = ${JSON.stringify(timeline)};
const AREAS     = ${JSON.stringify(areaSorted)};
const MERGED    = ${merged};
const TIERS     = ${JSON.stringify(tiers)};
const VELOCITY  = ${JSON.stringify(velocity)};
const BUCKETS   = ${JSON.stringify(buckets)};
const DEBUTS    = ${JSON.stringify(debutSeries)};
const DOW       = ${JSON.stringify(dowSeries)};
const HHI_SCORE = ${hScore};
const GINI_SCORE= ${gScore};
const BUS_N     = ${busN};
const OUTSIDER_RATE = ${outsiderRate};
const INSIDER_RATE  = ${insiderRate};
// Per-user PR list keyed by username
const USER_PRS  = (() => { const m = {}; ${JSON.stringify(rows.map(r=>({n:r.number,t:r.title,s:r.state,merged:r.merged,area:r.area,created:r.created_at,days:r.days_open,author:r.author})))}.forEach(r=>{ (m[r.author]=m[r.author]||[]).push(r); }); return m; })();

// ── CHART DEFAULTS ────────────────────────────────────────────────────────
Chart.defaults.color = "#888";
Chart.defaults.borderColor = "#2e2e2e";
Chart.defaults.font.family = "system-ui, sans-serif";
Chart.defaults.font.size   = 11;

const ACCENT     = "#f97316";
const GREEN      = "#4ade80";
const BLUE       = "#60a5fa";
const AREA_COLS  = ["#f97316","#facc15","#4ade80","#22d3ee","#818cf8","#e879f9","#fb923c","#a3e635","#38bdf8","#c084fc","#f472b6","#6ee7b7"];

function barOpts(indexAxis = "y") {
  return {
    indexAxis,
    responsive: true,
    maintainAspectRatio: true,
    plugins: { legend: { display: false }, tooltip: { mode: "index" } },
    scales: {
      x: { grid: { color: "#1e1e1e" } },
      y: { grid: { color: "#1e1e1e" } },
    },
  };
}

// Top merged
new Chart(document.getElementById("chartTopMerged"), {
  type: "bar",
  data: {
    labels:   SUMMARY.map(c => c.user),
    datasets: [{ label: "Merged PRs", data: SUMMARY.map(c => c.merged), backgroundColor: ACCENT, borderRadius: 3 }]
  },
  options: barOpts("y"),
});

// Merge rate
new Chart(document.getElementById("chartMergeRate"), {
  type: "bar",
  data: {
    labels:   SUMMARY.map(c => c.user),
    datasets: [{
      label: "Merge Rate %",
      data: SUMMARY.map(c => +(c.mergeRate * 100).toFixed(1)),
      backgroundColor: SUMMARY.map(c => c.mergeRate >= 0.75 ? GREEN : c.mergeRate >= 0.4 ? ACCENT : "#f87171"),
      borderRadius: 3,
    }]
  },
  options: { ...barOpts("y"), scales: { x: { max: 100, grid: { color: "#1e1e1e" } }, y: { grid: { color: "#1e1e1e" } } } },
});

// Avg days
new Chart(document.getElementById("chartDays"), {
  type: "bar",
  data: {
    labels:   SUMMARY.map(c => c.user),
    datasets: [{ label: "Avg Days Open", data: SUMMARY.map(c => c.avgDaysOpen), backgroundColor: BLUE, borderRadius: 3 }]
  },
  options: { ...barOpts("x"), plugins: { legend: { display: false } } },
});

// Concentration doughnut
new Chart(document.getElementById("chartConc"), {
  type: "doughnut",
  data: {
    labels: [
      "${summary[0]?.user ?? "top1"}",
      "Contributors 2–5",
      "Contributors 6–20",
      "Everyone else",
    ],
    datasets: [{
      data: [${top1m}, ${top5m}, ${top20m}, ${restm}],
      backgroundColor: ["#f97316","#facc15","#22d3ee","#334155"],
      borderWidth: 1,
      borderColor: "#161616",
    }]
  },
  options: {
    responsive: true,
    plugins: {
      legend: { position: "bottom", labels: { boxWidth: 12, padding: 16 } },
      tooltip: {
        callbacks: {
          label: ctx => \` \${ctx.label}: \${ctx.raw} PRs (\${((ctx.raw/MERGED)*100).toFixed(1)}%)\`
        }
      }
    }
  }
});

// Area doughnut
new Chart(document.getElementById("chartAreaDoughnut"), {
  type: "doughnut",
  data: {
    labels:   AREAS.map(a => a[0]),
    datasets: [{ data: AREAS.map(a => a[1]), backgroundColor: AREA_COLS, borderWidth: 1, borderColor: "#161616" }]
  },
  options: {
    responsive: true,
    plugins: { legend: { position: "bottom", labels: { boxWidth: 12, padding: 14 } } }
  }
});

// Area bar
new Chart(document.getElementById("chartAreaBar"), {
  type: "bar",
  data: {
    labels:   AREAS.map(a => a[0]),
    datasets: [{ label: "Merged PRs", data: AREAS.map(a => a[1]), backgroundColor: AREA_COLS, borderRadius: 3 }]
  },
  options: barOpts("y"),
});

// Timeline
new Chart(document.getElementById("chartTimeline"), {
  type: "line",
  data: {
    labels: ${JSON.stringify(qLabels)},
    datasets: [
      { label: "PRs opened",    data: ${JSON.stringify(qTotal)},   borderColor: ACCENT, backgroundColor: ACCENT + "22", fill: true, tension: .3, pointRadius: 3 },
      { label: "PRs merged",    data: ${JSON.stringify(qMerged)},  borderColor: GREEN,  backgroundColor: GREEN + "22",  fill: true, tension: .3, pointRadius: 3 },
    ]
  },
  options: { responsive: true, plugins: { legend: { position: "top", labels: { boxWidth: 12 } } }, scales: { x: { grid: { color: "#1e1e1e" } }, y: { grid: { color: "#1e1e1e" } } } }
});

// Contributor trend
new Chart(document.getElementById("chartContribTrend"), {
  type: "line",
  data: {
    labels: ${JSON.stringify(qLabels)},
    datasets: [
      { label: "Unique contributors", data: ${JSON.stringify(qContrib)}, borderColor: BLUE, backgroundColor: BLUE + "22", fill: true, tension: .3, pointRadius: 3 }
    ]
  },
  options: { responsive: true, plugins: { legend: { position: "top", labels: { boxWidth: 12 } } }, scales: { x: { grid: { color: "#1e1e1e" } }, y: { grid: { color: "#1e1e1e" } } } }
});

// New contributor debuts per quarter
new Chart(document.getElementById("chartDebuts"), {
  type: "bar",
  data: {
    labels: DEBUTS.map(d => d.quarter),
    datasets: [{ label: "First-time contributors", data: DEBUTS.map(d => d.count), backgroundColor: "#a78bfa", borderRadius: 3 }]
  },
  options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { grid: { color: "#1e1e1e" } }, y: { grid: { color: "#1e1e1e" } } } }
});

// Contributor tiers
new Chart(document.getElementById("chartTiers"), {
  type: "doughnut",
  data: {
    labels: ["One-time (1 PR)", "Occasional (2–5)", "Regular (6–20)", "Core (21+)"],
    datasets: [{
      data: [TIERS["one-time"], TIERS["occasional"], TIERS["regular"], TIERS["core"]],
      backgroundColor: ["#334155","#60a5fa","#f97316","#4ade80"],
      borderWidth: 1, borderColor: "#161616",
    }]
  },
  options: { responsive: true, plugins: { legend: { position: "bottom", labels: { boxWidth: 12, padding: 14 } } } }
});

// PR Lifespan histogram
new Chart(document.getElementById("chartLifespan"), {
  type: "bar",
  data: {
    labels: Object.keys(BUCKETS),
    datasets: [{ label: "PRs", data: Object.values(BUCKETS), backgroundColor: ["#4ade80","#a3e635","#fbbf24","#f97316","#f87171"], borderRadius: 3 }]
  },
  options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { grid: { color: "#1e1e1e" } }, y: { grid: { color: "#1e1e1e" } } } }
});

// Day of week
new Chart(document.getElementById("chartDow"), {
  type: "bar",
  data: {
    labels: DOW.map(d => d.name),
    datasets: [{ label: "PRs submitted", data: DOW.map(d => d.count), backgroundColor: DOW.map((d,i) => i===0||i===6 ? "#334155" : ACCENT), borderRadius: 3 }]
  },
  options: { responsive: true, plugins: { legend: { display: false }, tooltip: { callbacks: { footer: (items) => items[0].dataIndex === 0 || items[0].dataIndex === 6 ? "Weekend" : "Weekday" } } }, scales: { x: { grid: { color: "#1e1e1e" } }, y: { grid: { color: "#1e1e1e" } } } }
});

// Merge velocity per quarter
new Chart(document.getElementById("chartVelocity"), {
  type: "line",
  data: {
    labels: VELOCITY.map(v => v.quarter),
    datasets: [{ label: "Avg days to merge", data: VELOCITY.map(v => v.avgDays), borderColor: "#fbbf24", backgroundColor: "#fbbf2422", fill: true, tension: .3, pointRadius: 3 }]
  },
  options: { responsive: true, plugins: { legend: { display: false } }, scales: { x: { grid: { color: "#1e1e1e" } }, y: { grid: { color: "#1e1e1e" }, title: { display: true, text: "days" } } } }
});

// ── GAUGE ─────────────────────────────────────────────────────────────────
// (Visual rendered server-side as static HTML — no JS needed for bar)
document.getElementById('giniVal') && (document.getElementById('giniVal').textContent = GINI_SCORE.toFixed(4));

// ── CONTRIBUTOR TABLE ─────────────────────────────────────────────────────
const maxMerged = ALL[0]?.merged ?? 1;
let sortCol  = 0;
let sortDir  = 1;
let filtered = [...ALL];

function renderTable(data) {
  const tbody = document.getElementById("contribBody");
  tbody.innerHTML = data.map((c, i) => {
    const barW = Math.round((c.merged / maxMerged) * 100);
    const rateColor = c.mergeRate >= 0.75 ? "var(--green)" : c.mergeRate >= 0.4 ? "var(--accent)" : "var(--red)";
    return \`<tr>
      <td class="muted">\${i + 1}</td>
      <td><a href="https://github.com/\${c.user}" target="_blank">@\${c.user}</a></td>
      <td>\${c.total}</td>
      <td>
        <div style="display:flex;align-items:center;gap:8px">
          <span>\${c.merged}</span>
          <div class="bar-bg" style="flex:1"><div class="bar-fg" style="width:\${barW}%"></div></div>
        </div>
      </td>
      <td style="color:\${rateColor}">\${(c.mergeRate * 100).toFixed(1)}%</td>
      <td>\${c.avgDaysOpen}d</td>
      <td><span class="tag">\${c.primaryArea}</span></td>
      <td class="muted">\${c.activeSpanDays}d</td>
      <td><button class="btn-view" onclick="openDrawer('\${c.user}')">View PRs</button></td>
    </tr>\`;
  }).join("");
  document.getElementById("rowCount").textContent = \`\${data.length} of \${ALL.length} contributors\`;
}

function filterTable() {
  const q = document.getElementById("tableSearch").value.toLowerCase();
  filtered = ALL.filter(c => c.user.toLowerCase().includes(q) || c.primaryArea.toLowerCase().includes(q));
  renderTable(filtered);
}

function sortTable(col) {
  if (sortCol === col) sortDir *= -1;
  else { sortCol = col; sortDir = 1; }

  document.querySelectorAll("th").forEach((th, i) => {
    th.classList.toggle("sorted", i === col);
    th.querySelector(".sort-icon").textContent = i === col ? (sortDir === 1 ? "↓" : "↑") : "↕";
  });

  const key = ["_rank","user","total","merged","mergeRate","avgDaysOpen","primaryArea","activeSpanDays"][col];
  filtered.sort((a, b) => {
    const av = key === "_rank" ? ALL.indexOf(a) : a[key];
    const bv = key === "_rank" ? ALL.indexOf(b) : b[key];
    if (typeof av === "string") return av.localeCompare(bv) * sortDir;
    return (av - bv) * sortDir;
  });
  renderTable(filtered);
}

// ── DRAWER ────────────────────────────────────────────────────────────────
let drawerActiveFilter = 'all';
let drawerCurrentUser  = null;

function openDrawer(user) {
  drawerCurrentUser = user;
  drawerActiveFilter = 'all';
  const c = ALL.find(x => x.user === user);
  if (!c) return;

  document.getElementById('drawerAvatar').src = \`https://github.com/\${user}.png?size=72\`;
  document.getElementById('drawerName').textContent = '@' + user;
  document.getElementById('drawerSub').textContent = c.primaryArea + ' · active ' + c.activeSpanDays + ' days';
  document.getElementById('drawerGHLink').href = 'https://github.com/' + user;
  document.getElementById('dStatTotal').textContent  = c.total;
  document.getElementById('dStatMerged').textContent = c.merged;
  document.getElementById('dStatRate').textContent   = (c.mergeRate * 100).toFixed(1) + '%';
  document.getElementById('dStatDays').textContent   = c.avgDaysOpen + 'd';

  // reset filter buttons
  document.querySelectorAll('.drawer-filter button').forEach(b => b.classList.remove('active'));
  document.querySelector('.drawer-filter button').classList.add('active');

  renderDrawerPRs(user, 'all');
  document.getElementById('drawerOverlay').classList.add('open');
  document.getElementById('drawer').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeDrawer() {
  document.getElementById('drawerOverlay').classList.remove('open');
  document.getElementById('drawer').classList.remove('open');
  document.body.style.overflow = '';
}

function drawerFilter(type, btn) {
  drawerActiveFilter = type;
  document.querySelectorAll('.drawer-filter button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderDrawerPRs(drawerCurrentUser, type);
}

function renderDrawerPRs(user, filter) {
  const prs = (USER_PRS[user] || []).slice().reverse();
  const filtered = filter === 'all' ? prs
    : filter === 'merged' ? prs.filter(p => p.merged)
    : filter === 'closed' ? prs.filter(p => !p.merged && p.s === 'closed')
    : prs.filter(p => p.s === 'open');

  const body = document.getElementById('drawerBody');
  if (!filtered.length) {
    body.innerHTML = '<div style="padding:28px 22px;color:var(--muted);font-size:13px">No PRs in this filter.</div>';
    return;
  }
  body.innerHTML = filtered.map(p => {
    const badgeClass = p.merged ? 'merged' : p.s === 'open' ? 'open' : 'closed';
    const date = p.created ? p.created.split('T')[0] : '';
    const days = p.days !== '' && p.days != null ? p.days + 'd' : 'open';
    return \`<div class="pr-row">
      <div class="pr-badge \${badgeClass}"></div>
      <div class="pr-info">
        <div class="pr-title">
          <a href="https://github.com/ordinals/ord/pull/\${p.n}" target="_blank">#\${p.n} \${p.t}</a>
        </div>
        <div class="pr-meta">\${date} &nbsp;·&nbsp; \${days}<span class="pr-area">\${p.area}</span></div>
      </div>
    </div>\`;
  }).join('');
}

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });

// nav active link on scroll
const sections = document.querySelectorAll("section[id]");
const navLinks  = document.querySelectorAll("nav a");
window.addEventListener("scroll", () => {
  let cur = "";
  sections.forEach(s => { if (window.scrollY >= s.offsetTop - 60) cur = s.id; });
  navLinks.forEach(a => a.classList.toggle("active", a.getAttribute("href") === "#" + cur));
}, { passive: true });

renderTable(ALL);
<\/script>
</body>
</html>`;
}

// ─── WRITERS ─────────────────────────────────────────────────────────────────

function writeCSV(rows, path) {
  const headers = Object.keys(rows[0]);
  const lines   = rows.map(r =>
    headers.map(h => `"${String(r[h] ?? "").replace(/"/g, "'")}"`)
           .join(",")
  );
  fs.writeFileSync(path, [headers.join(","), ...lines].join("\n"), "utf8");
  console.log(`  Wrote ${rows.length} rows → ${path}`);
}

function writeJSON(data, path) {
  fs.writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
  console.log(`  Wrote → ${path}`);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

(async () => {
  const fromCache = process.argv.includes("--from-cache");
  console.log("=== ordinals/ord PR Analysis ===");

  let rawPRs, commitStats, repoInfo;

  if (fromCache) {
    console.log("📦 --from-cache: reading existing prs.csv + summary.json + timeline.json …");
    // Reconstruct rawPRs from prs.csv
    const csvLines = fs.readFileSync("prs.csv", "utf8").trim().split("\n");
    const headers  = csvLines[0].split(",");
    rawPRs = csvLines.slice(1).map(line => {
      const vals = line.match(/"([^"]*)"/g).map(v => v.slice(1,-1));
      const obj  = Object.fromEntries(headers.map((h, i) => [h, vals[i]]));
      return {
        number:     parseInt(obj.number),
        title:      obj.title,
        user:       { login: obj.author },
        state:      obj.state,
        created_at: obj.created_at,
        merged_at:  obj.merged_at   || null,
        closed_at:  obj.closed_at   || null,
        labels:     [],
      };
    });
    commitStats = [];
    repoInfo    = { stargazers_count: 0, open_issues_count: 0 };
    // Try to read cached repo info if it exists
    if (fs.existsSync("repoinfo.json")) {
      try { repoInfo = JSON.parse(fs.readFileSync("repoinfo.json", "utf8")); } catch(_) {}
    }
    console.log(`Loaded ${rawPRs.length} PRs from cache.`);
  } else {
    if (!process.env.GITHUB_TOKEN) {
      console.warn("⚠  GITHUB_TOKEN not set — rate limited to 60 requests/hr.");
      console.warn("   Set it to get 5 000 req/hr:\n");
      console.warn("   Windows  : set GITHUB_TOKEN=ghp_...\n");
      console.warn("   Mac/Linux: export GITHUB_TOKEN=ghp_...\n");
    }
    [rawPRs, commitStats, repoInfo] = await Promise.all([
      fetchAllPRs(),
      fetchCommitStats(),
      fetchRepoInfo(),
    ]);
    console.log(`\nTotal PRs fetched   : ${rawPRs.length}`);
    console.log(`Commit contributors : ${commitStats.length}`);
  }

  const { rows, byContributor, byQuarter } = processPRs(rawPRs);

  const concentrationScore = hhi(byContributor);

  // ── sorted summary ──
  const summary = Object.entries(byContributor)
    .map(([user, data]) => ({ user, ...data }))
    .sort((a, b) => b.merged - a.merged);

  // ── timeline ──
  const timeline = Object.entries(byQuarter)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([quarter, data]) => ({ quarter, ...data }));

  // ── extended stats ──
  const ext = computeExtended(rows, summary);

  // ── report ──
  const report = buildReport(rows, byContributor, byQuarter, commitStats, repoInfo, concentrationScore);

  // ── write outputs ──
  console.log("\n[Writing outputs …]");
  if (!fromCache) {
    writeCSV(rows, "prs.csv");
    writeJSON(summary,  "summary.json");
    writeJSON(timeline, "timeline.json");
    writeJSON(repoInfo, "repoinfo.json");
    fs.writeFileSync("report.md", report, "utf8");
    console.log(`  Wrote → report.md`);
  }

  const html = buildHTML(summary, timeline, rows, repoInfo, concentrationScore, ext);
  fs.writeFileSync("index.html", html, "utf8");
  console.log(`  Wrote → index.html`);

  console.log("\n✅ Done.");
  if (!fromCache) {
    console.log("   prs.csv       — full per-PR dataset");
    console.log("   summary.json  — per-contributor stats");
    console.log("   timeline.json — quarterly activity");
    console.log("   report.md     — narrative analysis ready to publish");
  }
  console.log("   index.html    — open in browser to view dashboard");
})();
