// Offline integration test against an installed Pi, not the checkout's stale types.
// Usage: node --experimental-strip-types scripts/test-memory-pi.mjs [pi-package-root]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = process.argv[2] ?? process.env.PI_MEMORY_TEST_PI_ROOT
	?? join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent");
const requirePi = createRequire(join(root, "package.json"));
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import(pathToFileURL(join(root, "dist/index.js")).href);
const aiRoot = requirePi.resolve.paths("@earendil-works/pi-ai")
	.map((path) => join(path, "@earendil-works/pi-ai"))
	.find((path) => existsSync(join(path, "package.json")));
if (!aiRoot) throw new Error("Cannot locate the installed harness's pi-ai package");
const { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore, InMemoryModelsStore } = await import(pathToFileURL(join(aiRoot, "dist/index.js")).href);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = await mkdtemp(join(tmpdir(), "pi-memory-integration-"));
const blockText = ["User intent", "Decisions", "Discoveries", "Actions and outcomes", "Unresolved matters"]
	.map((heading) => `## ${heading}\nKeep the public API unchanged. Agent proposed caching but the user did not approve it. Tests passed before the latest edit; current changes are unverified.`).join("\n");
const trajectory = ["Goal", "Progress", "Remaining work", "Blockers"]
	.map((heading) => `## ${heading}\nKeep the public API unchanged. Finish the requested fix. Re-run tests after the latest edit. No approval for caching.`).join("\n");
const faux = fauxProvider({ tokensPerSecond: Infinity, models: [{ id: "memory-test", contextWindow: 200_000, maxTokens: 16_384 }] });
const seen = { main: [], block: [], trajectory: [], options: [] };
let failNextWriter = false;
let nextMemoryRead;
faux.setResponses(Array.from({ length: 150 }, () => (context, options) => {
	if (context.systemPrompt?.includes("You write functional memory")) {
		seen.block.push(context);
		seen.options.push(options);
		if (failNextWriter) { failNextWriter = false; return fauxAssistantMessage("partial", { stopReason: "length" }); }
		return fauxAssistantMessage(blockText);
	}
	if (context.systemPrompt?.includes("Reconcile the current trajectory")) {
		seen.trajectory.push(context);
		seen.options.push(options);
		if (failNextWriter) { failNextWriter = false; return fauxAssistantMessage("partial", { stopReason: "length" }); }
		return fauxAssistantMessage(trajectory);
	}
	seen.main.push(context);
	if (nextMemoryRead) {
		const blockId = nextMemoryRead;
		nextMemoryRead = undefined;
		return fauxAssistantMessage(fauxToolCall("memory_read", { kind: "snapshot", blockId }), { stopReason: "toolUse" });
	}
	return fauxAssistantMessage("Coding response. Current changes still require verification.");
}));
let session;
const extensionErrors = [];
async function open(sm) {
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 2000, reserveTokens: 16_384 }, retry: { enabled: false } });
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false });
	const resourceLoader = new DefaultResourceLoader({
		cwd: directory, agentDir: directory, settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		additionalExtensionPaths: [join(repo, "extensions/l-mem/index.ts")],
		systemPromptOverride: () => "Fixed coding system prompt for memory integration testing.",
		extensionFactories: [(pi) => pi.registerProvider("faux", {
			api: faux.api, apiKey: "test-only", baseUrl: "https://unused.invalid", models: faux.models,
			streamSimple: (model, context, options) => faux.provider.streamSimple(model, context, options),
		})],
	});
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, []);
	({ session } = await createAgentSession({ cwd: directory, agentDir: directory, modelRuntime, resourceLoader,
		settingsManager, sessionManager: sm, model: faux.getModel(), tools: ["memory_search", "memory_read"] }));
	await session.bindExtensions({ onError: (error) => extensionErrors.push(error) });
}
try {
	const sm = SessionManager.create(directory, directory);
	await open(sm);
	await session.prompt("/memory on");
	assert.ok(sm.getBranch().some((entry) => entry.type === "custom" && entry.customType === "l-mem.config.v1" && entry.data.enabled));
	for (let round = 0; round < 3; round++) {
		await session.prompt(`Round ${round}. Keep the public API unchanged. ` + "Observed source and test details. ".repeat(1800));
		await session.prompt(`Round ${round}: latest edit needs tests. Do not treat caching as approved. ` + "Recent test details. ".repeat(600));
		await session.waitForIdle();
		const last = session.messages.at(-1);
		assert.equal(last?.role, "assistant", JSON.stringify(last));
		assert.equal(last.stopReason, "stop", last.errorMessage);
		const beforeBlocks = sm.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "l-mem.block.v1");
		assert.ok(beforeBlocks.length > 0, "turn_end must automatically capture snapshots");
		const result = await session.compact();
		assert.equal(result.details.kind, "l-mem");
		assert.ok(result.summary.indexOf("Memory block") < result.summary.indexOf("# Current trajectory"));
		assert.match(result.summary, /Keep the public API unchanged/);
		assert.equal(session.messages.filter((message) => message.role === "compactionSummary").length, 1);
		assert.ok(session.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes(`Round ${round}: latest edit`)), "latest user message is retained verbatim");
		nextMemoryRead = result.details.blockIds[0];
		await session.prompt(`Continue after compaction ${round}`);
		const context = seen.main.at(-1);
		const readResult = context.messages.findLast((message) => message.role === "toolResult" && message.toolName === "memory_read");
		assert.ok(readResult && !readResult.isError, "actual memory tool retrieves an archived snapshot");
		for (const message of context.messages) {
			if (message.role !== "toolResult") continue;
			assert.ok(context.messages.some((candidate) => candidate.role === "assistant" && candidate.content.some((part) => part.type === "toolCall" && part.id === message.toolCallId)), "compaction and continuation preserve tool-call/result pairs");
		}
		assert.ok(context.messages.some((message) => JSON.stringify(message).includes("# Current trajectory")), "actual resumed provider request contains memory");
	}
	assert.ok(seen.trajectory.length >= 3);
	assert.ok(seen.block.every((context) => !context.tools?.length));
	assert.ok(seen.options.every((options) => options.cacheRetention === "none"));
	const system = seen.main[0].systemPrompt;
	assert.ok(seen.main.every((context) => context.systemPrompt === system), "main system prompt remains unchanged");
	const file = sm.getSessionFile();
	session.dispose();
	await open(SessionManager.open(file));
	await session.prompt("Continue after process restart. " + "Recent test details. ".repeat(600));
	assert.ok(seen.main.at(-1).messages.some((message) => JSON.stringify(message).includes("# Current trajectory")));
	const restored = session.sessionManager;
	const checkpointCount = () => restored.getBranch().filter((entry) => entry.type === "compaction").length;
	const before = checkpointCount();
	failNextWriter = true;
	await assert.rejects(session.compact(), /cancelled/i);
	assert.equal(checkpointCount(), before, "partial summaries must never commit a compaction");
	await session.compact();
	assert.equal(checkpointCount(), before + 1);

	// A cloned session in the same directory inherits blocks and archive pointers.
	const cloneSource = SessionManager.open(restored.getSessionFile());
	const clonedFile = cloneSource.createBranchedSession(cloneSource.getLeafId());
	session.dispose();
	await open(SessionManager.open(clonedFile));
	await session.prompt("Continue in cloned branch. " + "Recent test details. ".repeat(600));
	await session.compact();
	assert.deepEqual(extensionErrors, []);
	console.log(`Pi ${requirePi("./package.json").version}: PASS. Three compactions, actual resumed requests, restart, cancellation/retry, clone, live tool execution, and unchanged system prompt. ${seen.block.length} block calls, ${seen.trajectory.length} trajectory calls. No network requests or real credentials used.`);
} finally {
	session?.dispose();
	await rm(directory, { recursive: true, force: true });
}
