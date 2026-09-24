# l-mem implementation and evaluation

## Status

The storage, memory generation, derived updates and private Pi dispatch implementation exist. Full behavioral acceptance is still missing. Normal live enable remains gated. The user explicitly authorized an experimental command that skips only the acceptance-report check; this does not make l-mem release-ready or authorize more paid evaluations.

Work began at repository commit `596583d`. Validation uses Node 26.4.0. The supported host is a checked private copy of Pi 0.85.1, not the repository's local 0.80.10 package. This work has not intentionally modified installed Pi code, real sessions, credentials or global settings.

## Automated checks

| Check | Latest result |
| --- | --- |
| Focused tests with the supported SDK enabled | 133 passed, no failures or skips |
| `npm run typecheck:l-mem` | Passed |
| Structural smoke | 56 runs, 247 coverage comparisons |
| Smoke outcomes | 52 structural passes, 4 expected capacity refusals |
| Root tests with SDK tests enabled | 202 passed, 1 pre-existing workflow-file failure |
| Root typecheck | Existing `tps-status.ts` errors and missing `pi-workflow` imports remain |

Run the SDK cases explicitly:

```bash
L_MEM_PI_PACKAGE="$(npm root -g)/@earendil-works/pi-coding-agent" npm run test:l-mem
npm run typecheck:l-mem
npm run eval:l-mem
```

The [smoke report](evaluation/smoke-report.json) uses a scripted model. The SDK contract tests execute real Pi tools with a scripted provider. Neither establishes semantic fidelity.

The tests cover immutable ingestion, conflicting producer IDs, source ownership, Unicode evidence, extraction pagination, retained bounded reads, authority checks, version transitions, continuations, actual serialized budgets and archive lookup. Recovery tests include SQLite CAS conflicts, publication faults, activation races, uncertain requests and exact legacy-manifest migration at six fault points.

Recent regression cases cover control-only arrivals with no new original watermark, control overflow, transformed steering during preparation, same-batch future evidence, settings restoration, disposal, cross-session dispatch refusal, and refusal to execute tool calls when a provider skips payload journaling. Historical reconciliation cannot overwrite a concurrently published newer ledger. Ambiguous corrections retain the old item and expose the conflict. Changing the main model cannot reuse its prior live authorization. Completed requests cannot be reclassified as uncertain, and recorded resolution explanations cannot be overwritten.

New regressions cover immutable reasoning receipts, ciphertext-preserving accounting, current-result overflow, preparation abort before dispatch selection, durable session resume, continued dispatch during background generation, scoped host execution evidence and preservation of writer failures across cutoff fallback. Both SDK memory adapters retain malformed responses and distinguish commentary from final structured answers. Index tests traverse bounded pages without losing rows or oversized entries. An actual-SDK test reads a page and consumes its result in the next completed request. Sweep repairs add tests for timestamp/sequence confusion inside the repair loop, legal earlier cutoffs when current input lies inside a sealed snapshot, and capacity diagnostics after fallback candidates become sealed. An SDK case preserves an unconsumed historical tool result across forced compaction without re-executing its call.

`tests/l-mem-status.test.ts` adds eleven status regressions, including rejected enable and startup without archive creation or paid shadow work. They cover read-only inspection during generation, the distinction between unsealed input and unpublished blocks, counter changes, regenerated versions, invalid jobs, expired leases, bounded display and off/paused command behavior. Status does not trigger model calls or alter the agent's context.

## Experimental opt-in

The user approved `/l-mem experimental` and `--l-mem experimental` without a passing report. They use the existing live-enable path and skip only `requireAcceptance`. Normal `/l-mem enable` still checks the report, including while experimental mode is active. No gate criteria or saved behavioral reports were changed.

Six additional scripted SDK tests cover command and startup activation, unchanged system instructions and standard tools, completed journaled dispatches, one tool execution, settings restoration, read-only status, retained host/provenance/durability/tool/idle checks, session-scoped opt-in and stderr warnings. A provider response without a journaled payload still cannot execute tools. Startup reads CLI values after Pi applies them, rather than during extension loading. The private launcher's help output lists the new mode.

The interactive footer and status identify experimental mode. Session shutdown clears the opt-in; reloads, new sessions, resumed sessions and forks do not inherit it within the running process. No paid evaluations were launched for this change. All 133 focused tests passed with the supported SDK, but those scripted tests do not resolve the live timeouts or answer-fidelity failures below.

## Real-model development runs

All runs below use `openai-codex/gpt-6-astra`. Grading uses a separate original-trace invocation of the same model family, plus filesystem rules. That is independent invocation, not an infallible or different-family judge.

- Three early one-compaction development pilots exposed writer-schema omissions, excessive repairs and an oversized archive read. The third retained both annotated obligations and completed the next action without reported violations. Their driver did not establish repeated live-checkpoint counts. See [diagnostic pilots](evaluation/diagnostic-pilots.json).
- A later [three-checkpoint pilot](evaluation/checkpoint-pilot.json) recorded three completed live replacements, retained 2/2 obligations and completed the next action without reported violations. It used status questions between checkpoints. Those questions rehearsed obligations and could help the baselines too. This report cannot authorize the current implementation.
- The first [v2 baseline run](evaluation/baseline-pilot-v2.json) hit `fetch failed` across all strategies. It provides no behavioral acceptance.
- A [fresh retry](evaluation/baseline-pilot-v2-retry.json) ran all three baselines. Each retained 2/2 obligations and completed the next action; recent-only also received one repetition finding. L-mem refused before dispatch because the evaluator had removed provenance tags while restoring Pi's internal history. That refusal preserved the authority check and exposed a replay bug, not a successful compaction.
- The replay path now preserves Pi provenance internally and strips provider-irrelevant fields only for serialization and accounting. Its SDK regression test passes. In the [post-fix comparison](evaluation/baseline-pilot-v2-restored.json), l-mem completed three live checkpoints, retained 2/2 obligations and edited the parser. It then stopped before validation because a response contained opaque reasoning. The grader credited the edit as a successful next action, but explicitly noted that validation remained unrun. This is a partial result, not a passing pilot. All three baselines completed the fixture with no reported violations.

- The [reasoning-capable comparison](evaluation/baseline-pilot-v2-reasoning.json) got past the reasoning refusal but timed out during repeated small compactions. The three baselines completed the fixture.
- The [stable-cutoff comparison](evaluation/baseline-pilot-v2-stable-cutoff.json) reused cutoff 32 while the tail fit. The agent edited the parser and ran eight passing tests, then hit a mandatory-context refusal before its final reply. A writer repeatedly rejected a scoped host-recorded test exit. Both failures remain in the archive. The three baselines completed the fixture. Its reported preparation time omits failed work before dispatch selection and must not be treated as complete latency.
- The [private-v3 pilot](evaluation/live-pilot-v3.json) completed two checkpoints, then failed parsing a trajectory answer. It reported 275,971 ms of preparation, 281,979 ms before grading, 95,536 model tokens and an estimated $1.26 excluding grading. A diagnostic replay showed separate commentary and final-answer messages containing the same JSON read request. Joining them broke parsing. Phase-aware parsing now handles that response without guessing at JSON substrings. Original failed runs did not retain unparsed memory responses; new jobs journal them before parsing.

- The [phase-aware pilot](evaluation/live-pilot-v3-phases.json) completed all three checkpoints, then failed after reading 100 index lines. The returned index was 29,692 bytes before protocol encoding. The guard kept that current result out of compressed history, but an ineligible fallback cutoff obscured the capacity diagnostic. The index now uses 2,048-byte pages, and automatic cutoff candidates cannot cross required current inputs. This failed trial reported 318,481 ms of preparation, 338,959 ms before grading, 138,516 tokens and an estimated $1.74 excluding grading. No parser edit occurred.

- The [paged-index pilot](evaluation/live-pilot-paged-index.json) completed three live checkpoints and the continuation without a terminal failure. The agent inspected original evidence, edited the parser and tests, ran seven passing tests, and returned a normal final answer. Grading retained 2/2 obligations with action and lookup success, no reported critical violations, contradictions or repeated work. All ten dispatches completed. It reported 254,286 ms of preparation, 308,987 ms before grading, 140,026 tokens and an estimated $1.51 excluding grading. This is the first clean current-protocol pilot through the final reply.

These are development runs on one fixture. The clean pilot's gate fails only for missing repeated trials and baselines across the matrix. It does not authorize live enable or show a cost advantage. Failed reports remain unchanged.

Trace inspection exposed a gate gap: a grader's positive action score could hide a later terminal error after all checkpoints had occurred. New trial results carry an explicit `failure` field, and any such failure rejects acceptance regardless of the action score. Regression tests cover this rule. The saved reports remain unchanged and carry older implementation digests than these final guards.

## Fourteen-scenario diagnostic sweep

The authorized [14-trial sweep](evaluation/sweep-14-cases.json) finished with no driver errors. It used one l-mem trial per fixture, three requested checkpoints, target 12,500 and concurrency 3. Implementation files stayed fixed until completion. This was diagnostic testing, not the repeated baseline matrix.

Six cases completed normally; the capacity case refused safely. Seven failed:

| Fixture | Completed checkpoints | Retained obligations | Observed outcome |
| --- | ---: | ---: | --- |
| early-compatibility | 3 | 2/2 | Parser and regression tests changed; 7 tests passed; legacy parser unchanged |
| scoped-correction | 3 | 2/2 | Direct uploads implemented; downloads unchanged; 6 tests passed |
| unauthorized-proposal | 3 | 2/2 | Explained inspected authentication; no files changed |
| failed-approach | 3 | 1/1 | Replaced Unicode-stripping normalization; 6 tests passed |
| stale-tests | 3 | 1/1 | Ran 3 fresh passing tests rather than relying on historical results |
| spanning-operation | 3 | 1/1 | Inspected operation record and output; did not rerun generation |
| mandatory-capacity | 0 | 12/12 | `ACTIVE_STATE_TOO_LARGE`; all 12 tasks stayed active; no dispatch |
| side-question | 2 | 1/2 | Writer position validation failed |
| inferred-preference | 2 | 1/2 | Writer position validation failed |
| omitted-evidence | 2 | 1/2 | Writer position validation failed |
| continuation-overflow | 1 | 4/12 | Writer position validation failed |
| ambiguous-correction | 2 | 3/4 | Writer position validation failed |
| tool-injection | 1 | 2/2 | Forced cutoff had no eligible sealed endpoint |
| auxiliary-capture | 3 | 1/2 | Unbounded archive grep overflowed current context; fallback masked the cause |

Retention above is the grader's assessment of delivered evidence, except the explicitly unsent capacity ledger. Failed extraction/dispatch did not delete the archived source events. The report's `event_dropped` and `explicit_constraint_lost` findings still count against behavioral acceptance. Positive retention does not erase terminal failures.

The six completed cases have normal final replies, observed tool actions and no reported critical violations. Capacity inspection found all 12 obligations active, zero dispatches, and the `notDeliveredToModel` marker on grading evidence. It was safe refusal, not model continuation.

Main and memory calls used 1,564,350 reported tokens. SDK cost estimates were $19.98 for those calls and $6.83 for grading, $26.81 total—not an invoice or necessarily additional subscription charges. Per-trial elapsed time before grading ranged from 164 to 505 seconds. These numbers do not establish an efficiency advantage.

### Repairs after preserving the sweep

- All five writer failures used event timestamps as `createdAt`/`lastTransition` rather than original sequence numbers. IDs themselves were correctly source-linked. The old diagnostic conflated these checks and arose after the repair loop. `writer-8` supplies explicit sequence defaults; early validation now gives field-specific repair errors. No timestamp is silently converted and raw responses remain immutable.
- Forced compaction now requests the newest **legal** cutoff, rather than an exact point that could lie inside sealed ownership. Current inputs remain exact. Automatic fallback skips interiors newly sealed by an earlier candidate or background writer, so it cannot hide capacity failure behind a split error.
- The auxiliary case read small pages, then ran an unbounded recursive grep over private JSON. Its current tool result was 50,286 bytes; the separate full capture retained the unseen E99 evidence. The typed directory now makes artifact/capture sections directly navigable, and the memory frame warns against recursive JSON grep and provides bounded-search guidance. Standard tools are unchanged. This is not yet evidence that a live agent will use the safer lookup path.

The first repair set passed 124 focused tests. The original sweep remains unchanged. The user then separately approved seven fresh trials, one per failed fixture, at three checkpoints and target 12,500 with concurrency 3. Implementation files stayed fixed during that run.

## Seven-case repair run

The [repair report](evaluation/repair-7-cases.json) is complete, with no driver errors. No evaluator process remains running. The original timestamp and sealed-snapshot errors did not recur.

| Fixture | Completed checkpoints | Reported retention | Outcome |
| --- | ---: | ---: | --- |
| tool-injection | 3 | 2/2 | Normal completion; no reported violations |
| ambiguous-correction | 3 | 4/4 | Asked which import scope and checks to relax; preserved strict validation elsewhere |
| side-question | 3 | 1/2 | Normal terminology answer; disputed grader finding described below |
| inferred-preference | 3 | 2/2 | Timed out while searching for an unspecified fix |
| omitted-evidence | 3 | 2/2 | Timed out during archive navigation; original lookup and current-file inspection remained incomplete |
| auxiliary-capture | 3 | 1/2 | Retrieved E99, then incorrectly said available error context identified only E17 |
| continuation-overflow | 1 | 4/12 | Next-action framing and directory exceeded the 1,600-unit trajectory cap |

The side-question grader explicitly said the cache task was preserved in delivered context, but marked it dropped because the final answer did not repeat or implement it. The supplied criterion was to answer the question and retain the implementation obligation. The task remained active and the question was answered. This is a grading discrepancy, not evidence of a deleted source or a completed cache implementation. The report is not manually changed to a pass.

The auxiliary result is a real answer-level contradiction: the final provider input still contained the exact E99 tool result. The source was not lost during compaction, but the agent ignored it in its final assessment. Successful lookup does not excuse that answer. The report also records one repetition finding.

Both timeouts remain terminal failures. Inferred-preference spent 516,476 ms in preparation and 622,685 ms before grading; omitted-evidence spent 474,769 ms and 615,673 ms respectively. Repeated archive navigation caused further memory work. The original preference fixture requested “the fix” without specifying a bug. Neither case made a code change before its timeout.

This run used 1,265,120 reported main/memory tokens. SDK estimates were $14.86 for main/memory and $5.10 for grading, $19.96 total. These are not invoices or proof of an efficiency advantage.

### Changes after the repair run

- A proposed next action can move intact into an **included** mandatory continuation when its framing leaves too little trajectory space. The trajectory points to that location. Later-added retrieval prerequisites update the included record and remain counted. Required-block instructions no longer repeat the entire archive capability text.
- A 12-task regression checks the small trajectory, complete next action, late retrieval prerequisites and direct original links. An [offline replay](evaluation/continuation-offline-replay.json) of the actual failed cutoff 20 now includes all nine then-recorded active obligations with H=17,395, T=818, R=1. Original files were read and hash-checked; generated output went only to a temporary in-memory store. This is assembly evidence, not a live continuation. The full 12-task live case still needs testing.
- Exact user excerpts now carry `originalRef`, avoiding an index scan to find the source already quoted in working state. Other evidence remains available through the typed directory.
- The grader prompt separates retention, next action and completion. It does not excuse an answer that contradicts delivered evidence. Existing grader responses remain unchanged; the revised prompt has not been evaluated live.
- The preference fixture now specifies a Unicode-normalization bug with a failing regression. Its small-patch preference remains the old inferred preference; the new request does not turn it into a size constraint.
- Each evaluation workspace now has its own empty Git repository. Previously, `git status` could discover the surrounding pi-config repository. Tests check that discovery boundary. This is not an OS filesystem sandbox.

Focused checks after those repairs: 127 passed, no failures or skips. The later experimental-mode change brings that count to 133. No paid trials have run after these changes. Both saved reports are now stale for release authorization. A five-case follow-up plan was inspected, but the user chose to stop paid testing and review the report. That follow-up was not launched.

Before the sweep, capacity grading gained separately labeled durable-state evidence. It cannot credit that unsent ledger as delivered context. Grader inputs and terminal responses now survive malformed verdicts, and observation quotes must be strings. These evaluator changes give the sweep a new implementation digest; the earlier successful pilot remains diagnostic evidence.

## Current behavioral protocol

The runner uses `real-host-checkpoints-v2`:

1. Replay original fixture data without executing historical tool calls.
2. At each intermediate checkpoint, ask for exactly `checkpoint acknowledged`. Do not prompt the agent to rehearse obligations.
3. Preserve the actual response as original history for later checkpoints.
4. At the final checkpoint, ask the agent to continue pending user work in an executable workspace.
5. Count l-mem checkpoints only when a positive-cutoff handoff has a journaled provider payload and a completed dispatch.
6. Grade actual inputs, actions, outputs and final files against original evidence. Require exactly one evidence row for each annotated obligation and validate literal quotes and metric ranges.

Snapshot endpoints vary deterministically between trial seeds. Recent-only retains legal current tool groups and cannot exceed its continuity budget on later requests. Rolling-summary also refuses an over-budget exact current turn. All strategies use the same main model, standard tools and explicit SSE transport. Reasoning accounting preserves dispatched ciphertext, excludes it only from the counting copy, and charges each replayed item the full journaled output count. Final payload checks bind receipts to the selected model. Grading uses the last journaled provider input rather than an unactivated handoff or newer ledger. Traces retain actual provider payloads, model/tool events, preparation and dispatch records, source history, files and grader evidence.

`modelTokens` and `modelCost` cover the main agent and memory generation, excluding the grader. Grader usage is in its evidence file. Cost is the SDK's price estimate, not an invoice; subscription billing can differ. `preparationMs` now includes explicit checkpoint preparation and all request-stream setup waits, including failed or aborted preparation before dispatch selection. `wallTimeMs` covers the trial before grading. Older reports lack this complete timing. `lookupCost` counts tool calls that explicitly name the archive directory; indirect shell access can escape that count.

Inspect a bounded plan before running it:

```bash
node --experimental-strip-types extensions/l-mem/evaluation/runner.ts \
  --plan --cases early-compatibility --compactions 3 --targets 12500 \
  --trials 1 --concurrency 2
```

The default full matrix contains 2,016 trials. `--smaller-budgets` adds a 2,000-block/2,500-trajectory comparison. Runs above 16 trials require `--allow-large-run`. Use `--resume` only with a matching implementation digest. Resume skips recorded results and retries missing driver results in fresh isolated trials; it does not resume uncertain agent requests.

## Remaining work

- Recheck the five unresolved cases after these changes, with separate quota approval. Verify both timeout behavior and the auxiliary answer against actual delivered evidence; do not treat the grading discrepancy as a clean report. Then obtain approval for the repeated acceptance matrix with baselines, lookup and capacity cases, and budget comparisons. Inspect capacity-grading results against the separately labeled durable state; an expected refusal must prove preservation, not claim the model received an unsent ledger. Preserve failures rather than selecting only successful runs.
- Extend live accounting before claiming images, old unjournaled reasoning or other opaque formats. Journaled eligible Responses reasoning is supported; unsupported cases still fail closed.
- Support authority-preserving transformed prompts before enabling them. Raw and expanded input remain archived, but the current live profile refuses them.
- Broaden Pi-version support only after checking and testing the host contract. Legacy histories without durable provenance cannot be repaired by inventing origin tags.
- Evaluate larger archives. Whole-session JSON manifest CAS remains a scaling limitation.

## What the checks do not prove

Receipts prove classification coverage, not complete extraction of meaning. References prove where a claim points, not that it follows from its source. Scope, identity equivalence, implicit intent and adequacy of evidence still depend on models.

The runtime prevents several structural authority errors and renders recorded obligations without trusting a model's inclusion claim. It cannot restore an obligation the writer never extracted. A passing pilot cannot establish reliability across long sessions, repeated corrections or unseen workloads.

The release gate requires multiple measured trials per fixture and compaction count, measured baselines, actual host checkpoints, original-source grading and no reported critical violations. A report must match the current implementation and main model. No passing release report exists yet.
