# Long-session memory

An experimental Pi extension for staying on task through repeated compactions within one session. It does not build a cross-session knowledge base.

## Try it

Requires Pi 0.85.1 or newer. The package discovers `index.ts` automatically. If this checkout is already installed as a local Pi package:

```text
/reload
/memory on
```

Or start a session with just this extension explicitly loaded:

```bash
pi -e ./extensions/l-mem/index.ts --l-mem
```

Use it normally, then run `/compact` or let Pi auto-compact. `/memory status` shows the writer, archive directory, block count, last selected block count, and any capture error.

Memory is off by default. Enabling it applies to the active branch and survives reload/resume. `/new` starts with memory off unless Pi was launched with `--l-mem`. `/tree` restores the configuration and memories on the selected branch. `/fork` and `/clone` inherit only their active path.

### Commands

| Command | Effect |
| --- | --- |
| `/memory on` | Enable memory, or clear a capture error so subsequent turns retry. |
| `/memory off` | Stop capture and return future compactions to Pi's default summarizer. Does not erase existing summaries or archives. |
| `/memory status` | Inspect state without making a model call. |
| `/memory model provider/model` | Choose a registered writer model for this branch. |
| `/memory model current` | Use the current coding model in separate, tool-free requests. |
| `/memory compact` | Request compaction with memory enabled. Equivalent to `/compact` while enabled. |
| `/compact optional focus` | Pi's normal command. The focus goes to the final trajectory reconciliation. |

CLI flags are `--l-mem` and `--l-mem-model provider/model`. Stored branch configuration takes precedence over startup defaults. These commands do not change the coding model or authenticate a provider. The writer uses Pi's registered model and authentication handling. A writer with at least a 64K context window is recommended for the default budgets.

## What happens

1. At the end of a completed agent turn, collect original context-visible events on the active branch. Do not collect compaction summaries or our own state entries.
2. Partition previously uncovered text into snapshots targeting 12,500 estimated tokens. Leave a smaller final interval pending until another turn or compaction.
3. Archive the exact source entries and the snapshot projection. A separate, tool-free AI call writes a concise memory block with a 4K estimated-token text ceiling.
4. Persist the block and its source pointers as a non-context Pi custom entry. Finished blocks survive cancellation of later work.
5. Before compaction, flush the remaining interval, verify snapshot availability, and reconcile the current trajectory. Every new block reaches this writer, including blocks that will not fit in the resumed history. Large backlogs use multiple bounded reconciliation calls.
6. Select whole memory blocks within the history budget. Present them chronologically, followed by the current trajectory. Return this as Pi's custom compaction summary and keep Pi's existing recent-tail cut point.

The next coding request contains:

```text
Unchanged coding system prompt and tool definitions
Pi compaction summary
  Historical memory notice and selected memory blocks   <= 30K estimated tokens
  Goal / Progress / Remaining work / Blockers            <=  5K estimated tokens
Pi's retained recent conversation
New conversation
```

The extension adds `memory_search` and `memory_read` tools. It does not override existing tools or rewrite the coding system prompt. Pi wraps the custom summary in its normal compaction message.

### Budgets and timing

Token counts use UTF-8 bytes divided by three, rounded up. This is a heuristic, not a provider tokenizer or an exact token ceiling. Pi's retained-tail estimate uses its own message estimator so base64 image bytes are not counted as text tokens.

A block's 4K ceiling applies to its generated text. The 30K history ceiling includes block descriptors, IDs, and the memory notice. On smaller main models, history and trajectory budgets shrink to leave room for the system prompt, active tool schemas, recent tail, and Pi's configured response reserve. If that cannot fit, compaction is cancelled with an explanation.

Pi retains its configured `compaction.keepRecentTokens`, normally about 20K. That is **additional** to the 30K + 5K allocations. To test a smaller recent tail, set `compaction.keepRecentTokens` to 5000 in Pi settings. The extension does not change settings for you. Cut points are event-based, so a single large retained message can exceed the requested tail budget.

Generation is awaited at completed turns, not run in the background. Expect pauses when an interval fills and during compaction. Enabling memory late in a long session backfills its original branch history and can require many calls. A writer request has a three-minute deadline. Cancellation passes through to the model request.

## Memory contents

Each block records:

- Explicit user requests and constraints, supported inferred preferences, and corrections.
- Decisions, who made them, rationale, rejected alternatives, and changed direction.
- Discoveries with scope, uncertainty, paths, symbols, and evidence pointers.
- Actions and outcomes, distinguishing proposed, attempted, implemented, confirmed, and tested.
- Open questions, blockers, unverified assumptions, and unfinished work.

The trajectory uses four sections: Goal, Progress, Remaining work, and Blockers. Its prompt checks for dropped requests, scoped corrections, side questions mistaken for goal changes, stale tests, and agent proposals mistaken for user approval.

These distinctions are prompt-guided, not formally guaranteed. The first implementation validates output headings and size, but does not prove that generated claims or citations are correct. Inspection pointers attached by the extension identify the actual interval independently of AI-written citations.

Selection is a deterministic heuristic using recency, preference for the first block, and keyword overlap with the trajectory. It is not an embedding search or an AI relevance classifier. Unselected blocks remain available through the tools. The trajectory is a rolling reconciliation and can still accumulate errors; original interval blocks are never rewritten to match it.

## Tool calls and source material

The archive stores exact original Pi entries, including tool arguments, delivered tool content, error flags, details, images, and any persisted thinking. The memory writer receives a text projection:

| Material | Writer input |
| --- | --- |
| User messages | Full text with role, event ID, and timestamp. |
| Agent messages | Text and tool calls. Thinking is replaced by an explicit omission marker. |
| Tool results | Full delivered text with tool name, call ID, and error status. No arbitrary 2K output truncation. |
| Images | An omission marker. The writer does not inspect pixels. |
| `!` shell output | Command, delivered output, exit/cancellation/truncation state. |
| `!!` shell output | Excluded from this archive and from writer input because Pi excludes it from model context. |
| Other extension messages | Labeled as extension messages, not direct user requests. |
| Branch summaries | Labeled as generated claims about an abandoned branch. |
| Memory-tool results | A retrieval marker instead of recursively summarizing retrieved memory. Original results remain archived. |

This records Pi's session entries, not the final provider payload. If another extension rewrites or removes messages in a `context` hook, this archive does not reproduce that transformation.

A tool's underlying output may be larger than what Pi delivered. The extension archives what is in the session; it does not fetch truncated-away logs, follow temporary-file paths, or copy external artifacts. Those may become unavailable. Raw tool details remain inspectable in the original event.

Snapshots prefer event endings near the target size. Large events can span snapshots, and a tool call and its result can land in different snapshots. Explicit event IDs and character ranges preserve those links. The previous block supplies background to the next block writer. This is a text summarization split, not a split in the actual tool protocol. Pi's retained tool calls and results are left intact.

## Inspection tools

`memory_search` performs literal, case-insensitive search over block text on the active branch. Omit `query` to list the newest blocks. It returns at most 20 descriptors and a pagination offset.

`memory_read` accepts:

```json
{ "kind": "block", "blockId": "<ID from memory_search>" }
{ "kind": "snapshot", "blockId": "<ID>", "offset": 0 }
{ "kind": "event", "eventId": "<source event ID>", "offset": 0 }
```

Responses have `text`, `nextOffset`, and `totalCharacters`. Follow `nextOffset` for more. Pages contain at most 12,000 UTF-16 characters and can be smaller to keep JSON-encoded output below 40KB. Raw image data is available as event JSON, not rendered as an image by this tool.

Block and event lookup must match active-branch records. Guessing an archive hash does not grant access to unrelated session records through these tools. This is scope control for memory retrieval, not a sandbox against the agent's existing filesystem tools.

## Storage and privacy

For a session at `/path/to/sessions/session.jsonl`, artifacts live in:

```text
/path/to/sessions/.l-mem/<sha256>.json
```

Sibling sessions share content-addressed artifacts so `/fork` and `/clone` keep working without copying archives. There is no shared semantic index. Only blocks referenced on the active branch are selected or searchable.

Directories are created with mode `0700`, files with `0600`. Writes use a temporary file and atomic rename. Reads validate IDs and content hashes. Existing permissions on parent directories are not changed. Block records and configuration are stored in Pi custom entries; a completed trajectory is stored in compaction details. A cancelled compaction never commits a new trajectory.

**There is no secret redaction or encryption.** Enabling this feature duplicates original session data locally and sends its text projection to the chosen writer provider. Select a writer you trust with the same code and tool output as your coding model. This extension never reads credential stores itself.

There is no automatic archive cleanup. Deleting a session through Pi does not delete `.l-mem`. Removing the archive directory removes evidence for all sibling sessions, though their original session JSONL and stored memory text remain. Copy the archive directory alongside sessions when moving them to another location. A cross-directory fork/import also needs the corresponding artifacts copied; missing snapshots cause memory compaction to stop rather than silently discard pointers.

## Failure behavior

- Empty, malformed, or oversized text gets one fresh regeneration attempt. Output is never silently clipped into a checkpoint.
- A partial model response, failed request, timeout, missing archive artifact, or abort cancels memory compaction. Pi keeps its pre-compaction context. Any blocks finished before the failure remain reusable.
- A failed turn-end capture pauses further turn-end capture until `/memory on`, a reload, or a compaction attempt. Compaction always retries pending work.
- `/memory off` is the explicit escape hatch to Pi's normal compaction. Existing memory summaries remain in the context until later compactions replace them.
- Ephemeral `--no-session` operation is refused because durable inspection pointers need a saved session.
- Do not enable another extension that also replaces `session_before_compact` at the same time. Pi's extension ordering can otherwise decide which result wins.

Successful compaction calls return their combined model usage to Pi. Earlier turn-end capture usage and cancelled compaction usage are stored in `l-mem.usage.v1` custom entries. Pi's normal totals do not count those custom entries, so they can under-report memory costs. Block and trajectory calls are real additional billable requests.

## Tests and implementation

From the repository root:

```bash
npm run test:memory
npm run typecheck:memory
npm run test:memory:pi
```

The integration test locates the globally installed Pi. To select a different installation:

```bash
npm run test:memory:pi -- /absolute/path/to/pi-coding-agent
```

All tests are offline. They use scripted model responses, not real credentials. The integration test loads the actual extension through Pi, runs three compactions, checks resumed provider requests and actual memory-tool execution, restarts the session, tests a cancelled partial response and retry, and clones the session. Unit tests cover source fidelity, large-event ranges, branch isolation, budgets, output repair, cancellation, and inspection.

These tests verify mechanics, not real-model memory quality. Early trials should check whether the resumed agent remembers an early constraint, a changed goal, a failed approach, and the difference between implemented and tested.

- `index.ts` connects Pi lifecycle events, model calls, commands, budgets, and tools.
- `core.ts` owns interval partitioning, branch state, storage, selection, and pagination.
- `memory.ts` owns AI prompts, validation, capture, and trajectory reconciliation.

The focused typecheck is separate because this checkout currently has unrelated type errors and missing workflow source files. The local Pi dev dependency is older than the installed harness, so the integration test deliberately uses the installed version.
