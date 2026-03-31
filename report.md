# ordinals/ord — Contributor & Protocol Analysis
*Generated 2026-03-31 from 2077 pull requests across 259 contributors.*

---

## 1. Overview

| Metric | Value |
|---|---|
| Total PRs | 2077 |
| Merged PRs | 1647 (79.3%) |
| Unique contributors | 259 |
| Contribution HHI | 0.3640 — **highly concentrated (single actor dominant)** |
| Repo stars | 3950 |
| Open issues | 435 |

The **Herfindahl–Hirschman Index (HHI)** measures how equally contributions
are distributed. A score of 1.0 means one person merges everything; 0.0 means
perfectly equal distribution. Values above 0.25 indicate strong dominance.

---

## 2. Top 10 Contributors (by merged PRs)

| Rank | User | PRs submitted | Merged | Merge rate | Avg days open | Primary area |
|---|---|---|---|---|---|---|
| 1 | @casey | 1011 | 946 | 93.6% | 5.12d | other |
| 2 | @raphjaph | 362 | 294 | 81.2% | 9.02d | other |
| 3 | @terror | 49 | 47 | 95.9% | 18.32d | other |
| 4 | @gmart7t2 | 46 | 37 | 80.4% | 53.06d | other |
| 5 | @cryptoni9n | 29 | 26 | 89.7% | 12.68d | other |
| 6 | @elocremarc | 27 | 17 | 63.0% | 40.33d | other |
| 7 | @lugondev | 24 | 17 | 70.8% | 8.83d | runes |
| 8 | @veryordinally | 20 | 15 | 75.0% | 14.95d | other |
| 9 | @DrJingLee | 17 | 12 | 70.6% | 8.76d | other |
| 10 | @rot13maxi | 17 | 11 | 64.7% | 43.15d | wallet |

**@casey** accounts for **57.4%** of all merged PRs.  
The top 10 contributors collectively account for **86.3%** of merges.

Top committer by raw commit count: **@casey** (947 commits).

---

## 3. Protocol Area Breakdown (merged PRs only)

| Area | Merged PRs | Share |
|---|---|---|
| other        | 761 | 46.2% |
| feat         | 186 | 11.3% |
| wallet       | 126 | 7.7% |
| indexer      | 108 | 6.6% |
| fix          | 106 | 6.4% |
| api          | 85 | 5.2% |
| runes        | 85 | 5.2% |
| content      | 60 | 3.6% |
| cli          | 42 | 2.6% |
| test         | 33 | 2.0% |
| docs         | 30 | 1.8% |
| refactor     | 17 | 1.0% |
| recursive    | 8 | 0.5% |

This shows where active development energy is going.  
Areas with high velocity indicate protocol priorities; low-activity areas may
be stable, deprioritised, or awaiting external contributors.

---

## 4. Quarterly Contribution Timeline

| Quarter | PRs opened | Merged | Unique contributors |
|---|---|---|---|
| 2021-Q4 | 7 | 6 | 1 |
| 2022-Q1 | 92 | 88 | 3 |
| 2022-Q2 | 21 | 20 | 4 |
| 2022-Q3 | 188 | 174 | 6 |
| 2022-Q4 | 241 | 225 | 6 |
| 2023-Q1 | 264 | 193 | 61 |
| 2023-Q2 | 79 | 44 | 30 |
| 2023-Q3 | 125 | 100 | 24 |
| 2023-Q4 | 241 | 193 | 37 |
| 2024-Q1 | 257 | 209 | 45 |
| 2024-Q2 | 160 | 122 | 54 |
| 2024-Q3 | 76 | 53 | 19 |
| 2024-Q4 | 114 | 85 | 24 |
| 2025-Q1 | 79 | 49 | 24 |
| 2025-Q2 | 32 | 25 | 19 |
| 2025-Q3 | 26 | 12 | 14 |
| 2025-Q4 | 25 | 20 | 10 |
| 2026-Q1 | 50 | 29 | 14 |

Rising contributor counts signal growing community interest.  
Declining merge rates in later quarters can indicate rising review friction
or maintainer bandwidth constraints.

---

## 5. Concentration Analysis

**HHI = 0.3640** (highly concentrated (single actor dominant))


The protocol's merged-PR contribution is **highly concentrated**.  
This is common in early-stage open-source projects where a single
visionary maintainer drives the roadmap.  The risk is **bus-factor**: a
single point of failure for protocol evolution.  The data suggests the
project would benefit from explicit pathways for external contributors
to achieve merge rights on non-critical paths (docs, tests, tooling).

---

## 6. Key Observations

1. **Merge selectivity**: An overall merge rate of 79.3% means
   roughly 20.7% of submitted work is rejected or abandoned —
   reflecting high quality bar or narrow review bandwidth.

2. **New vs. returning contributors**: Contributors with only 1–2 PRs
   have a disproportionately low merge rate, which is typical but worth
   monitoring as it affects long-term community health.

3. **Protocol trajectory**: The area breakdown shows
   other as the
   most active development surface, indicating where the protocol is
   currently evolving fastest.

4. **Review latency**: Average time-to-merge across top contributors
   varies significantly. Fast-merging maintainers ship features quickly
   but may trade review depth; slow merge times indicate bottlenecks.

---

## 7. Methodology

- Data source: GitHub REST API `/repos/ordinals/ord/pulls?state=all`
- Merge rate = merged PRs / total PRs per contributor
- HHI computed on merged PR share per contributor
- "Area" classification uses keyword matching on PR title + labels
- Days open = time from `created_at` to `merged_at` or `closed_at`

---

*Raw data: `prs.csv` (per-PR) · `summary.json` (per-contributor) · `timeline.json` (per-quarter)*
