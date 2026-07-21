import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import extension, {
	appendSubagentModelThinkingArgs,
	buildAgentItems,
	buildModelItems,
	buildThinkingItems,
	filterSelectItems,
	formatAgentsSummary,
	listAgents,
	runAgentSettingsWizard,
	type AgentConfig,
	type AgentSettingsPickOptions,
} from "../extensions/pi-subagents/index.ts";
import {
	canonicalModelRef,
	clearAgentOverride,
	clearAllAgentOverrides,
	getAgentOverride,
	resolveEffectiveAgentSettings,
	resolveModelRef,
	setAgentOverride,
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
	assert.equal(agentItems.length, 1);
	assert.equal(agentItems[0].value, "worker");
	assert.match(agentItems[0].description ?? "", /does focused work/);
	assert.match(agentItems[0].description ?? "", /openai\/plain · thinking: off/);
	assert.match(agentItems[0].description ?? "", /tools: read, edit/);

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

test("non-TUI summary uses effective settings display data", () => {
	clearAllAgentOverrides();
	const plainModel = testModel("openai", "plain", { reasoning: false });
	const deepModel = testModel("anthropic", "deep", { reasoning: true });
	const worker = testAgent("worker", { tools: ["read", "write"], model: "anthropic/deep", thinking: "medium" });
	const scout = testAgent("scout", { tools: [], model: "openai/plain", thinking: "high" });

	setAgentOverride("worker", { model: "openai/plain", thinking: "off" });

	assert.equal(
		formatAgentsSummary([worker, scout], [plainModel, deepModel]),
		"worker: openai/plain · thinking: off (read, write)\nscout: openai/plain · thinking: off (no tools)",
	);
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
	await commands.get("agents").handler([], {
		mode: "json",
		ui: { notify: (message: string, level: "info" | "warning") => notifications.push({ message, level }) },
		modelRegistry: { refresh: async () => {}, getAll: () => [plainModel] },
	});

	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].level, "info");
	assert.match(notifications[0].message, /^Available agents:\n/);
	assert.match(notifications[0].message, new RegExp(`${displayedAgent.name}: openai/plain · thinking: off`));
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
	setAgentOverride("worker", { model: "anthropic/deep", thinking: "high" });
	assert.deepEqual(getAgentOverride("worker"), { model: "anthropic/deep", thinking: "high" });

	const commands = new Map<string, unknown>();
	const tools: unknown[] = [];
	extension({
		registerCommand: (name: string, command: unknown) => commands.set(name, command),
		registerTool: (tool: unknown) => tools.push(tool),
	} as any);

	assert.equal(getAgentOverride("worker"), undefined);
	assert.equal(commands.has("agents"), true);
	assert.equal(tools.length, 1);
});
