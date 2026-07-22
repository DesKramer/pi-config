import assert from "node:assert/strict";
import test from "node:test";
import usageExtension, { collectSessionUsage } from "../extensions/usage.ts";

function assistantEntry(cost: number, id: string) {
	return {
		type: "message",
		id,
		timestamp: "2026-07-20T12:00:00.000Z",
		message: {
			role: "assistant",
			timestamp: Date.parse("2026-07-20T12:00:00.000Z"),
			provider: "test",
			model: "main",
			content: [{ type: "text", text: id }],
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
			},
		},
	};
}

function subagentResult(agent: string, cost: number, children: unknown[] = []) {
	return {
		agent,
		model: "test/child",
		task: `run ${agent}`,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost, turns: 1 },
		progress: {
			recentTools: children.length > 0 ? [{ tool: "subagent", children }] : [],
		},
	};
}

function subagentEntry(results: unknown[]) {
	return {
		type: "message",
		timestamp: "2026-07-20T12:00:01.000Z",
		message: {
			role: "toolResult",
			toolName: "subagent",
			toolCallId: "call-1",
			timestamp: Date.parse("2026-07-20T12:00:01.000Z"),
			details: { results },
		},
	};
}

test("session usage combines main, direct subagent, and nested subagent USD", () => {
	const grandchild = subagentResult("grandchild", 0.03);
	const child = subagentResult("child", 0.07, [grandchild]);
	const parent = subagentResult("parent", 0.20, [child]);

	const total = collectSessionUsage([
		assistantEntry(0.10, "main-1"),
		subagentEntry([parent]),
		assistantEntry(0.05, "main-2"),
	]);

	assert.ok(Math.abs(total.mainUsd - 0.15) < 1e-12);
	assert.ok(Math.abs(total.subagentUsd - 0.30) < 1e-12);
	assert.ok(Math.abs(total.totalUsd - 0.45) < 1e-12);
});

test("usage-session command totals only the active branch and shows one USD output", async () => {
	const commands = new Map<string, any>();
	usageExtension({
		registerEntryRenderer: () => {},
		registerCommand: (name: string, command: unknown) => commands.set(name, command),
	} as any);

	const notifications: Array<{ message: string; level: string }> = [];
	let waited = false;
	await commands.get("usage-session").handler("", {
		waitForIdle: async () => { waited = true; },
		sessionManager: {
			getBranch: () => [assistantEntry(0.12, "active")],
			getEntries: () => [assistantEntry(0.12, "active"), assistantEntry(99, "inactive")],
		},
		ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
	});

	assert.equal(waited, true);
	assert.deepEqual(notifications, [{ message: "Session total: $0.12", level: "info" }]);
});

test("session usage ignores entries without billable usage", () => {
	assert.deepEqual(collectSessionUsage([
		{ type: "message", message: { role: "assistant" } },
		subagentEntry([{ agent: "missing", progress: { recentTools: [] } }]),
	]), { mainUsd: 0, subagentUsd: 0, totalUsd: 0 });
});
