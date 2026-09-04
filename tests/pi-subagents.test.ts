import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import extension, {
	appendSubagentModelThinkingArgs,
	applyAgentAvailabilityCommand,
	buildAgentAvailabilityItems,
	buildAgentItems,
	buildAgentsMenuItems,
	buildModelItems,
	buildThinkingItems,
	classifySubagentOutcome,
	formatRestorableFailurePrompt,
	filterSelectItems,
	formatAgentsSummary,
	listAgents,
	resolveNestedSubagentAllowlist,
	restoreSubagentCheckpoints,
	runAgentSettingsWizard,
	SUBAGENT_CHECKPOINT_TYPE,
	type AgentConfig,
	type AgentSettingsPickOptions,
} from "../extensions/pi-subagents/index.ts";
import {
	canonicalModelRef,
	clearAgentOverride,
	clearAllAgentAvailabilityOverrides,
	clearAllAgentOverrides,
	clearTemporaryAgentRestriction,
	getAgentOverride,
	isAgentEnabled,
	isAgentTemporarilyRestricted,
	isAgentUserEnabled,
	resolveEffectiveAgentSettings,
	resolveModelRef,
	setAgentEnabled,
	setAgentOverride,
	setTemporaryAgentRestriction,
} from "../extensions/pi-subagents/settings.ts";

function testModel(
	provider: string,
	id: string,
	options: { reasoning?: boolean; thinkingLevelMap?: Model<Api>["thinkingLevelMap"]; contextWindow?: number } = {},
): Model<Api> {
	return {
		provider,
		id,
		name: `${provider} ${id}`,
		api: "openai-responses",
		baseUrl: "https://example.test",
		reasoning: options.reasoning ?? false,
		thinkingLevelMap: options.thinkingLevelMap,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: options.contextWindow ?? 100_000,
		maxTokens: 4096,
	} as Model<Api>;
}

function testAgent(name: string, options: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name,
		description: `${name} description`,
		tools: ["read"],
		model: "anthropic/claude",
		thinking: "medium",
		systemPrompt: `You are ${name}.`,
		filePath: `/agents/${name}.md`,
		...options,
	};
}

async function runWizardWithPicks(
	agentList: readonly AgentConfig[],
	models: readonly Model<Api>[],
	picks: readonly (string | undefined)[],
): Promise<{ result: boolean; calls: AgentSettingsPickOptions[]; notifications: Array<{ message: string; level: "info" | "warning" }> }> {
	const calls: AgentSettingsPickOptions[] = [];
	const notifications: Array<{ message: string; level: "info" | "warning" }> = [];
	let pickIndex = 0;
	const result = await runAgentSettingsWizard({
		agentList,
		models,
		pick: async (options) => {
			calls.push(options);
			const value = picks[pickIndex++];
			return value === undefined ? undefined : options.items.find((item) => item.value === value);
		},
		notify: (message, level) => notifications.push({ message, level }),
	});
	return { result, calls, notifications };
}

test("model refs resolve canonical first and unique bare IDs second", () => {
	const canonical = testModel("anthropic", "claude-sonnet-4-6");
	const bareWithSlash = testModel("openrouter", "anthropic/claude-sonnet-4-6");
	const uniqueBare = testModel("openai", "gpt-5.1");
	const duplicateBare = testModel("github-copilot", "gpt-5.1");
	const models = [canonical, bareWithSlash, uniqueBare, duplicateBare];

	assert.equal(canonicalModelRef(canonical), "anthropic/claude-sonnet-4-6");
	assert.equal(resolveModelRef("anthropic/claude-sonnet-4-6", models), canonical);
	assert.equal(resolveModelRef("openai/gpt-5.1", models), uniqueBare);
	assert.equal(resolveModelRef("gpt-5.1", models), undefined);
	assert.equal(resolveModelRef("openrouter/anthropic/claude-sonnet-4-6", models), bareWithSlash);
});

test("effective settings are isolated per agent and clear on request", () => {
	clearAllAgentOverrides();
	const reasoningModel = testModel("anthropic", "claude", { reasoning: true });
	const fastModel = testModel("openai", "fast", { reasoning: false });
	const models = [reasoningModel, fastModel];
	const agentA = { name: "a", model: "claude", thinking: "medium" };
	const agentB = { name: "b", model: "claude", thinking: "medium" };

	setAgentOverride("a", { model: "openai/fast", thinking: "off" });

	assert.deepEqual(
		resolveEffectiveAgentSettings(agentA, models),
		{
			model: "openai/fast",
			thinking: "off",
			resolvedModel: fastModel,
			supportedThinkingLevels: ["off"],
		},
	);
	assert.equal(resolveEffectiveAgentSettings(agentB, models).model, "anthropic/claude");
	assert.equal(resolveEffectiveAgentSettings(agentB, models).thinking, "medium");

	clearAgentOverride("a");
	assert.equal(resolveEffectiveAgentSettings(agentA, models).model, "anthropic/claude");
});

test("unsupported reasoning levels coerce to off for non-reasoning models", () => {
	clearAllAgentOverrides();
	const plainModel = testModel("openai", "plain", { reasoning: false });
	const reasoningModel = testModel("anthropic", "deep", {
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", max: null },
	});

	setAgentOverride("plain-agent", { model: "openai/plain", thinking: "high" });
	const plainEffective = resolveEffectiveAgentSettings(
		{ name: "plain-agent", model: "anthropic/deep", thinking: "high" },
		[plainModel, reasoningModel],
	);
	assert.equal(plainEffective.thinking, "off");
	assert.deepEqual(plainEffective.supportedThinkingLevels, ["off"]);

	const reasoningEffective = resolveEffectiveAgentSettings(
		{ name: "reasoning-agent", model: "anthropic/deep", thinking: "xhigh" },
		[plainModel, reasoningModel],
	);
	assert.equal(reasoningEffective.thinking, "xhigh");
	assert.ok(reasoningEffective.supportedThinkingLevels.includes("xhigh"));
	assert.equal(reasoningEffective.supportedThinkingLevels.includes("max"), false);
});

test("option builders expose effective agent rows, every registry model, and supported reasoning rows", () => {
	clearAllAgentOverrides();
	const plainModel = testModel("openai", "plain", { reasoning: false, contextWindow: 32_000 });
	const deepModel = testModel("anthropic", "deep", {
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", max: null },
		contextWindow: 1_200_000,
	});
	const otherModel = testModel("openrouter", "other", { reasoning: false, contextWindow: undefined });
	const models = [deepModel, plainModel, otherModel];
	const worker = testAgent("worker", { description: "does focused work", tools: ["read", "edit"], model: "anthropic/deep" });

	setAgentOverride("worker", { model: "openai/plain", thinking: "off" });

	const agentItems = buildAgentItems([worker], models);
	assert.equal(agentItems.length, 2);
	assert.equal(agentItems[0].value, "__all__");
	assert.equal(agentItems[0].label, "all");
	assert.match(agentItems[0].description ?? "", /Apply to all 1 agents/);
	assert.equal(agentItems[1].value, "worker");
	assert.equal(agentItems[1].description, "enabled · openai/plain · thinking: off");
	setAgentEnabled("worker", false);
	assert.equal(buildAgentItems([worker], models)[1].description, "disabled · openai/plain · thinking: off");
	setAgentEnabled("worker", true);
	assert.doesNotMatch(agentItems[1].description ?? "", /does focused work/);
	assert.doesNotMatch(agentItems[1].description ?? "", /tools:/);

	assert.deepEqual(
		buildModelItems(models).map((item) => item.value),
		["anthropic/deep", "openai/plain", "openrouter/other"],
	);

	const supportedLevels = getSupportedThinkingLevels(deepModel);
	assert.deepEqual(buildThinkingItems(supportedLevels).map((item) => item.value), supportedLevels);
	assert.equal(buildThinkingItems(supportedLevels).some((item) => item.value === "max"), false);
});

test("model options support fuzzy search across provider, id, and display name", () => {
	const models = [
		testModel("anthropic", "claude-sonnet-4-6"),
		testModel("openai", "gpt-5.1"),
		testModel("openrouter", "openai/gpt-5.1"),
	];
	models[0].name = "Claude Sonnet";
	const items = buildModelItems(models);

	assert.deepEqual(filterSelectItems(items, "ant son").map((item) => item.value), ["anthropic/claude-sonnet-4-6"]);
	assert.ok(filterSelectItems(items, "oai g51").some((item) => item.value === "openai/gpt-5.1"));
	assert.deepEqual(filterSelectItems(items, "").map((item) => item.value), items.map((item) => item.value));
});

test("availability helpers default enabled and update summaries and menu rows", () => {
	clearAllAgentOverrides();
	clearAllAgentAvailabilityOverrides();
	const plainModel = testModel("openai", "plain", { reasoning: false });
	const deepModel = testModel("anthropic", "deep", { reasoning: true });
	const worker = testAgent("worker", { tools: ["read", "write"], model: "anthropic/deep", thinking: "medium" });
	const scout = testAgent("scout", { tools: [], model: "openai/plain", thinking: "high" });

	setAgentOverride("worker", { model: "openai/plain", thinking: "off" });
	setAgentEnabled("scout", false);

	assert.equal(isAgentEnabled("worker"), true);
	assert.equal(isAgentEnabled("scout"), false);
	assert.equal(
		formatAgentsSummary([worker, scout], [plainModel, deepModel]),
		"worker [enabled]: openai/plain · thinking: off (read, write)\nscout [disabled]: openai/plain · thinking: off (no tools)",
	);
	assert.deepEqual(buildAgentAvailabilityItems([worker, scout]).map((item) => [item.id, item.currentValue]), [
		["worker", "enabled"],
		["scout", "disabled"],
	]);
	assert.match(buildAgentsMenuItems([worker, scout])[0].description ?? "", /1\/2 agents enabled/);
});

test("availability commands update persistent choices independently of temporary restrictions", () => {
	clearAllAgentAvailabilityOverrides();
	const worker = testAgent("worker");
	const scout = testAgent("scout");
	const agentList = [worker, scout];

	assert.equal(applyAgentAvailabilityCommand("disable worker", agentList)?.level, "info");
	assert.equal(isAgentUserEnabled("worker"), false);
	assert.equal(applyAgentAvailabilityCommand("toggle worker", agentList)?.message, "worker is now enabled for this session.");
	assert.equal(isAgentUserEnabled("worker"), true);
	applyAgentAvailabilityCommand("disable all", agentList);
	assert.equal(isAgentUserEnabled("worker"), false);
	assert.equal(isAgentUserEnabled("scout"), false);
	applyAgentAvailabilityCommand("enable all", agentList);
	assert.equal(isAgentUserEnabled("worker"), true);
	assert.equal(isAgentUserEnabled("scout"), true);
	assert.match(applyAgentAvailabilityCommand("disable missing", agentList)?.message ?? "", /Unknown agent: missing/);
	assert.match(applyAgentAvailabilityCommand("wat", agentList)?.message ?? "", /Usage:/);
	assert.equal(applyAgentAvailabilityCommand("", agentList), undefined);

	setAgentEnabled("scout", false);
	setTemporaryAgentRestriction("test-workflow", ["worker"]);
	assert.equal(isAgentEnabled("worker"), true);
	assert.equal(isAgentTemporarilyRestricted("scout"), true);

	applyAgentAvailabilityCommand("toggle all", agentList);
	assert.equal(isAgentUserEnabled("worker"), false, "toggle-all uses the user's prior choice, not effective availability");
	assert.equal(isAgentUserEnabled("scout"), true, "a user-disabled choice toggles on even while temporarily restricted");
	assert.equal(isAgentEnabled("worker"), false);
	assert.equal(isAgentEnabled("scout"), false);

	clearTemporaryAgentRestriction("test-workflow");
	assert.equal(isAgentEnabled("worker"), false, "workflow cleanup must preserve a disable made during the workflow");
	assert.equal(isAgentEnabled("scout"), true, "workflow cleanup must preserve an enable made during the workflow");
});

test("nested subagent availability intersects profile allowlists without broadening them", () => {
	clearAllAgentAvailabilityOverrides();
	const scout = testAgent("scout");
	const researcher = testAgent("researcher");
	const worker = testAgent("worker", { tools: ["subagent"], subagentAgents: ["scout"] });
	const unrestricted = testAgent("orchestrator", { tools: ["subagent"] });
	const agentList = [scout, researcher, worker, unrestricted];

	assert.deepEqual(resolveNestedSubagentAllowlist(worker, agentList), ["scout"]);
	assert.deepEqual(resolveNestedSubagentAllowlist(testAgent("none", { tools: ["subagent"], subagentAgents: [] }), agentList), []);
	assert.equal(resolveNestedSubagentAllowlist(unrestricted, agentList), undefined);
	setAgentEnabled("scout", false);
	assert.deepEqual(resolveNestedSubagentAllowlist(worker, agentList), []);
	assert.deepEqual(resolveNestedSubagentAllowlist(unrestricted, agentList), ["researcher", "worker", "orchestrator"]);
});

test("nested child prompt advertises only allowed profiles and retains normal skill discovery", async () => {
	const tools: any[] = [];
	extension({ registerCommand: () => {}, registerTool: (tool: unknown) => tools.push(tool) } as any);
	const tool = tools[0];
	assert.ok(tool);

	let parentName = "worker";
	let allowedName = "web-researcher";
	let replacedProfile = false;
	const registeredNames = new Set(listAgents().map((agent) => agent.name));
	if (!registeredNames.has(parentName) || !registeredNames.has("scout") || !registeredNames.has(allowedName)) {
		// The test runner itself may be a restricted nested agent. Replace one
		// inherited non-scout profile with an equivalent recursive fixture so the
		// regression still exercises the real spawn/prompt boundary.
		const fallback = listAgents().find((agent) => agent.name !== "scout");
		assert.ok(fallback, "expected a non-scout profile for the recursive prompt fixture");
		parentName = fallback.name;
		allowedName = fallback.name;
		const bridge = (globalThis as any).__pi_subagents;
		bridge.unregisterAgent(parentName);
		bridge.registerAgent(testAgent(parentName, {
			description: "Allowed nested prompt fixture",
			tools: ["subagent"],
			subagentAgents: ["scout", allowedName],
			systemPrompt: [
				"You are a recursive prompt fixture.",
				"<!-- pi-subagents:dynamic-guidance:start -->",
				`Static registry: scout, ${allowedName}.`,
				"<!-- pi-subagents:dynamic-guidance:end -->",
				"<!-- pi-subagents:profile:scout:start -->",
				"Dispatch scout for codebase reconnaissance.",
				"<!-- pi-subagents:profile:scout:end -->",
				`<!-- pi-subagents:profile:${allowedName}:start -->`,
				`Dispatch ${allowedName} for allowed work.`,
				`<!-- pi-subagents:profile:${allowedName}:end -->`,
			].join("\n\n"),
		}));
		replacedProfile = true;
	}

	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-prompt-test-"));
	const runnerPath = path.join(tempDir, "capture-child.mjs");
	const capturePath = path.join(tempDir, "capture.json");
	fs.writeFileSync(runnerPath, `
import fs from "node:fs";
const promptFlag = process.argv.indexOf("--append-system-prompt");
if (promptFlag < 0 || !process.argv[promptFlag + 1]) throw new Error("missing child prompt path");
fs.writeFileSync(process.env.PI_SUBAGENT_TEST_CAPTURE_PATH, JSON.stringify({
  args: process.argv.slice(2),
  prompt: fs.readFileSync(process.argv[promptFlag + 1], "utf8"),
  allowed: process.env.PI_SUBAGENT_ALLOWED,
  allowlistSet: process.env.PI_SUBAGENT_ALLOWLIST_SET,
}));
`);

	const previousEntry = process.argv[1];
	const previousCapturePath = process.env.PI_SUBAGENT_TEST_CAPTURE_PATH;
	try {
		process.argv[1] = runnerPath;
		process.env.PI_SUBAGENT_TEST_CAPTURE_PATH = capturePath;
		setAgentEnabled("scout", false);
		setAgentEnabled(allowedName, true);

		await tool.execute(
			"capture-prompt",
			{ agent: parentName, task: "Capture the effective nested prompt." },
			undefined,
			undefined,
			{ cwd: process.cwd(), modelRegistry: { getAll: () => [] } },
		);

		const captured = JSON.parse(fs.readFileSync(capturePath, "utf8")) as {
			args: string[];
			prompt: string;
			allowed?: string;
			allowlistSet?: string;
		};
		assert.equal(captured.args.includes("--no-skills"), false, "child startup must retain Pi's normal skill discovery");
		assert.equal(captured.allowed, allowedName);
		assert.equal(captured.allowlistSet, "1");
		assert.doesNotMatch(captured.prompt, /\bscout\b/i);
		assert.match(captured.prompt, new RegExp(JSON.stringify(allowedName)));
		assert.match(captured.prompt, /Only the following profiles are available/);
	} finally {
		setAgentEnabled("scout", true);
		if (previousEntry === undefined) delete process.argv[1];
		else process.argv[1] = previousEntry;
		if (previousCapturePath === undefined) delete process.env.PI_SUBAGENT_TEST_CAPTURE_PATH;
		else process.env.PI_SUBAGENT_TEST_CAPTURE_PATH = previousCapturePath;
		fs.rmSync(tempDir, { recursive: true, force: true });
		if (replacedProfile) {
			extension({ registerCommand: () => {}, registerTool: () => {} } as any);
		}
	}
});

test("registered /agents command uses the non-TUI summary path", async () => {
	clearAllAgentOverrides();
	const plainModel = testModel("openai", "plain", { reasoning: false });
	const commands = new Map<string, any>();
	extension({
		registerCommand: (name: string, command: unknown) => commands.set(name, command),
		registerTool: () => {},
	} as any);
	const displayedAgent = listAgents()[0];
	assert.ok(displayedAgent, "expected at least one bundled subagent");
	setAgentOverride(displayedAgent.name, { model: "openai/plain", thinking: "off" });

	const notifications: Array<{ message: string; level: "info" | "warning" }> = [];
	await commands.get("agents").handler("", {
		mode: "json",
		ui: { notify: (message: string, level: "info" | "warning") => notifications.push({ message, level }) },
		modelRegistry: { refresh: async () => {}, getAll: () => [plainModel] },
	});

	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].level, "info");
	assert.match(notifications[0].message, /^Registered agents:\n/);
	assert.match(notifications[0].message, new RegExp(`${displayedAgent.name} \\[enabled\\]: openai/plain · thinking: off`));
});

test("global bridge layers temporary restrictions over user choices and emits effective changes", () => {
	const emitted: Array<{ event: string; data: { name: string; enabled: boolean } }> = [];
	extension({
		registerCommand: () => {},
		registerTool: () => {},
		events: { emit: (event: string, data: { name: string; enabled: boolean }) => emitted.push({ event, data }) },
	} as any);
	const [allowedAgent, restrictedAgent] = listAgents();
	assert.ok(allowedAgent);
	assert.ok(restrictedAgent);
	const bridge = (globalThis as any).__pi_subagents;

	assert.equal(bridge.setTemporaryAgentRestriction("test-workflow", [allowedAgent.name]), true);
	let metadata = bridge.listAgents().find((agent: any) => agent.name === restrictedAgent.name);
	assert.deepEqual(
		{ enabled: metadata?.enabled, userEnabled: metadata?.userEnabled, temporarilyRestricted: metadata?.temporarilyRestricted },
		{ enabled: false, userEnabled: true, temporarilyRestricted: true },
	);
	assert.ok(emitted.some((entry) => entry.data.name === restrictedAgent.name && entry.data.enabled === false));

	assert.equal(bridge.setAgentEnabled(restrictedAgent.name, false), true);
	assert.equal(bridge.clearTemporaryAgentRestriction("test-workflow"), true);
	metadata = bridge.listAgents().find((agent: any) => agent.name === restrictedAgent.name);
	assert.deepEqual(
		{ enabled: metadata?.enabled, userEnabled: metadata?.userEnabled, temporarilyRestricted: metadata?.temporarilyRestricted },
		{ enabled: false, userEnabled: false, temporarilyRestricted: false },
		"clearing a workflow restriction must not overwrite a /agents choice made while it was active",
	);
	assert.equal(bridge.setAgentEnabled("not-registered", false), false);
	assert.equal(bridge.setTemporaryAgentRestriction("bad", ["not-registered"]), false);
});

test("registered /agents command toggles availability without refreshing models", async () => {
	const commands = new Map<string, any>();
	extension({
		registerCommand: (name: string, command: unknown) => commands.set(name, command),
		registerTool: () => {},
	} as any);
	const displayedAgent = listAgents()[0];
	assert.ok(displayedAgent, "expected at least one bundled subagent");
	let refreshes = 0;
	const notifications: Array<{ message: string; level: "info" | "warning" }> = [];

	await commands.get("agents").handler(`disable ${displayedAgent.name}`, {
		mode: "json",
		ui: { notify: (message: string, level: "info" | "warning") => notifications.push({ message, level }) },
		modelRegistry: { refresh: async () => { refreshes++; }, getAll: () => [] },
	});

	assert.equal(refreshes, 0);
	assert.equal(listAgents().find((agent) => agent.name === displayedAgent.name)?.enabled, false);
	assert.match(notifications[0].message, /is now disabled/);
});

test("failure classification is conservative across observable child outcomes", () => {
	assert.deepEqual(classifySubagentOutcome({ cancelled: false, spawnError: "ENOENT", exitCode: 1, sideEffectsMayHaveOccurred: false }), {
		outcome: { status: "failed", classification: "spawn_failure", message: "ENOENT" },
		retryability: "retryable",
	});
	assert.deepEqual(classifySubagentOutcome({ cancelled: false, providerError: "quota", exitCode: 0, sideEffectsMayHaveOccurred: true }), {
		outcome: { status: "failed", classification: "provider_failure", message: "quota" },
		retryability: "unknown",
	});
	assert.equal(classifySubagentOutcome({ cancelled: true, exitCode: 1, sideEffectsMayHaveOccurred: false }).outcome.classification, "cancelled");
	assert.deepEqual(classifySubagentOutcome({ cancelled: false, exitCode: 7, error: "child stderr", sideEffectsMayHaveOccurred: true }), {
		outcome: { status: "failed", classification: "nonzero_exit", message: "child stderr" },
		retryability: "unknown",
	});
	assert.equal(classifySubagentOutcome({ cancelled: false, exitCode: 0, error: "unclassified", sideEffectsMayHaveOccurred: false }).outcome.classification, "failure");
});

test("failed execution returns stable invocation context and partial evidence without replay", async () => {
	const tools: any[] = [];
	extension({ registerCommand: () => {}, registerTool: (tool: unknown) => tools.push(tool) } as any);
	const tool = tools[0];
	const displayedAgent = listAgents()[0];
	assert.ok(displayedAgent);

	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-failure-test-"));
	const runnerPath = path.join(tempDir, "failing-child.mjs");
	fs.writeFileSync(runnerPath, `
process.stdout.write(JSON.stringify({ type: "tool_execution_start", toolName: "edit", toolCallId: "partial-tool", args: { path: "changed.ts" } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial child output" }] } }) + "\\n");
process.stderr.write("child failed after partial work\\n");
process.exitCode = 7;
`);
	const previousEntry = process.argv[1];
	try {
		process.argv[1] = runnerPath;
		const result = await tool.execute(
			"logical-call-123",
			{ agent: displayedAgent.name, task: "Perform one bounded task.", cwd: tempDir },
			undefined,
			undefined,
			{ cwd: process.cwd(), modelRegistry: { getAll: () => [] } },
		);
		assert.equal(result.isError, true);
		const evidence = result.details.results[0];
		assert.equal(evidence.invocationId, "logical-call-123");
		assert.deepEqual(evidence.attempt, { number: 1, maxAttempts: 1 });
		assert.deepEqual(evidence.context, {
			agent: displayedAgent.name,
			task: "Perform one bounded task.",
			cwd: tempDir,
			model: evidence.model,
			thinking: displayedAgent.thinking,
		});
		assert.deepEqual(evidence.outcome, { status: "failed", classification: "nonzero_exit", message: "child failed after partial work" });
		assert.equal(evidence.output, "partial child output");
		assert.equal(evidence.progress.recentTools[0].tool, "edit");
		assert.equal(evidence.sideEffectsMayHaveOccurred, true);
		assert.equal(evidence.retryability, "unknown");
	} finally {
		if (previousEntry === undefined) delete process.argv[1];
		else process.argv[1] = previousEntry;
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("normal tasks over eight KiB reach the child while checkpoint snapshots stay bounded", async () => {
	const entries: any[] = [];
	const tools: any[] = [];
	extension({
		registerCommand: () => {},
		registerTool: (tool: unknown) => tools.push(tool),
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
	} as any);
	const displayedAgent = listAgents()[0];
	assert.ok(displayedAgent);

	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-long-task-test-"));
	const runnerPath = path.join(tempDir, "capture-long-task.mjs");
	const capturePath = path.join(tempDir, "captured-task.txt");
	fs.writeFileSync(runnerPath, `
import fs from "node:fs";
const taskArg = process.argv.slice(2).find((arg) => arg.startsWith("@"));
if (!taskArg) throw new Error("expected long task file argument");
fs.writeFileSync(process.env.PI_SUBAGENT_LONG_TASK_CAPTURE, fs.readFileSync(taskArg.slice(1), "utf8"));
process.stderr.write("intentional checkpoint failure\\n");
process.exitCode = 7;
`);
	const longTask = "ordinary task payload ".repeat(500);
	assert.ok(Buffer.byteLength(longTask, "utf8") > 8 * 1024);
	const previousEntry = process.argv[1];
	const previousCapture = process.env.PI_SUBAGENT_LONG_TASK_CAPTURE;
	try {
		process.argv[1] = runnerPath;
		process.env.PI_SUBAGENT_LONG_TASK_CAPTURE = capturePath;
		const failed = await tools[0].execute(
			"long-normal-task",
			{ agent: displayedAgent.name, task: longTask, cwd: tempDir },
			undefined,
			undefined,
			{ cwd: tempDir, modelRegistry: { getAll: () => [] } },
		);

		assert.equal(failed.isError, true);
		assert.equal(fs.readFileSync(capturePath, "utf8"), `Task: ${longTask}`);
		assert.equal(failed.details.results[0].context.task, longTask);
		assert.equal(entries.length, 1);
		assert.equal(entries[0].data.kind, "failure");
		assert.ok(Buffer.byteLength(entries[0].data.evidence.task, "utf8") <= 8 * 1024);
		assert.notEqual(entries[0].data.evidence.task, longTask);
	} finally {
		if (previousEntry === undefined) delete process.argv[1];
		else process.argv[1] = previousEntry;
		if (previousCapture === undefined) delete process.env.PI_SUBAGENT_LONG_TASK_CAPTURE;
		else process.env.PI_SUBAGENT_LONG_TASK_CAPTURE = previousCapture;
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("durable branch restoration links one fresh repair and treats unfinished repairs as interrupted", async () => {
	const entries: any[] = [];
	const firstTools: any[] = [];
	const firstEvents = new Map<string, any>();
	extension({
		registerCommand: () => {},
		registerTool: (tool: unknown) => firstTools.push(tool),
		on: (name: string, handler: unknown) => firstEvents.set(name, handler),
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
	} as any);
	const displayedAgent = listAgents()[0];
	assert.ok(displayedAgent);

	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-checkpoint-test-"));
	const failingRunner = path.join(tempDir, "failing.mjs");
	const repairRunner = path.join(tempDir, "repair.mjs");
	const capturePath = path.join(tempDir, "repair-args.json");
	fs.writeFileSync(failingRunner, `
+for (let i = 0; i < 25; i++) process.stdout.write(JSON.stringify({ type: "tool_execution_start", toolName: "edit", toolCallId: "t" + i, args: { path: "changed-" + i + ".ts" } }) + "\\n");
+process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "partial evidence" }] } }) + "\\n");
+process.stderr.write("repairable failure\\n");
+process.exitCode = 7;
+`.replace(/^\+/gm, ""));
	fs.writeFileSync(repairRunner, `
+import fs from "node:fs";
+fs.writeFileSync(process.env.PI_SUBAGENT_REPAIR_CAPTURE, JSON.stringify(process.argv.slice(2)));
+process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "repair complete" }] } }) + "\\n");
+`.replace(/^\+/gm, ""));

	const previousEntry = process.argv[1];
	const previousCapture = process.env.PI_SUBAGENT_REPAIR_CAPTURE;
	try {
		process.argv[1] = failingRunner;
		const failed = await firstTools[0].execute(
			"failed-original",
			{ agent: displayedAgent.name, task: "Fix the parser once.", cwd: tempDir },
			undefined,
			undefined,
			{ cwd: tempDir, modelRegistry: { getAll: () => [] } },
		);
		assert.equal(failed.isError, true);
		assert.equal(entries.length, 1, "failure checkpoint is appended before the terminal result returns");
		assert.equal(entries[0].customType, SUBAGENT_CHECKPOINT_TYPE);
		assert.equal(entries[0].data.kind, "failure");
		assert.equal(entries[0].data.version, 1);
		assert.equal(entries[0].data.evidence.recentTools.length, 20);
		assert.ok(Buffer.byteLength(JSON.stringify(entries[0].data), "utf8") <= 64 * 1024);

		// A branch containing only repair-started keeps the target unresolved and
		// marks the now-nonexistent child as interrupted rather than resumable.
		const interrupted = restoreSubagentCheckpoints([
			entries[0],
			{ type: "custom", customType: SUBAGENT_CHECKPOINT_TYPE, data: {
				version: 1,
				kind: "repair-started",
				invocationId: "repair-interrupted",
				repairOfInvocationId: "failed-original",
				objective: "repair it",
				recordedAt: Date.now(),
			} },
		]);
		assert.deepEqual(interrupted[0].interruptedRepairInvocationIds, ["repair-interrupted"]);

		const secondTools: any[] = [];
		const secondEvents = new Map<string, any>();
		extension({
			registerCommand: () => {},
			registerTool: (tool: unknown) => secondTools.push(tool),
			on: (name: string, handler: unknown) => secondEvents.set(name, handler),
			appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		} as any);
		await secondEvents.get("session_start")({}, { sessionManager: { getBranch: () => [...entries] } });

		await assert.rejects(
			secondTools[0].execute("bad-repair", { agent: displayedAgent.name, task: "No guessing.", repairOfInvocationId: "other-branch" }, undefined, undefined, { cwd: tempDir, modelRegistry: { getAll: () => [] } }),
			/not a restorable unresolved failed\/cancelled checkpoint on this branch/,
		);

		process.argv[1] = repairRunner;
		process.env.PI_SUBAGENT_REPAIR_CAPTURE = capturePath;
		const repaired = await secondTools[0].execute(
			"repair-new-id",
			{ agent: displayedAgent.name, task: "Repair only the parser assertion.", cwd: tempDir, repairOfInvocationId: "failed-original" },
			undefined,
			undefined,
			{ cwd: tempDir, modelRegistry: { getAll: () => [] } },
		);
		assert.equal(repaired.isError, undefined);
		assert.equal(repaired.details.results[0].invocationId, "repair-new-id");
		assert.equal(repaired.details.results[0].repairOfInvocationId, "failed-original");
		assert.deepEqual(entries.slice(-2).map((entry) => entry.data.kind), ["repair-started", "repair-finished"]);
		const childArgs = JSON.parse(fs.readFileSync(capturePath, "utf8")).join(" ");
		assert.match(childArgs, /Explicit repair objective/);
		assert.match(childArgs, /Repair only the parser assertion/);
		assert.match(childArgs, /failed-original/);
		assert.equal(restoreSubagentCheckpoints(entries).length, 0, "successful linked repair resolves the chain after restart");
	} finally {
		if (previousEntry === undefined) delete process.argv[1];
		else process.argv[1] = previousEntry;
		if (previousCapture === undefined) delete process.env.PI_SUBAGENT_REPAIR_CAPTURE;
		else process.env.PI_SUBAGENT_REPAIR_CAPTURE = previousCapture;
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});

test("unresolved failure prompt exposure is limited to five chains and twelve KiB", () => {
	const entries = Array.from({ length: 60 }, (_, index) => ({
		type: "custom",
		customType: SUBAGENT_CHECKPOINT_TYPE,
		data: {
			version: 1,
			kind: "failure",
			evidence: {
				invocationId: `failure-${index}`,
				agent: "worker",
				task: "x".repeat(8000),
				cwd: "/tmp",
				model: "test/model",
				thinking: "medium",
				status: "failed",
				classification: "failure",
				message: "boom",
				output: "y".repeat(16000),
				exitCode: 1,
				sideEffectsMayHaveOccurred: false,
				retryability: "unknown",
				recentTools: [],
				recordedAt: index,
			},
		},
	}));
	const restored = restoreSubagentCheckpoints(entries);
	assert.equal(restored.length, 50);
	assert.equal(restored[0].invocationId, "failure-10");
	const prompt = formatRestorableFailurePrompt(restored);
	assert.ok(Buffer.byteLength(prompt, "utf8") <= 12 * 1024);
	assert.doesNotMatch(prompt, /failure-54/);
	assert.match(prompt, /failure-55/);
	assert.match(prompt, /failure-59/);
});

test("subagent execution distinguishes disabled profiles from unknown names before spawning", async () => {
	const tools: any[] = [];
	extension({ registerCommand: () => {}, registerTool: (tool: unknown) => tools.push(tool) } as any);
	const tool = tools[0];
	const displayedAgent = listAgents()[0];
	assert.ok(displayedAgent);
	setAgentEnabled(displayedAgent.name, false);
	const ctx = { cwd: process.cwd(), modelRegistry: { getAll: () => [] } };

	await assert.rejects(
		tool.execute("disabled", { agent: displayedAgent.name, task: "do not spawn" }, undefined, undefined, ctx),
		new RegExp(`Agent is disabled for this session: ${displayedAgent.name}`),
	);
	setAgentEnabled(displayedAgent.name, true);
	setTemporaryAgentRestriction("test-workflow", []);
	await assert.rejects(
		tool.execute("restricted", { agent: displayedAgent.name, task: "do not spawn" }, undefined, undefined, ctx),
		new RegExp(`temporarily unavailable.*${displayedAgent.name}`),
	);
	clearTemporaryAgentRestriction("test-workflow");
	const previousWorkflow = (globalThis as any).__pi_workflow;
	try {
		(globalThis as any).__pi_workflow = {
			canRunAgent: () => ({ allowed: false, reason: "Workflow enforcement is unavailable." }),
		};
		await assert.rejects(
			tool.execute("workflow-blocked", { agent: displayedAgent.name, task: "do not spawn" }, undefined, undefined, ctx),
			/Workflow enforcement is unavailable/,
		);
	} finally {
		(globalThis as any).__pi_workflow = previousWorkflow;
	}
	await assert.rejects(
		tool.execute("unknown", { agent: "not-registered", task: "do not spawn" }, undefined, undefined, ctx),
		/Unknown agent: not-registered/,
	);
});

test("settings wizard applies only after agent, model, and reasoning are selected", async () => {
	clearAllAgentOverrides();
	const plainModel = testModel("openai", "plain", { reasoning: false });
	const deepModel = testModel("anthropic", "deep", {
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", max: null },
	});
	const worker = testAgent("worker", { model: "openai/plain", thinking: "off" });
	const scout = testAgent("scout", { model: "openai/plain", thinking: "off" });

	const { result, calls, notifications } = await runWizardWithPicks(
		[worker, scout],
		[plainModel, deepModel],
		["worker", "anthropic/deep", "xhigh"],
	);

	assert.equal(result, true);
	assert.deepEqual(getAgentOverride("worker"), { model: "anthropic/deep", thinking: "xhigh" });
	assert.equal(getAgentOverride("scout"), undefined);
	assert.equal(resolveEffectiveAgentSettings(worker, [plainModel, deepModel]).thinking, "xhigh");
	assert.equal(resolveEffectiveAgentSettings(scout, [plainModel, deepModel]).model, "openai/plain");
	assert.equal(calls.length, 3);
	assert.deepEqual(calls[1].items.map((item) => item.value), ["anthropic/deep", "openai/plain"]);
	assert.equal(calls[0].fuzzySearch, undefined);
	assert.equal(calls[1].fuzzySearch, true);
	assert.equal(calls[2].fuzzySearch, undefined);
	assert.deepEqual(calls[2].items.map((item) => item.value), getSupportedThinkingLevels(deepModel));
	assert.equal(calls[2].currentValue, "off");
	assert.deepEqual(notifications, [{ message: "Updated worker: anthropic/deep · thinking: xhigh", level: "info" }]);
});

test("settings wizard cancellation at any stage does not commit a partial override", async (t) => {
	const plainModel = testModel("openai", "plain", { reasoning: false });
	const deepModel = testModel("anthropic", "deep", { reasoning: true });
	const worker = testAgent("worker", { model: "openai/plain", thinking: "off" });
	const cases: Array<{ name: string; picks: Array<string | undefined>; expectedCalls: number }> = [
		{ name: "agent", picks: [undefined], expectedCalls: 1 },
		{ name: "model", picks: ["worker", undefined], expectedCalls: 2 },
		{ name: "reasoning", picks: ["worker", "anthropic/deep", undefined], expectedCalls: 3 },
	];

	for (const entry of cases) {
		await t.test(`${entry.name} cancellation`, async () => {
			clearAllAgentOverrides();
			const { result, calls, notifications } = await runWizardWithPicks([worker], [plainModel, deepModel], entry.picks);

			assert.equal(result, false);
			assert.equal(calls.length, entry.expectedCalls);
			assert.equal(getAgentOverride("worker"), undefined);
			assert.deepEqual(notifications, []);
		});
	}
});

test("child CLI model/thinking args consume the effective per-agent override", () => {
	clearAllAgentOverrides();
	const plainModel = testModel("openai", "plain", { reasoning: false });
	const deepModel = testModel("anthropic", "deep", {
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", max: null },
	});
	const worker = testAgent("worker", { model: "openai/plain", thinking: "off" });

	setAgentOverride("worker", { model: "anthropic/deep", thinking: "xhigh" });
	const effective = resolveEffectiveAgentSettings(worker, [plainModel, deepModel]);
	const args = ["--mode", "json"];
	appendSubagentModelThinkingArgs(args, effective);

	assert.deepEqual(args, ["--mode", "json", "--model", "anthropic/deep", "--thinking", "xhigh"]);
	assert.equal(worker.model, "openai/plain");
	assert.equal(worker.thinking, "off");
});

test("extension init resets session-only overrides so they do not persist", () => {
	clearAllAgentOverrides();
	clearAllAgentAvailabilityOverrides();
	setAgentOverride("worker", { model: "anthropic/deep", thinking: "high" });
	setAgentEnabled("worker", false);
	setTemporaryAgentRestriction("test-workflow", []);
	assert.deepEqual(getAgentOverride("worker"), { model: "anthropic/deep", thinking: "high" });
	assert.equal(isAgentEnabled("worker"), false);

	const commands = new Map<string, unknown>();
	const tools: unknown[] = [];
	extension({
		registerCommand: (name: string, command: unknown) => commands.set(name, command),
		registerTool: (tool: unknown) => tools.push(tool),
	} as any);

	assert.equal(getAgentOverride("worker"), undefined);
	assert.equal(isAgentEnabled("worker"), true);
	assert.equal(isAgentTemporarilyRestricted("worker"), false);
	assert.equal(commands.has("agents"), true);
	assert.equal(tools.length, 1);
});
