---
name: implementation-plan
description: Work with the user to write a codebase-grounded implementation plan for another coding agent to complete the full requested change. Explicit user invocation only.
disable-model-invocation: true
---

# Implementation plan

Use this skill only when the user explicitly invokes it. Treat the request supplied after `/skill:implementation-plan`, or alongside `$implementation-plan`, as the change to plan. If no request is supplied, ask what the user wants to change before proceeding.

Your deliverable is a Markdown document that another coding agent can follow without this conversation. Work with the user to decide what should be built and how it fits the existing codebase. Do not implement the change during this skill. Limit edits to the plan document unless the user separately authorizes other work.

## Completion objective

Plan to implement the entire agreed request at the user's chosen quality level, or the fullest achievable result where a concrete blocker prevents completion. The objective is NOT a phased rollout or a foundation that leaves required behavior for later. Do not substitute an MVP or proof of concept for a production request. If the user explicitly wants an experiment or quick test, completing that experiment is the full objective.

- Ordered implementation steps are allowed and useful. They describe dependencies within one complete implementation, not separate delivery phases or optional stopping points.
- Include all work needed to make the change usable end to end, including integration, migration, removal of superseded code, tests, and documentation where applicable.
- Do not defer required work because it is difficult, large, or crosses module boundaries. Do not silently narrow the request to fit a session.
- Distinguish user-approved exclusions from unresolved requirements. If something cannot be completed, name the blocker, its impact, and what would unblock it. Keep the missing behavior visible rather than calling the reduced result complete.
- Include deployment or recovery precautions when necessary for safety. They must not replace the full implementation objective with a rollout roadmap. Ask the user about constraints that conflict with full delivery.

## Work with the user

### Understand the request

Restate the desired outcome and extract the requirements, constraints, and observable success criteria from the supplied prompt. Preserve the user's intent. Do not invent adjacent features.

Ask about ambiguity that changes the outcome or makes investigation impossible. Otherwise, inspect the repository before asking technical questions the code can answer. Do not ask the user to repeat information already supplied.

### Establish the quality level

If the user has not specified the intended quality level, ask early, before settling the design or depth of the plan. Do not infer it from the size of the change or words such as "simple."

Use `ask_user` when available to ask "What quality level should this change target?" with these options and room for a different answer:

- Experiment or quick test. Prove a specific idea with limited scope and focused validation.
- Production change. Deliver a maintainable, supported change with thorough validation and operational considerations.

If the user already specified the level, acknowledge it without asking again. Clarify conflicting expectations rather than silently choosing a level.

For an experiment, establish what it should prove, how success will be measured, where it will run, and which shortcuts the user accepts. Keep questioning and investigation focused on those needs. Record limitations and any isolation or cleanup required. Experimental quality does not waive data safety, security, or the need to complete the agreed behavior.

For production, use more thorough questioning and deliberation. Investigate first where the repository can supply answers, then work through consequential gaps with the user in small batches. As relevant to the change, establish:

- Expected behavior, edge cases, failure handling, and recovery.
- Affected users and consumers, compatibility promises, and migration constraints.
- Security, privacy, permissions, and data integrity requirements.
- Expected load, performance and reliability requirements, and how to measure them.
- Operational visibility, support responsibilities, and safe deployment or recovery needs.
- Test coverage and the evidence required to accept the change as production-ready.

Challenge assumptions, compare meaningful alternatives, and explain the costs of the recommended approach. Resolve material risks and trade-offs explicitly before marking the plan ready. Avoid an exhaustive questionnaire about concerns that do not apply.

The quality level changes the required rigor and agreed acceptance bar, not the requirement to finish the full agreed scope. If investigation reveals that an experiment could affect production systems or real user data, raise that with the user and agree on safeguards before proceeding.

### Investigate the existing codebase

Read repository guidance, relevant documentation, and the current working-tree status. Preserve unrelated work. Trace the current behavior through entry points, implementation, callers, data storage, configuration, and tests as relevant to the request.

Determine:

- What already works and can be reused unchanged.
- What is partially implemented, disconnected, or missing.
- What must be extended, replaced, migrated, or deleted.
- Which existing conventions and constraints the implementation must follow.
- Which tests cover the behavior, which gaps remain, and how validation runs.

Support findings with repository-relative paths and relevant symbols. Distinguish observed facts from proposals and assumptions. Mark proposed new paths as new. Do not infer that something is absent just because one search did not find it. If relevant code or dependencies are unavailable, record the investigation limit.

### Discuss choices and blast radius

Present the findings that affect the user's decisions. When meaningful alternatives exist, give concrete options, explain their trade-offs, and recommend one based on the request and codebase. Do not manufacture alternatives for settled or trivial choices.

Ask focused questions in small batches and wait for answers before settling consequential choices. Use `ask_user` when available, with concrete options and room for a different answer. Explain what each choice changes. Revisit the code when an answer changes the design.

Assess blast radius beyond the files directly edited. Where relevant, inspect shared callers, public APIs, user workflows, persisted data, schema compatibility, configuration defaults, permissions, security and privacy, external integrations, performance, operations, and downstream consumers. For each material risk, state:

- Who or what is affected and through which dependency.
- The possible breakage or behavior change.
- The mitigation and how to verify it.
- Whether the user must approve a breaking change, destructive operation, or compatibility trade-off.

Do not use a generic risk checklist as a substitute for investigation. If no material blast radius is found, say what you checked and what remains uncertain.

Record decisions and their reasons as the conversation progresses. Resolve scope, behavior, architecture, and compatibility questions before declaring the plan ready. Do not hide unresolved decisions in instructions such as "choose an approach during implementation."

### Draft and review the document

Use the repository's existing plan location and naming convention. If none exists, propose `docs/plans/<short-request-name>.md` in the target repository. This output path is relative to that repository, not the skill directory. Respect a user-specified location and do not overwrite an unrelated document.

Write a draft once there is enough evidence to make it useful. Review the proposed outcome, approach, and material risks with the user, then revise the document from their feedback. Label it as a draft until the user approves it. If the user stops before decisions are resolved, save the useful work with explicit blockers rather than pretending it is ready.

## Document contents

Keep detail proportional to the change, but cover each item below. Write concrete instructions, not generic advice or a transcript of the discussion.

### Status and context

Include the plan's draft or approved status, the original request, the agreed interpretation, and the repository baseline inspected. Note relevant uncommitted changes and assumptions the implementing agent must recheck. Never claim approval the user has not given.

### Outcome and scope

Describe the complete target behavior, chosen quality level, constraints, and user-approved exclusions. State the agreed quality bar and any accepted experimental shortcuts or limitations. Do not describe an experiment as production-ready. Include an explicit instruction to the implementing agent:

> Implement the full agreed change described in this document. The steps are an execution order, not a phased rollout. Do not stop at a partial foundation or defer required behavior. If blocked, complete independent work where safe and report the exact remaining gaps without claiming completion.

### Current behavior and gap analysis

Map each requirement to what exists today and what remains to be implemented or reworked. Cite paths and symbols so the next agent can verify the findings without repeating broad discovery.

### Agreed design and decisions

Describe the selected approach, responsibilities, interfaces, data flow, and relevant edge cases or failure behavior. Include alternatives rejected for material reasons and the user's decisions. Specify compatibility and migration behavior where applicable.

### Blast radius and precautions

Document affected consumers, behavior changes, risks, mitigations, and approvals still needed. Include recovery constraints for destructive or irreversible changes. Planning approval alone does not authorize production operations or data destruction.

### Implementation instructions

Provide dependency-ordered tasks covering the complete change. For each task, identify the files or symbols to change or create, the required behavior, dependencies, and a concrete completion check. Include updates to callers, wiring, configuration, data, tests, and docs as needed. Account for removal of obsolete paths and temporary compatibility code rather than leaving competing implementations behind.

Avoid speculative line-by-line patches. Be precise about contracts and behavior while leaving routine coding details to the implementing agent. Instruct that agent to recheck the repository before editing and raise material conflicts with the plan instead of silently changing scope.

### Validation and acceptance

Give observable acceptance criteria for every requirement and map them to tests or other checks. Include relevant happy paths, failure paths, edge cases, and regression coverage for affected consumers. Specify actual repository commands and expected outcomes where verified. Clearly label proposed tests, unverified commands, environment prerequisites, and checks that require user involvement.

Separate checks already run during planning from checks the implementing agent must run. Match validation to the agreed quality level. An experiment needs evidence that answers its stated question. A production change needs evidence for the applicable correctness, regression, security, reliability, and operational requirements agreed with the user. The completion checklist must establish end-to-end behavior, not just successful compilation or the presence of new files.

### Open questions and blockers

List unresolved questions, assumptions awaiting confirmation, external dependencies, and any unavoidable gaps. For each, state its impact and the decision or evidence needed to resolve it. Write "None" if there are none. A plan with unresolved consequential decisions is not ready for implementation.

## Final check and handoff

Before handing off, check that every requested behavior maps to implementation work and acceptance criteria. Look for missing integration, migration, cleanup, or regression work. Remove implicit deferrals, contradictory decisions, and references that require access to this conversation.

Save the document and give the user its path, its approval/readiness status, and any remaining decisions. Stop after the planning handoff. Do not start implementation automatically.
