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

test("orchestrator requires bounded repair delegations with prior failure evidence", () => {
	const layer = buildLayer();
	assert.match(layer, /Never silently retry/);
	assert.match(layer, /separate,\s+bounded delegation/);
	assert.match(layer, /Prior failure evidence: <invocation ID; attempt; classification and message; original agent\/task\/cwd\/model\/thinking; partial output\/tool evidence; sideEffectsMayHaveOccurred; retryability>/);
	assert.match(layer, /Repair boundary: <what remains, what must not be replayed/);
});

test("orchestrator runs QA once after the complete worker change cycle", () => {
	const previous = (globalThis as any).__pi_subagents;
	try {
		(globalThis as any).__pi_subagents = {
			listAgents: () => [
				{ name: "worker", description: "Writes code", tools: ["read", "edit"], enabled: true },
				{ name: "qa", description: "Checks integrated changes", tools: ["read"], enabled: true },
			],
		};
		const layer = buildLayer();
		assert.match(layer, /Verify once per completed change cycle/);
		assert.match(layer, /Do\s+not dispatch a verification profile for an individual implementation result\s+while that cycle still has changes pending/);
		assert.match(layer, /after all planned worker changes are integrated, use qa once on the complete change set/);
		assert.match(layer, /never verify each worker change separately/);
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
