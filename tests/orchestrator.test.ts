import assert from "node:assert/strict";
import test from "node:test";
import orchestratorExtension, { buildLayer, isWorkflowRunning, loadRegistry } from "../extensions/orchestrator/index.ts";

test("orchestrator registry advertises only live enabled agents without stale caches", () => {
	const previous = (globalThis as any).__pi_subagents;
	try {
		let metadata = [
			{ name: "worker", description: "Writes code", tools: ["read", "edit"], enabled: true },
			{ name: "qa", description: "Checks code", tools: ["read"], enabled: false },
		];
		(globalThis as any).__pi_subagents = { listAgents: () => metadata };

		assert.deepEqual(loadRegistry().map((agent) => agent.name), ["worker"]);
		assert.match(buildLayer(), /\| worker \| Writes code \| read, edit \|/);
		assert.doesNotMatch(buildLayer(), /\bqa\b/i);

		metadata = [{ name: "qa", description: "Checks code", tools: ["read"], enabled: true }];
		assert.deepEqual(loadRegistry().map((agent) => agent.name), ["qa"]);
		assert.match(buildLayer(), /\| qa \| Checks code \| read \|/);
		assert.doesNotMatch(buildLayer(), /\bworker\b/i);
	} finally {
		(globalThis as any).__pi_subagents = previous;
	}
});

test("orchestrator explicitly handles an empty enabled registry", () => {
	const previous = (globalThis as any).__pi_subagents;
	try {
		(globalThis as any).__pi_subagents = { listAgents: () => [] };
		assert.match(buildLayer(), /No subagent profiles are currently enabled/);
	} finally {
		(globalThis as any).__pi_subagents = previous;
	}
});

test("orchestrator yields prompt ownership to a running workflow and resumes afterward", async () => {
	const previousWorkflow = (globalThis as any).__pi_workflow;
	const handlers = new Map<string, any>();
	let running = false;
	try {
		(globalThis as any).__pi_workflow = { isRunning: () => running };
		orchestratorExtension({
			registerCommand: () => {},
			on: (event: string, handler: unknown) => handlers.set(event, handler),
		} as any);
		const beforeAgentStart = handlers.get("before_agent_start");

		assert.equal(isWorkflowRunning(), false);
		const normal = await beforeAgentStart({ systemPrompt: "base" });
		assert.match(normal.systemPrompt, /base\n\n## Orchestration Mode/);

		running = true;
		assert.equal(isWorkflowRunning(), true);
		assert.equal(await beforeAgentStart({ systemPrompt: "base" }), undefined);

		running = false;
		assert.match((await beforeAgentStart({ systemPrompt: "base" })).systemPrompt, /## Orchestration Mode/);
		(globalThis as any).__pi_workflow = { isRunning: () => { throw new Error("bridge failure"); } };
		assert.equal(isWorkflowRunning(), true);
		assert.equal(await beforeAgentStart({ systemPrompt: "base" }), undefined);
	} finally {
		(globalThis as any).__pi_workflow = previousWorkflow;
	}
});
