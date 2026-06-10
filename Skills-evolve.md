Below is a deeper map of the **SkillOpt / SkillGrad / Trace2Skill / EvoSkill / SkillRL / CoEvoSkills / SkillForge / SkillFoundry / SkillMOO / SkillSmith / SkillRevise / CODESKILL / SkillsBench** cluster.

One correction first: the paper I previously called “EvoSkills” is listed on arXiv as **CoEvoSkills: Self-Evolving Agent Skills via Co-Evolutionary Verification**. It is distinct from **EvoSkill: Automated Skill Discovery for Multi-Agent Systems**.

---

## 0. The common research object

All these papers treat an **agent skill** as an external, reusable procedural artifact:

[
\theta_{\text{skill}}
=====================

{\text{instructions},\ \text{workflow},\ \text{code/scripts},\ \text{examples},\ \text{tests},\ \text{constraints}}
]

The frozen agent model (M) is not updated. Instead, the system optimizes or selects (\theta_{\text{skill}}):

[
\theta_{\text{skill}}^{(t+1)}
=============================

\operatorname{Update}
\left(
\theta_{\text{skill}}^{(t)},
\ \tau_{1:n},
\ s_{1:n},
\ d_{1:n}
\right)
]

where (\tau) are execution trajectories, (s) are scores/verifier outcomes, and (d) are natural-language diagnoses or “textual gradients.”

This is the shared idea behind SkillOpt, SkillGrad, Trace2Skill, EvoSkill, SkillRL, SkillForge, SkillRevise, CODESKILL, and related systems.

---

# 1. What phenomenon / problem do they target?

## A. The empirical phenomenon: skills help, but not reliably

**SkillsBench** is the benchmark paper that frames the field. It reports that curated skills improve average pass rate by **+16.2 percentage points**, but the effect varies strongly by domain; some tasks are harmed, and self-generated skills provide no average benefit. It also reports that focused skills with **2–3 modules** outperform comprehensive documentation. ([arXiv][1])

This creates the core research problem:

> Agents can benefit from procedural knowledge, but naive skill authoring, one-shot generation, and indiscriminate context injection are unreliable.

**SWE-Skills-Bench** makes the conflict sharper for software engineering. It finds that real-world SWE skill injection has much smaller average benefit: **+1.2%**, with 39 of 49 public SWE skills yielding zero improvement and some degrading performance due to version-mismatched guidance. ([arXiv][2])

So the field is trying to solve three problems:

1. **How to generate useful skills automatically.**
2. **How to improve existing skills from execution evidence.**
3. **How to deploy skills without excessive token, time, or cost overhead.**

---

## B. Skill optimization: SkillOpt, SkillGrad, SkillMOO

**SkillOpt** targets the instability of loose self-revision. It treats a compact natural-language skill document as the trainable external state of a frozen agent, using scored rollouts, bounded add/delete/replace edits, validation gating, textual learning-rate budget, rejected-edit buffer, and epoch-wise slow/meta updates. ([arXiv][3])

**SkillGrad** targets unreliable, incomplete, or outdated skills. It explicitly casts a skill package as a structured parameter and uses trajectory-level loss evidence, text-based gradients, a momentum agent, and a patcher that applies layer-aware edits. ([arXiv][4])

**SkillMOO** targets a missing objective: accuracy is not enough. A skill can improve pass rate while increasing token cost or injecting misleading guidance. SkillMOO therefore treats a skill bundle as a **multi-objective search object**, optimizing pass rate and inference cost using LLM-proposed edits and NSGA-II Pareto selection. ([arXiv][5])

---

## C. Skill discovery / library construction: Trace2Skill, EvoSkill, SkillRL, CODESKILL

**Trace2Skill** targets the scalability problem of manual skill authoring. It turns many execution trajectories into transferable skill directories through parallel analysis and inductive consolidation. It emphasizes that skills generated from model parametric knowledge often miss operational pitfalls. ([arXiv][6])

**EvoSkill** targets automatic skill discovery from failures. It analyzes execution failures, proposes new skills or edits, materializes them into structured reusable skill folders, and uses a Pareto frontier of agent programs to retain useful skills. ([arXiv][7])

**SkillRL** targets the inefficiency of raw trajectory memory. It argues that memory methods store redundant, noisy traces, while agents need high-level reusable behavioral patterns. It builds a hierarchical **SkillBank** and lets the skill library co-evolve with the RL policy. ([arXiv][8])

**CODESKILL** targets coding-agent self-evolution. It reformulates skill extraction and skill-bank maintenance as a learnable management policy trained with RL, using both dense rubric-based skill-quality reward and sparse execution feedback from a frozen downstream agent. ([arXiv][9])

---

## D. Domain-grounded skill creation: SkillForge, SkillFoundry

**SkillForge** targets enterprise/cloud technical support. Its main claim is that generic skill creators are poorly aligned with real tickets and knowledge bases. It grounds initial skills in KBs and historical support tickets, then runs a failure-analyzer → diagnostician → optimizer loop. ([arXiv][10])

**SkillFoundry** targets scientific agents. It observes that procedural knowledge is fragmented across repos, APIs, notebooks, scripts, databases, documentation, and papers. It mines those resources, extracts operational contracts, builds skill packages with provenance/tests, and validates/refines the skill library. ([arXiv][11])

---

## E. Cold-start revision and verification: SkillRevise, CoEvoSkills

**SkillRevise** targets the cold-start case: you only have an initial imperfect LLM-authored skill, not many accumulated trajectories. It iteratively diagnoses defects from execution evidence, retrieves repair principles, applies execution-anchored edits, re-executes candidates, and keeps the best observed skill. ([arXiv][12])

**CoEvoSkills** targets autonomous construction of complex multi-file skill packages. It claims tool-evolution methods do not directly transfer to skills because skills are more complex. Its key mechanism is co-evolution between a Skill Generator and a Surrogate Verifier that provides feedback without ground-truth test access. ([arXiv][13])

---

## F. Runtime efficiency: SkillSmith

**SkillSmith** is not mainly about improving skill content. It targets deployment overhead. It argues that injecting raw skills causes irrelevant context injection and repeated skill-specific reasoning/planning. It compiles skills offline into boundary-guided runtime interfaces so the agent accesses only relevant components. It reports reductions of **57.44%** in solve-stage token usage, **42.99%** in thinking iterations, and **50.57%** in solve time on SkillsBench. ([arXiv][14])

---

## G. Methodological ancestors: TextGrad and GEPA

**TextGrad** is a general framework for “automatic differentiation via text.” It backpropagates LLM-provided textual feedback through components of a compound AI system. This is the ancestor of the “textual gradient” metaphor used by SkillGrad. ([arXiv][15])

**GEPA** is a reflective prompt optimizer. It samples trajectories, reflects on failures in natural language, proposes prompt updates, and uses Pareto selection. It is not a skill-specific system, but it is a strong baseline and conceptual neighbor for SkillOpt/SkillMOO-style natural-language optimization. ([arXiv][16])

---

# 2. How do they prove effectiveness?

The evidence pattern is highly similar across papers.

## A. Controlled evaluation conditions

Most compare:

[
\text{No Skill}
\quad vs \quad
\text{Human / Curated Skill}
\quad vs \quad
\text{One-shot LLM Skill}
\quad vs \quad
\text{Evolved / Optimized Skill}
]

Examples:

| Paper            | Evaluation strategy                                                                                                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SkillsBench**  | No skills vs curated skills vs self-generated skills across 86 tasks, 11 domains, 7 agent-model configurations, 7,308 trajectories. ([arXiv][1])                                                      |
| **SkillOpt**     | Six benchmarks, seven target models, three execution harnesses: direct chat, Codex, Claude Code; compared against human, one-shot LLM, Trace2Skill, TextGrad, GEPA, and EvoSkill skills. ([arXiv][3]) |
| **SkillGrad**    | SpreadsheetBench Verified and WikiTableQuestions; two backbone LLMs; ablations for momentum and contrastive diagnosis. ([arXiv][4])                                                                   |
| **Trace2Skill**  | Office workflows, math reasoning, vision QA; transfer across model scales, model families, and OOD settings. ([arXiv][6])                                                                             |
| **SkillMOO**     | SkillsBench SE tasks; optimizes both pass rate and inference cost; reports pass-rate gains and cost reductions. ([arXiv][5])                                                                          |
| **SkillSmith**   | SkillsBench; reports token usage, thinking iterations, solve time, and monetary cost reductions. ([arXiv][14])                                                                                        |
| **SkillForge**   | Five real-world cloud-support scenarios, 1,883 tickets, 3,737 tasks; compares domain-grounded vs generic skill creation and iterative refinement. ([arXiv][10])                                       |
| **SkillFoundry** | MoSciBench plus genomics tasks; measures novelty/internal validity and downstream performance improvement. ([arXiv][11])                                                                              |
| **CODESKILL**    | EnvBench, SWE-Bench Verified, Terminal-Bench 2; compares no-skill, prompt/memory baselines, and learned skill bank. ([arXiv][9])                                                                      |
| **Socratic-SWE** | SWE-bench Verified, SWE-bench Lite, SWE-bench Pro, Terminal-Bench 2.0; compares under same compute budget and reports 50.40% on SWE-bench Verified after three iterations. ([arXiv][17])              |

---

## B. Validation gates and deterministic verifiers

A major methodological trend is: do not trust LLM self-evaluation alone.

SkillOpt accepts an edit only if it strictly improves a held-out validation score. ([arXiv][3]) SkillsBench and SWE-Skills-Bench both emphasize deterministic verifiers or execution-based checks. ([arXiv][1]) SkillRevise re-executes candidate skills and retains the version with best empirical utility. ([arXiv][12])

This is one of the strongest shared methodological commitments.

---

## C. Ablation studies

The stronger papers also prove mechanism-level usefulness:

* SkillGrad ablates **momentum** and **contrastive diagnosis**. ([arXiv][4])
* SkillMOO analyzes actual edit types and finds pruning/substitution dominate successful edits. ([arXiv][5])
* SkillSmith isolates runtime effects: token usage, thinking iterations, latency, and cost. ([arXiv][14])
* SkillOpt uses multiple harnesses and transfer settings to argue the learned skill artifact is not just overfitting one execution environment. ([arXiv][3])

---

# 3. Are there conflicts among these projects?

Yes, but most are **scope conflicts**, not direct contradictions.

## Conflict 1: “Skills help a lot” vs “skills barely help in SWE”

SkillsBench reports a strong average benefit from curated skills: **+16.2 pp**. ([arXiv][1])
SWE-Skills-Bench reports only **+1.2% average gain** in real-world software-engineering settings, with many public SWE skills giving no gain. ([arXiv][2])

This is not necessarily a contradiction. It says:

[
\text{Skill utility}
====================

f(\text{domain fit},\ \text{skill quality},\ \text{version match},\ \text{retrieval},\ \text{context budget},\ \text{verifier quality})
]

The conflict is important: **skills are not automatically useful**. They are useful only when well-scoped, current, and compatible with the task/harness.

---

## Conflict 2: “Generate skills autonomously” vs “self-generated skills do not help”

SkillsBench reports that self-generated skills provide no average benefit. ([arXiv][1])
CoEvoSkills, SkillRevise, SkillOpt, SkillGrad, Trace2Skill, and CODESKILL all claim autonomous or semi-autonomous skill generation/revision can work.

The reconciliation is that these later systems are not simple one-shot generation. They add:

[
\text{execution evidence}
+
\text{diagnosis}
+
\text{revision}
+
\text{validation gate}
+
\text{selection}
]

So the consensus is not “LLMs can write skills from scratch.” It is closer to:

> LLMs can improve or generate skills when constrained by trajectories, verifiers, and held-out validation.

---

## Conflict 3: “More skill knowledge” vs “less context is better”

SkillFoundry and SkillRL build larger skill libraries. ([arXiv][11])
SkillMOO and SkillSmith show that pruning, selective access, and cost-aware deployment matter. ([arXiv][5])

The practical resolution:

[
\text{Large offline library} \neq \text{large runtime context}
]

A production system should mine/build a broad skill library offline, but retrieve, compile, or inject only a minimal task-relevant subset at runtime.

---

## Conflict 4: Skill-as-optimizer vs skill-as-memory

SkillOpt and SkillGrad frame the skill artifact like a parameter being optimized. ([arXiv][3])
SkillRL and Trace2Skill frame skills as distilled experience/memory. ([arXiv][8])

These are compatible but emphasize different axes:

| View                     | Main object                               | Main risk                       |
| ------------------------ | ----------------------------------------- | ------------------------------- |
| Optimization view        | A compact skill parameter (\theta)        | Overfitting validation set      |
| Memory/distillation view | A library of reusable behavioral patterns | Retrieval noise / context bloat |
| Compiler view            | Minimal runtime interface                 | Losing useful nuance            |
| Benchmark view           | Skill marginal utility                    | Dataset/harness dependence      |

---

# 4. Significant consensus across the papers

## Consensus 1: Skills are an external adaptation layer for frozen agents

Most papers avoid weight updates. The agent model stays frozen, while skills are edited, selected, retrieved, compiled, or evolved. This is attractive for closed models, production systems, and fast iteration.

## Consensus 2: Raw trajectories are valuable but too noisy

Trace2Skill, SkillRL, CODESKILL, Socratic-SWE, and SkillGrad all treat trajectories as learning signal, but not as something to dump directly into context. The recurring pattern is:

[
\text{trajectory}
\rightarrow
\text{diagnosis}
\rightarrow
\text{abstracted procedure}
\rightarrow
\text{validated skill}
]

## Consensus 3: One-shot skill generation is weak

SkillsBench’s result is the clearest: self-generated skills do not help on average. ([arXiv][1]) The newer papers mostly respond by adding iterative execution-grounded refinement rather than relying on one-shot generation.

## Consensus 4: Verifiers and held-out validation are essential

The field is converging on execution-based or deterministic evaluation. LLM reflection is used to propose edits, but empirical scoring decides whether the edit survives.

## Consensus 5: Small, focused skills are often better than comprehensive docs

SkillsBench reports focused skills with 2–3 modules outperform comprehensive documentation. ([arXiv][1]) SkillMOO’s edit analysis similarly finds pruning and substitution are major successful operations. ([arXiv][5]) SkillSmith further argues raw skill injection wastes tokens and repeated reasoning. ([arXiv][14])

## Consensus 6: Transfer is possible but conditional

Trace2Skill reports transfer across model scales, model families, and OOD settings. ([arXiv][6]) SkillRevise reports cross-model transferability. ([arXiv][12]) SkillOpt reports transfer across model scales and execution environments. ([arXiv][3]) But SWE-Skills-Bench warns that version mismatch and context incompatibility can harm performance. ([arXiv][2])

---

# 5. Similarities in implementation

Most implementations look like the following pipeline:

```text
skill_init/
  SKILL.md
  examples/
  scripts/
  tests/
  metadata.json

loop:
  1. Select training tasks
  2. Run agent with current skill
  3. Save trajectory logs
  4. Score with verifier / tests / evaluator
  5. Diagnose failures with an LLM critic
  6. Propose skill edits or new skills
  7. Apply bounded patch
  8. Re-run validation
  9. Accept, reject, or keep on Pareto frontier
 10. Export best skill / skill bank / compiled interface
```

The shared components are:

| Component         | Common name variants                                                             |
| ----------------- | -------------------------------------------------------------------------------- |
| Solver / executor | agent runner, task solver, downstream agent                                      |
| Skill artifact    | `SKILL.md`, skill folder, skill package, skill bundle, SkillBank                 |
| Trace store       | trajectory logs, rollouts, execution evidence                                    |
| Critic            | failure analyzer, diagnostician, textual-gradient generator, reflection agent    |
| Editor            | optimizer, patcher, skill generator, skill reviser                               |
| Gate              | verifier, validation score, deterministic test, held-out score, Pareto selection |
| Memory            | rejected-edit buffer, momentum memory, principle memory, SkillBank               |
| Deployment layer  | skill retriever, skill compiler, runtime interface                               |

The main differences are in **what gets optimized**:

| Project          | Optimized object                                                  |
| ---------------- | ----------------------------------------------------------------- |
| **SkillOpt**     | One compact skill document with bounded edits                     |
| **SkillGrad**    | Structured skill package with textual gradients and momentum      |
| **Trace2Skill**  | Unified skill directory distilled from many trajectories          |
| **EvoSkill**     | Skill folders / agent programs selected by Pareto frontier        |
| **SkillRL**      | Hierarchical skill library co-evolving with RL policy             |
| **SkillMOO**     | Skill bundle under pass-rate/cost Pareto objectives               |
| **SkillSmith**   | Compiled runtime interface, not primarily the skill content       |
| **SkillForge**   | Domain-grounded enterprise support skills                         |
| **SkillFoundry** | Scientific skill libraries mined from heterogeneous resources     |
| **SkillRevise**  | Cold-start LLM-authored skill revision                            |
| **CODESKILL**    | Skill extraction and maintenance policy for coding agents         |
| **Socratic-SWE** | Trace-derived skills used to generate adaptive SWE training tasks |

---

## My synthesis

The field is converging toward this principle:

[
\boxed{
\text{LLM agent improvement}
\approx
\text{frozen model}
+
\text{validated external procedural state}
+
\text{trajectory-driven update loop}
}
]

The strongest practical lesson is:

> Do not just “add skills.” Treat skills like software artifacts: version them, test them, prune them, validate them on held-out tasks, and monitor token/runtime cost.

For implementation, the most reusable architecture would combine:

1. **Trace2Skill / SkillGrad** for trajectory-to-edit diagnosis.
2. **SkillOpt** for validation-gated bounded updates.
3. **SkillMOO** for cost-aware Pareto selection.
4. **SkillSmith** for minimal runtime injection.
5. **SkillsBench / SWE-Skills-Bench style verifiers** for controlled evaluation.

[1]: https://arxiv.org/abs/2602.12670 "[2602.12670] SkillsBench: Benchmarking How Well Agent Skills Work Across Diverse Tasks"
[2]: https://arxiv.org/abs/2603.15401 "[2603.15401] SWE-Skills-Bench: Do Agent Skills Actually Help in Real-World Software Engineering?"
[3]: https://arxiv.org/abs/2605.23904 "[2605.23904] SkillOpt: Executive Strategy for Self-Evolving Agent Skills"
[4]: https://arxiv.org/abs/2605.27760 "[2605.27760] SkillGrad: Optimizing Agent Skills Like Gradient Descent"
[5]: https://arxiv.org/abs/2604.09297 "[2604.09297] SkillMOO: Multi-Objective Optimization of Agent Skills for Software Engineering"
[6]: https://arxiv.org/abs/2603.25158 "[2603.25158] Trace2Skill: Distill Trajectory-Local Lessons into Transferable Agent Skills"
[7]: https://arxiv.org/abs/2603.02766?utm_source=chatgpt.com "EvoSkill: Automated Skill Discovery for Multi-Agent Systems"
[8]: https://arxiv.org/abs/2602.08234 "[2602.08234] SkillRL: Evolving Agents via Recursive Skill-Augmented Reinforcement Learning"
[9]: https://arxiv.org/abs/2605.25430 "[2605.25430] CODESKILL: Learning Self-Evolving Skills for Coding Agents"
[10]: https://arxiv.org/abs/2604.08618 "[2604.08618] SkillForge: Forging Domain-Specific, Self-Evolving Agent Skills in Cloud Technical Support"
[11]: https://arxiv.org/abs/2604.03964 "[2604.03964] SKILLFOUNDRY: Building Self-Evolving Agent Skill Libraries from Heterogeneous Scientific Resources"
[12]: https://arxiv.org/abs/2606.01139 "[2606.01139] SkillRevise: Improving LLM-Authored Agent Skills via Trace-Conditioned Skill Revision"
[13]: https://arxiv.org/abs/2604.01687 "[2604.01687] CoEvoSkills: Self-Evolving Agent Skills via Co-Evolutionary Verification"
[14]: https://arxiv.org/abs/2605.15215 "[2605.15215] SkillSmith: Compiling Agent Skills into Boundary-Guided Runtime Interfaces"
[15]: https://arxiv.org/abs/2406.07496 "[2406.07496] TextGrad: Automatic \"Differentiation\" via Text"
[16]: https://arxiv.org/abs/2507.19457 "[2507.19457] GEPA: Reflective Prompt Evolution Can Outperform Reinforcement Learning"
[17]: https://arxiv.org/abs/2606.07412 "[2606.07412] Socratic-SWE: Self-Evolving Coding Agents via Trace-Derived Agent Skills"
