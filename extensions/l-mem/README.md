# l-mem

Session trajectory memory for pi, with durable original history and versioned working state.

Live dispatch now has an implementation in a private, hash-checked pi 0.85.1 runtime. It does not patch the installed pi package. Normal enable requires a passing behavioral report. Explicit experimental opt-in can use live replacement without that report, but does not establish readiness or semantic fidelity.

## Use in pi

The package discovers `extensions/l-mem/index.ts`. It starts off: no archives or model calls. `/l-mem enable` requires the private runtime and a passing acceptance report. No passing release report is currently available. `/l-mem experimental` explicitly opts into unvalidated live replacement using the same runtime safety checks.

`/l-mem status` observes recorded state; `/l-mem off` stops capture and replacement. Shadow is an optional debugging mode, **not agent-usable memory**. `/l-mem shadow` can spend model quota creating blocks that the main agent never receives. `/l-mem prepare` inspects a candidate handoff without activating it.

### Experimental live use

Use a fresh session with disposable work. Live trials have timed out and produced answers that contradicted delivered evidence. Experimental mode can spend additional model quota on memory generation. It is not recommended for important session history.

From this repository, start the checked private runtime:

```bash
L_MEM_PI_PACKAGE="$(npm root -g)/@earendil-works/pi-coding-agent" \
  node --experimental-strip-types scripts/l-mem-pi.ts \
  --no-extensions -e extensions/l-mem/index.ts --l-mem experimental
```

Or start that runtime without `--l-mem experimental`, then run `/l-mem experimental` while idle. Ordinary installed Pi cannot supply the required dispatch hooks; `/reload` alone cannot add them.

This skips only the acceptance-report requirement. Durable provenance, ownership, model identity, context limits, immutable evidence, provider accounting and uncertain-dispatch checks remain active. No passing report is created or inferred. `/l-mem enable` still requires acceptance, even while experimental mode is active.

A warning appears before initialization, and the interactive footer and `/l-mem status` identify experimental mode. Noninteractive warnings go to stderr. `/l-mem compact` works in this mode; `/l-mem off` stops it and retains the archive. Opt-in expires on session shutdown and is not inherited by `/reload`, new sessions, resumed sessions or forks within the running process. To start a resumed session experimentally from the CLI, pass the flag again. Nothing is saved as a global startup preference.

### Read-only status

Run `/l-mem status` at any time, including while a memory writer is working. It shows:

- Capture mode and whether a background pass is running or paused.
- Published blocks, sealed snapshots awaiting publication, and retained block-version counts.
- The latest five snapshots with source ranges, block IDs, sizes, versions and generation age.
- Buffered original history, a progress bar, and the remaining counted input to the next snapshot target.
- Running, completed and invalid jobs. Expired leases are not presented as confirmed running jobs.
- The last prepared context, dispatch completion counts and recorded failures.

For example, an illustrative shadow session might show:

```text
Mode: shadow; recording only, live replacement off.
Memory blocks: 2 published, 1 awaiting publication. 2 stored block versions.
Next snapshot: [######....] 8,200 / 12,500 counted units, 65% across 18 buffered original events.
4,300 more counted units to the snapshot target.
Jobs: 1 running, 0 expired leases, 6 complete, 0 invalid.
```

The progress counter resets when a snapshot seals, even if its block is still being generated. Derived summaries and runtime controls do not fill that counter. The default snapshot target is 12,500 counted units within a 10,000-15,000 range. Coherent cuts or forced preparation can seal earlier. A block publishes only after extraction and review, so there is no clock-based ETA. The current Pi counters use UTF-8 bytes as conservative bounds, not measured provider tokens.

Status reads the recorded journal without starting a generation pass, waiting for a model, flushing a snapshot or adding anything to model context. Run it again to refresh. When capture is off, it does not open old archives or claim that they contain zero blocks. Shadow recording must be requested explicitly. It does not enable live context replacement.

### Native dispatch runtime

For the native dispatch adapter, use Node with built-in TypeScript stripping and SQLite support. **Once a passing report exists**, live startup is:

```bash
L_MEM_PI_PACKAGE="$(npm root -g)/@earendil-works/pi-coding-agent" \
L_MEM_ACCEPTANCE_REPORT=/absolute/path/to/passing-report.json \
  node --experimental-strip-types scripts/l-mem-pi.ts --l-mem enable
```

A missing or stale report refuses enable before starting shadow generation. Failed live startup reports memory OFF; it does not silently spend quota in shadow. Live enable is checked again on session startup. Interactive mode changes are not a persisted startup preference.

The launcher accepts normal pi arguments. Its checked source version is 0.85.1; the repository's local 0.80.10 dependency is not supported by the host patch. The private runtime lives under `node_modules/.cache/l-mem/`. To isolate this extension from other extensions during testing, add `--no-extensions -e extensions/l-mem/index.ts`.

`/l-mem enable` requires `L_MEM_ACCEPTANCE_REPORT` to name a passing report for the current implementation and main model. `/l-mem compact` requests compaction at the next real dispatch. `/l-mem resolve <dispatch-id> <reason>` records an operator's resolution of an uncertain request without sending it again. Inspect the original trace before resolving a request, and abort or finish any active turn first. Completed requests cannot be reclassified, and resolution explanations cannot be overwritten. After changing the main model, turn l-mem off and either enable it with acceptance for that model or explicitly opt into experimental mode again.

Shadow mode records the active branch, generates memory asynchronously, and can prepare candidate handoffs. It leaves the system prompt, tool catalog, live messages, and ordinary pi compaction unchanged. Ordinary pi compaction in shadow mode does not acquire l-mem's guarantees.

Memory jobs use the model selected at initialization through `ctx.modelRegistry.complete`, when that capability exists. They receive a separate memory-writing system prompt, source data, and no coding tools. They can request bounded reads of declared memory inputs through structured JSON responses. They cannot edit files, dispatch tools, or send messages to the main agent. Older pi registries without `complete` still support recording and snapshot sealing, but report `UNSUPPORTED_HOST_CAPABILITY` for generation.

`/l-mem off` cancels background model jobs and retains archives. `--no-session` remains non-persistent; l-mem refuses to initialize in that mode. No installed pi files or global settings are modified by this package.

## Files

| File | Responsibility |
| --- | --- |
| `contracts.ts` | Source, artifact, ledger, job, handoff and host contracts; numerical defaults |
| `storage.ts` | SQLite manifest CAS, immutable files, in-memory contract fake |
| `snapshots.ts` | Original-event ownership, segmentation, flushes and UTF-8 spans |
| `generation.ts` | Durable model jobs, bounded reads/pages, repairs, evidence review and ordered publication |
| `validation.ts` | Source, span, authority, receipt, version and transition checks |
| `context.ts` | Mandatory operational state, continuations, historical selection, annotations and budgets |
| `memory.ts` | Six-method public interface and inspection |
| `pi-adapter.ts` | Active-branch capture, restricted model invocation and shadow rendering |
| `index.ts` | pi lifecycle hooks, commands and disable control |
| `host-patch.ts` | Checked private pi runtime and request/provenance hooks |
| `host-runtime.ts` | Request selection, queueing, ownership, recovery and provider-payload journal |
| `native-context.ts` | Legal native tool sequences and conservative context accounting |
| `reasoning.ts` | Immutable provider receipts and encrypted-reasoning replay bounds |
| `model-output.ts` | Final-answer phase selection and strict JSON parsing |
| `archive-index.ts` | Immutable typed directory and bounded JSON-lines pages |
| `workspace.ts` | Before/after file identities and command evidence |
| `derived.ts` | Block regeneration, reviewed corrections and identity aliases |
| `acceptance.ts` | Implementation-bound behavioral release gate |
| `testing.ts` | Explicit test-only tokenizer, model and dispatch host |
| `evaluation/` | Executable SDK driver, annotated fixtures, matrix/checkpoint runner and structural smoke |

## Public interface

Construct `SessionMemory` with `Store`, `Tokenizer`, `HostBinding`, and optionally `ModelBinding`. Configuration defaults match the handoff specification. Token allocations use decimal units.

```ts
const memory = new SessionMemory(store, tokenizer, host, memoryModel);
memory.recordEvent(sessionId, producerEventId, event);
await memory.advanceMemory(sessionId, throughOriginalSequence);
await memory.prepareCompaction(sessionId, request);
memory.activateHandoff(sessionId, handoffId, expectedContextRevision);
memory.lookup(sessionId, query, { tokens: 2000 });
memory.inspect(sessionId);
```

Every method returns a discriminated `Result`. `advanceMemory` and `prepareCompaction` are asynchronous. Event ingestion can continue while they wait for models. Each instance orders generation jobs per session. Durable job leases coordinate additional instances; they return `MEMORY_PENDING` rather than publishing competing ledger updates.

`sequence` is the physical ingestion position. `originalSequence` is the filtered original-event position. Snapshot cutoffs, `throughOriginalSequence`, ledger cutoffs and handoff watermarks use the latter. Derived memory and runtime controls have no original position.

A producer event ID identifies immutable content. A retry with identical content returns the recorded event. Reuse with different content returns `DUPLICATE_EVENT_CONFLICT`. Causal references must already exist in the same session. Record dispatch intent before a side effect, then record its result separately. Neither recovery nor lookup executes a tool.

## Storage contract

`Store.load` returns a detached state and revision. `compareAndSwap` must atomically publish the entire supplied state only when that revision still matches. It must not expose partial records. `put` stores immutable bytes durably before returning a readable reference. `read` verifies session ownership and content integrity. Implementations must retain referenced content for the session lifetime.

The supplied `SqliteStore` requires a Node runtime with `node:sqlite`, tested on Node 26.4.0. It uses WAL, `synchronous=FULL`, conditional revision updates, and SHA-256 manifest digests. It publishes payload files through an exclusive temporary file, fsync, hard link and directory fsync. A crash may leave an orphan file, but cannot advance coverage with half a ledger. SQLite handles process locking; no stale lock file is deleted to guess that another process died.

The filesystem layout is next to pi's session files:

```text
<pi session directory>/l-mem/
  state.sqlite
  state.sqlite-wal
  state.sqlite-shm
  <sha256 of logical session ID>/
    <content hash>.txt
    <content hash>.json
    <content hash>.bin
```

Directory permissions are 0700 and new payload files are 0600. Treat the archive as sensitive session history. It may contain source code, user messages, tool output and credentials that appeared in those outputs. There is no independent retention timer, cross-session search, preference learning, synchronization, or automatic cleanup. Delete the corresponding archive only when intentionally deleting that session. Back up the database using SQLite-aware tooling and retain its referenced files.

The initial adapter stores each session manifest as one JSON row. This favors transaction correctness over storage efficiency. Runtime memory and update cost grow with retained history. Replace `Store` with an indexed transactional adapter before using very large archives.

## Archive access

The model-facing framing names the existing `read` capability and a session-specific archive directory. Each handoff publishes a JSON-lines index covering all original events through its cutoff, all eligible blocks including omitted blocks, artifact IDs, and current work-item records. Pages are at most 2,048 UTF-8 bytes. The root directory has `index_section` entries for blocks, work items, artifacts and original events. Choose a section by `entryKind`; artifact rows identify `captureKind`, including auxiliary captures. Within a section, the first line's `nextRef` links to the next page. Entries contain absolute content-addressed paths. An oversized individual entry becomes a labeled reference with its byte length and a bounded-byte-read warning. All page and entry references remain published with the handoff. Source IDs therefore resolve through an actual existing capability, not a decorative URI.

Exact user excerpts include `originalRef`, a direct path to their complete original source; their spans locate the quoted text. Use those links before scanning indexes when they supply the needed evidence. Use ordinary read/search tools on the archive directory. `lookup` also supports direct published references, original-event ranges, block IDs, work-item IDs, file/symbol text and literal search. Larger results return continuation queries. Binary artifact reads use base64 with byte ranges. A lookup is historical evidence, not evidence that a mutable file is unchanged.

A main-agent read or search is captured as an ordinary pi tool interaction. Writer-side reads remain private derived jobs. The writer prompt forbids treating repeated lookup as independent confirmation. The native tool hooks attach original-evidence IDs to direct reads of known archived artifacts. Indirect shell searches do not always expose a precise file identity, so the adapter does not invent one. Read indexes in bounded pages. Recursive archive searches can match large private job and provider-payload JSON; cap search stdout explicitly. Line limits do not bound long JSON lines. The memory frame provides bounded-search guidance, but does not alter standard tools or guarantee that the agent follows it. An oversized current result is still archived and blocks dispatch rather than being compressed away.

## Extraction and reconciliation

The writer emits complete structured extraction independently of the concise historical block. It processes original UTF-8 source spans, emits user-review receipts, and pages extraction when necessary. Preceding extraction and original-source directories are readable interpretive inputs. Nothing marks a snapshot validated until its complete extraction, block and immutable ledger version publish together.

New IDs derive from source event identity and an ordinal. Existing mutations must name the exact previous item version. All mutations to existing records receive an additional evidence review. Unsupported transitions retain the old record; ambiguous transitions also remain visible as conflicts. The runtime does not automatically merge similar-looking requirements, close children, or expire constraints with their parent task.

Extraction batches up to eight source segments when the input budget permits. A batch cannot make an earlier transition cite later evidence. Exact unique quote locators resolve to UTF-8 spans. Jobs journal terminal SDK responses before JSON parsing, including malformed answers and private read requests. Responses phase metadata separates commentary from the final structured answer; the parser never joins two independent JSON answers. Private reads keep a bounded read history, and repair errors name missing fields.

The block writer selects original extracted claim IDs rather than repeatedly summarizing prose. Rejected completion claims cannot become supported historical completion entries. This does not establish that the model extracted every obligation or interpreted each scope correctly.

## Context and budgets

The trajectory model assigns work-item IDs to Goal, Progress, Remaining Work and Blockers and proposes a labeled next action. The runtime renders the actual ledger fields and required exact excerpts. It moves overflow into mandatory current-state continuation records, packs them below the block cap, and recounts the trajectory directory. The complete proposed next action can also move to an included continuation; its trajectory entry points to that location. Later-added retrieval prerequisites remain included and counted, not left in an earlier copy. Optional historical blocks cannot displace an active obligation.

Selection uses explicit evidence dependencies, the latest three eligible blocks, and the specified active-ID/entity/term/recency score. Ties are deterministic; selected history renders chronologically. Current-status and stale-validation annotations appear beside historical blocks. Omitted required evidence adds retrieval prerequisites before the dependent action.

`HostBinding.render` owns the final request serialization. Its inclusive partition counts must include framing and sum to the actual total. The supplied JSON renderer is a contract/shadow protocol, not a provider adapter. Concatenating its `history`, `trajectory` and `tail` strings gives its complete serialized continuity array. The host must preserve ordinary system instructions and tool definitions outside that array.

The native adapter uses a conservative serialized UTF-8 bound and checks the final provider payload again, including output reserve and safety margin. It supports the standard OpenAI Responses, Codex Responses and Chat Completions adapters. Images remain unsupported. Live requests use SSE so a WebSocket adapter cannot replace the checked full request with implicit server-side history. The private v3 runtime copies Pi's model package and checks the relevant provider adapter hashes.

Encrypted Responses reasoning stays unchanged in storage and dispatch. The host captures terminal SDK provider responses before message hooks, isolates streamed partials from mutation, and journals responses and usage immutably. It counts each replayed reasoning item using the entire originating response's output-token count. OpenAI includes reasoning in output usage, so this also charges visible output and overcounts multi-item responses.

The counting-only copy excludes ciphertext, which the provider decrypts rather than reads as literal text. The bound is UTF-8 bytes for that copy plus the journaled output allowance. Ciphertext inside ordinary text or tool arguments remains counted as text. Missing proof never permits this exclusion. The final check binds the receipt to the selected provider, model and API. Handoffs record supplemental tokens, excluded encoded bytes and receipt references. Neither ciphertext length nor mutable message usage establishes a decoded-token bound. Baselines use the same rule. See [OpenAI's reasoning guide](https://developers.openai.com/api/docs/guides/reasoning).

Missing receipts, incomplete usage, changed ciphertext, other opaque formats, implicit server-side context and automatic truncation fail closed. Old unjournaled reasoning cannot be retroactively certified. The Codex adapter does not serialize `maxTokens`, so live dispatch reserves the model's declared full output limit rather than claiming that option caps generation.

The pi shadow counter counts UTF-8 bytes, not model tokens. It is a diagnostic bound for serialized text, not certification of every provider's image or protocol accounting. `/l-mem prepare` includes an explicit safety margin and labels counts as estimates. Live replacement requires provider-aware counting or an explicitly justified conservative bound for the actual final request.

When mandatory operational records and the exact legal tail cannot fit, preparation returns `ACTIVE_STATE_TOO_LARGE` or `CONTEXT_BUDGET_EXCEEDED`. It does not truncate records, silently defer tasks, or declare that archive pointers solve the immediate context limit. The host keeps its existing context or pauses. Fitting exact tails reuse validated coverage instead of forcing a short snapshot at every tool step. Current unconsumed tool results, including user-bash results, cannot move behind a cutoff. If a writer or evidence failure prevents every usable compacted view, a later oversized uncompressed candidate does not hide that failure.

## Host integration and dispatch

Current capture hooks are `tool_call`, `context`, `agent_end` and `tool_execution_end`, with durable branch backfill at startup. The pi tool-call hook runs after the assistant message is recorded and before execution. Operation-end observations retain completion order; final visible results retain pi message order. One original assistant message can support several lifecycle records, so the shadow renderer deduplicates exact message references rather than fabricating calls.

Branch changes pause capture instead of merging abandoned work into the active branch. The private host tags input provenance before expansion and archives extension-manufactured input separately from user authority. Older histories without those tags cannot acquire reliable provenance retroactively, so native enable refuses them. The live profile also refuses transformed user prompts whose raw and expanded text differ, while retaining both forms in the archive.

Runtime controls remain separate host-authority data. They never become user obligations. Activation refresh includes control-only arrivals even when the original watermark has not advanced. If a mandatory control cannot fit, dispatch stops rather than dropping it.

To make a prepared handoff the next real model request, the pi host must implement `HostBinding.dispatch.activate` at its request-dispatch seam. It must:

1. Take a short barrier shared with ingestion and request selection.
2. Check the actual host context revision.
3. Call the provided synchronous refresh callback. It appends arrivals after the captured watermark and revalidates the exact tail, evidence and budgets without model calls.
4. Atomically select that refreshed handoff and persist a dispatch record with its ID, source watermark and accepted/sent/unknown state.
5. Return the same dispatch record on repeated activation. Recovery must not automatically resend a possibly dispatched request.
6. Queue events arriving after selection for the following request.

`context` plus `appendEntry` is not this transaction. The private host installs it at the SDK's stream invocation seam. The host drains steering before selection, verifies the revision and unchanged system/tool definitions, refreshes synchronously, and journals acceptance before invoking the provider. Inputs arriving afterward remain queued for a later request.

The provider callback checks the actual payload, saves it, and marks the request sent. The response journal links the terminal SDK response to that dispatch. Successful terminal responses mark it complete only after payload journaling. A returned tool call cannot execute while its request lacks definite journaled completion. Accepted or sent requests without a definite completion require explicit resolution; neither requests nor tools replay automatically. The host disables ordinary compaction and retries while enabled and restores the previous settings on disable. Unsupported context or payload mutations stop dispatch.

Native tool hooks record bounded before/after workspace manifests and file snapshots, plus bash command, cwd and exit information. Large or unreadable workspaces retain an explicit incomplete scope. A host-recorded command, cwd and matching exit status can support a scoped historical test observation, including failure. Generic lifecycle status cannot. An exit code alone cannot complete a task or establish unrelated acceptance criteria.

## Versions and migrations

The database uses `user_version=1`; session manifests use `schemaVersion=2`. Each extraction and trajectory response carries schema version 1. Prompt versions are in `prompts.ts`; configuration, tokenizer, host binding, jobs, snapshots and ledger versions are recorded in derived state.

Unknown versions fail closed. The schema-1 migration archives the exact old manifest and publishes schema 2 through CAS. It preserves original IDs, hashes, spans, ownership and ledger versions. Stop a live legacy owner and finish or expire its jobs first. Legacy prepared handoffs must be prepared again.

Derived changes use the existing `advanceMemory` interface:

```ts
await memory.advanceMemory(sessionId, { kind: "regenerate_block", blockId });
await memory.advanceMemory(sessionId, {
  kind: "reconcile", requestId, expectedLedgerVersion, mutations, aliases,
});
```

The corresponding commands are `/l-mem regenerate <block-id>` and `/l-mem reconcile <request.json>`.

Regeneration selects from the complete original extraction, retains the old block, and does not replay ledger transitions. The current version is the block not superseded by another version. Corrections require the complete current ledger and an original-source review. Each correction records its effective source positions and reconciliation version. Earlier ledger views remain readable, but future handoffs must use the corrected cutoff or a later one.

Aliases require supported equivalence and cannot change authority, status, conditions or dependencies. They identify one operational obligation without deleting either historical identity. Normal mutations must address the canonical ID. Derived updates invalidate old preparations, including activation-time retries. Tokenizer and host changes also require preparation again.

## Validation and release status

```bash
npm run test:l-mem
npm run typecheck:l-mem
npm run eval:l-mem
```

The smoke runner uses an explicitly fake model and reports structural results only. `evaluation/sdk-driver.ts` runs a real pi coding agent with the same standard tools across l-mem, rolling-summary, recent-only and fitting uncompressed baselines. It uses isolated workspaces and the existing SDK authentication. Real-model calls consume quota.

Inspect a plan before running it:

```bash
node --experimental-strip-types extensions/l-mem/evaluation/runner.ts --plan
```

A bounded pilot:

```bash
L_MEM_PI_PACKAGE="$(npm root -g)/@earendil-works/pi-coding-agent" \
node --experimental-strip-types extensions/l-mem/evaluation/runner.ts \
  --driver extensions/l-mem/evaluation/sdk-driver.ts \
  --cases early-compatibility --compactions 1,3 --targets 12500 \
  --strategies l-mem,rolling-summary,recent-only,uncompressed \
  --trials 1 --concurrency 2 --output /path/to/pilot.json
```

Set `L_MEM_EVAL_PROVIDER` and `L_MEM_EVAL_MODEL` when `PI_PROVIDER` and `PI_MODEL` are unavailable. `--resume` requires the same implementation digest. `--smaller-budgets` adds a 2,000-block/2,500-trajectory comparison. More than 16 trials require explicit `--allow-large-run`; the full default matrix contains 2,016 trials. A single passing trial cannot open the gate.

See [EVALUATION.md](EVALUATION.md) for actual results and open work. Passing schema, token and coverage checks does not certify semantic fidelity. Normal live enable remains blocked without a current passing report. Experimental opt-in permits unvalidated use; it does not change the release gate or turn diagnostic results into acceptance.
