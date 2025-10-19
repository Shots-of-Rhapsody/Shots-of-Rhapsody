---
title: "Modular Moral Reasoning"
subtitle: Turn philosophy into math, then test it, compare it & explain it.
published: 2025-10-01
description: Building a transparent engine where ethical theories become modular programs evaluated on shared scenarios.
image: "./Modular Ethics.jpg"
tags: [Philosophy, Ethics, Mathematics, AI, Moral-Uncertainty]
category: Modern Philosophy
draft: false
---

# Facts live in causal models. Values live in normative modules. Disagreement is handled by explicit moral uncertainty. No hand-waving.

---

## Why: Clarity Over Rhetoric

Debates drift, math commits. The aim is to expose assumptions, score actions & show where theories truly diverge.  
Each recommendation ships with a minimal explanation set, the few premises that actually did the work.

---

## Purpose

A reproducible testbed that:

1. **Separates facts from values.**  
2. **Lets multiple theories run side-by-side** on the same scenario.  
3. **Aggregates disagreement** under explicit credences, with safeguard constraints.

---

## How: Modular Ethics

Consequentialism, deontology, virtue ethics & other moral theories are implemented as plug-in evaluators with shared inputs & comparable outputs.  

World models carry the **facts**.  
Normative modules carry the **values**.  
Aggregation handles **pluralism**.  
Constraints protect **rights**.

---

## Formal Core (Plain Math)

Modular ethics builds a formal bridge between philosophy & computation.

```latex
% World model and outcomes
% M induces a distribution over outcomes O for each action a
P(O \mid a, M)

% Consequentialism
% Weights w_i ≥ 0 with Σ_i w_i = 1; v(·) is a utility/priority map
CW_{\text{cons}}(a) = \mathbb{E}_M\!\left[\sum_i w_i \cdot v\!\big(U_i(O)\big) \,\middle|\, a\right]

% Deontology (admissibility) and admissible set
\text{Admissible}(a) \;\text{iff}\; \forall k:\; g_k(a, M) \le 0
\qquad
A^{*} = \{\, a \;:\; \forall k\, g_k(a, M) \le 0 \,\}

% Virtue (trait distance with per-trait scaling S)
CW_{\text{virtue}}(a) = -\,\big\|\, S \circ \big(T_{\text{after}}(a) - T^*\big)\big\|_{2}

% Per-scenario normalization on the admissible set A*
m_j = \min_{a \in A^{*}} CW_j(a) \\
M_j = \max_{a \in A^{*}} CW_j(a)

f_j(x) = \frac{x - m_j}{M_j - m_j + \varepsilon}

% Aggregation under moral uncertainty (credences p_j ≥ 0, Σ_j p_j = 1)
CW(a) = \sum_j p_j \, f_j\!\big(CW_j(a)\big),
\qquad a \in A^{*}

% Utility shorthand
U = \sum_i w_i \cdot v\!\big(U_i\big)

% Notes:
% - Normalization is taken over the admissible set A^{*}.
% - If A^{*} = ∅, select actions by lexicographically minimizing constraint violations.
% - Virtue evaluation uses the L2 norm with per-trait scaling S to prevent unit dominance.
% - The world model M defines P(O | a, M), anchoring all expectations.
```

At a glance:
Aggregation combines each theory’s normalized scores under weighted moral uncertainty, producing a single composite measure of moral recommendation across frameworks.

## Example Scenarios:

```latex
Scenario 1: Clinical Triage — One Ventilator, Two Patients

ID: Triage Ventilator
% Agents
A:
  baseline_wellbeing = 0.55
  years_left = 35
  consent = true
  P(survival | vent) = 0.80
  P(survival | no-vent) = 0.10

B:
  baseline_wellbeing = 0.55
  years_left = 35
  consent = true
  P(survival | vent) = 0.60
  P(survival | no-vent) = 0.55

% Actions
Actions = { allocate_A, allocate_B, lottery }

% Policy
Policy: Prognosis differences count as relevant, lottery allowed when differences are small.
```

```latex
Scenario 2: Flood Evacuation — Promise vs Numbers

ID: Evacuation Promise
% Context
Context: flood, resource-scarce environment.

% Agents
Agents = { D1(elderly), D2, D3, D4, D5, R(rescuer with promise to D1) }

% Constraints
Boat_capacity = 3

% Probabilities
P(survival | rescued_immediately) ≈ 0.95 per passenger
P(survival | delayed, east) = 0.40
P(survival | delayed, west) = 0.60

% Actions
Actions = { go_east_now, go_west_then_east, mixed_route_break_promise }

% Sketch
Expected lives per action are derived directly from these parameters for auditability.
```

---

## Closing

Built for transparency, reproducibility & pluralistic reasoning.
The goal is not to replace moral judgment with numbers, but to make judgment legible. To see which assumptions move the needle, where theories part ways & how plural reasoning can still converge on understanding.

When philosophy meets math, clarity stops being cold & it becomes the beginning of honesty.