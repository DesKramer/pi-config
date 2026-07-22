import assert from "node:assert/strict";
import test from "node:test";
import {
	checkMem0Health,
	createMem0Extension,
	DEFAULT_MEM0_OSS_URL,
	MEM0_MAX_INJECTION_CHARS,
	MEM0_MAX_RECALL_MEMORIES,
	resolveMem0Config,
	resetMem0WarningForTests,
	type FetchLike,
	type Mem0ExtensionOptions,
} from "../extensions/mem0.ts";

type FetchCall = { input: string; init?: RequestInit };
type FetchResponse = { status: number; ok?: boolean; statusText?: string; json?: unknown; text?: string };
type Command = { handler: (args: string, ctx: any) => unknown };
type Tool = { promptGuidelines?: string[]; execute: (...args: any[]) => unknown; [key: string]: any };
type ExecCall = { command: string; args: string[]; options?: any };

type FakeRegistration = {
	commands: Map<string, Command>;
	events: Map<string, (event: any, ctx: any) => unknown>;
	tools: Map<string, Tool>;
	execCalls: ExecCall[];
};

function fakeFetch(sequence: Array<FetchResponse | Error>) {
	const calls: FetchCall[] = [];
	const fetchFn: FetchLike = async (input, init) => {
		calls.push({ input, init });
		const next = sequence.shift();
		if (!next) throw new Error("unexpected fetch call");
		if (next instanceof Error) throw next;
		return {
			ok: next.ok ?? (next.status >= 200 && next.status < 300),
			status: next.status,
			statusText: next.statusText,
			...("json" in next ? { json: async () => next.json } : {}),
			...("text" in next ? { text: async () => next.text ?? "" } : {}),
		};
	};
	return { fetchFn, calls };
}

function registerMem0(
	options: Mem0ExtensionOptions,
	execImpl: (command: string, args: string[], options?: any) => Promise<{ code: number; stdout: string; stderr?: string }> = async () => ({
		code: 0,
		stdout: "/tmp/project\n",
	}),
): FakeRegistration {
	const commands = new Map<string, Command>();
	const events = new Map<string, (event: any, ctx: any) => unknown>();
	const tools = new Map<string, Tool>();
	const execCalls: ExecCall[] = [];
	createMem0Extension(options)({
		on: (name: string, handler: (event: any, ctx: any) => unknown) => events.set(name, handler),
		registerCommand: (name: string, command: Command) => commands.set(name, command),
		registerTool: (tool: Tool) => tools.set(tool.name, tool),
		exec: async (command: string, args: string[], execOptions?: any) => {
			execCalls.push({ command, args, options: execOptions });
			return execImpl(command, args, execOptions);
		},
	} as any);
	return { commands, events, tools, execCalls };
}

function requestBody(call: FetchCall): any {
	return JSON.parse(String((call.init as any)?.body));
}

function fakeCtx(sessionId: string | null = "session-1") {
	const notifications: Array<{ message: string; level: string }> = [];
	const statuses: Array<{ key: string; value: string | undefined }> = [];
	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd: "/tmp/project",
		ui: {
			theme: { fg: (color: string, text: string) => `[${color}]${text}` },
			setStatus: (key: string, value: string | undefined) => statuses.push({ key, value }),
			notify: (message: string, level: string) => notifications.push({ message, level }),
		},
		sessionManager: sessionId === null ? {} : { getSessionId: () => sessionId },
	};
	return { ctx, notifications, statuses };
}

function waitForMicrotasks(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

test("env defaults MEM0_OSS_URL and falls back to OS username", () => {
	assert.deepEqual(
		resolveMem0Config({ MEM0_OSS_API_KEY: " secret " }, () => "os-user"),
		{ baseUrl: DEFAULT_MEM0_OSS_URL, apiKey: "secret", userId: "os-user" },
	);

	assert.deepEqual(
		resolveMem0Config({ MEM0_OSS_URL: " http://mem0.example:8888/ ", MEM0_OSS_API_KEY: "k", MEM0_USER_ID: " alice " }, () => "os-user"),
		{ baseUrl: "http://mem0.example:8888", apiKey: "k", userId: "alice" },
	);

	assert.deepEqual(
		resolveMem0Config({}, () => "os-user"),
		{ baseUrl: DEFAULT_MEM0_OSS_URL, apiKey: undefined, userId: "os-user" },
	);
});

test("health classification covers unconfigured, offline, unauthorized, server_error, and ready", async (t) => {
	await t.test("unconfigured does not call fetch", async () => {
		let called = false;
		const result = await checkMem0Health({
			env: {},
			getOsUsername: () => "alice",
			fetchFn: async () => {
				called = true;
				return { status: 200 };
			},
		});
		assert.equal(result.status, "unconfigured");
		assert.equal(called, false);
	});

	await t.test("offline when root fetch fails", async () => {
		const { fetchFn } = fakeFetch([new Error("ECONNREFUSED")]);
		const result = await checkMem0Health({ env: { MEM0_OSS_API_KEY: "secret" }, getOsUsername: () => "alice", fetchFn });
		assert.equal(result.status, "offline");
		assert.equal(result.endpoint, "/");
		assert.match(result.message, /ECONNREFUSED/);
	});

	await t.test("unauthorized when authenticated memories probe is rejected", async () => {
		const { fetchFn } = fakeFetch([{ status: 200 }, { status: 401 }]);
		const result = await checkMem0Health({ env: { MEM0_OSS_API_KEY: "bad" }, getOsUsername: () => "alice", fetchFn });
		assert.equal(result.status, "unauthorized");
		assert.equal(result.endpoint, "/memories");
		assert.equal(result.httpStatus, 401);
	});

	await t.test("server_error when Mem0 returns a 5xx", async () => {
		const { fetchFn } = fakeFetch([{ status: 200 }, { status: 503, statusText: "Unavailable" }]);
		const result = await checkMem0Health({ env: { MEM0_OSS_API_KEY: "secret" }, getOsUsername: () => "alice", fetchFn });
		assert.equal(result.status, "server_error");
		assert.equal(result.endpoint, "/memories");
		assert.equal(result.httpStatus, 503);
		assert.match(result.message, /Unavailable/);
	});

	await t.test("ready after root and memories probes succeed", async () => {
		const { fetchFn } = fakeFetch([{ status: 200 }, { status: 200 }]);
		const result = await checkMem0Health({ env: { MEM0_OSS_API_KEY: "secret" }, getOsUsername: () => "alice", fetchFn });
		assert.equal(result.status, "ready");
		assert.match(result.message, /alice/);
	});
});

test("health makes exactly nonmutating root and authenticated memories GET requests", async () => {
	const { fetchFn, calls } = fakeFetch([{ status: 200 }, { status: 200 }]);
	const result = await checkMem0Health({
		env: { MEM0_OSS_URL: "http://mem0.local", MEM0_OSS_API_KEY: "secret", MEM0_USER_ID: "alice" },
		fetchFn,
		timeoutMs: 123,
	});

	assert.equal(result.status, "ready");
	assert.equal(calls.length, 2);
	assert.equal(calls[0].input, "http://mem0.local/");
	assert.equal(calls[0].init?.method, "GET");
	assert.equal(calls[0].init?.headers, undefined);
	assert.equal((calls[0].init as any).body, undefined);
	assert.ok(calls[0].init?.signal instanceof AbortSignal);

	assert.equal(calls[1].input, "http://mem0.local/memories?user_id=alice&limit=1");
	assert.equal(calls[1].init?.method, "GET");
	assert.deepEqual(calls[1].init?.headers, { "X-API-Key": "secret" });
	assert.equal((calls[1].init as any).body, undefined);
	assert.ok(calls[1].init?.signal instanceof AbortSignal);
});

test("session_start is non-blocking, fail-open, and warns unhealthy at most once", async () => {
	resetMem0WarningForTests();
	let fetchCalls = 0;
	const fetchFn: FetchLike = async () => {
		fetchCalls += 1;
		throw new Error("offline");
	};
	const { events } = registerMem0({ env: { MEM0_OSS_API_KEY: "secret" }, fetchFn, getOsUsername: () => "alice" });
	const { ctx, notifications, statuses } = fakeCtx();
	const sessionStart = events.get("session_start");
	assert.ok(sessionStart);

	const returned = sessionStart({}, ctx);
	assert.equal(returned, undefined, "startup must not await the health check");
	assert.deepEqual(statuses[0], { key: "mem0", value: "[dim]mem0: checking" });

	await waitForMicrotasks();
	assert.equal(fetchCalls, 1);
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].level, "warning");
	assert.match(notifications[0].message, /Mem0 offline/);
	assert.ok(statuses.some((entry) => entry.value === "[warning]mem0: offline"));

	sessionStart({}, ctx);
	await waitForMicrotasks();
	assert.equal(fetchCalls, 2);
	assert.equal(notifications.length, 1, "second unhealthy startup should not warn again in the same process");
});

test("before_agent_start recalls bounded untrusted memories with scoped POST payload", async () => {
	const long = "x".repeat(MEM0_MAX_INJECTION_CHARS + 1000);
	const { fetchFn, calls } = fakeFetch([
		{
			status: 200,
			json: {
				results: [
					{ id: "1", memory: "prefers TypeScript", score: 0.9 },
					{ id: "2", memory: long, score: 0.8 },
					{ id: "3", memory: "extra" },
					{ id: "4", memory: "extra" },
					{ id: "5", memory: "extra" },
					{ id: "6", memory: "must be ignored" },
				],
			},
		},
	]);
	const { events, execCalls } = registerMem0({
		env: { MEM0_OSS_URL: "http://mem0.local/", MEM0_OSS_API_KEY: "secret", MEM0_USER_ID: "alice" },
		fetchFn,
	}, async () => ({ code: 0, stdout: "/secret/raw/project\n" }));
	const { ctx } = fakeCtx("run-123");
	ctx.cwd = "/secret/raw/project/subdir";

	const beforeAgentStart = events.get("before_agent_start");
	assert.ok(beforeAgentStart);
	const result = await beforeAgentStart({ prompt: "What should I know?", systemPrompt: "base prompt" }, ctx) as any;

	assert.equal(calls.length, 1);
	assert.equal(calls[0].input, "http://mem0.local/search");
	assert.equal(calls[0].init?.method, "POST");
	assert.deepEqual(calls[0].init?.headers, { "Content-Type": "application/json", "X-API-Key": "secret" });
	assert.ok(calls[0].init?.signal instanceof AbortSignal);
	const body = requestBody(calls[0]);
	assert.equal(body.query, "What should I know?");
	assert.equal(body.top_k, MEM0_MAX_RECALL_MEMORIES);
	assert.equal(body.user_id, "alice");
	assert.match(body.agent_id, /^sha256:[a-f0-9]{64}$/);
	assert.doesNotMatch(JSON.stringify(body), /\/secret\/raw\/project/);
	assert.deepEqual(execCalls[0].args, ["rev-parse", "--show-toplevel"]);

	assert.equal(result.message.customType, "mem0_recall");
	assert.equal(result.message.display, true);
	assert.match(result.message.content, /UNTRUSTED LOCAL MEMORY/);
	assert.match(result.message.content, /prefers TypeScript/);
	assert.ok(result.message.content.length <= MEM0_MAX_INJECTION_CHARS);
	assert.doesNotMatch(result.message.content, /must be ignored/);
	assert.match(result.systemPrompt, /base prompt/);
	assert.match(result.systemPrompt, /Mem0 local-memory policy/);
	assert.match(result.systemPrompt, /Never store credentials/);
});

test("before_agent_start fails open for unconfigured, fetch failures, malformed and empty results", async (t) => {
	await t.test("unconfigured returns no injection and performs no POST", async () => {
		let called = false;
		const { events } = registerMem0({
			env: {},
			fetchFn: async () => {
				called = true;
				return { status: 200 };
			},
			getOsUsername: () => "alice",
		});
		const result: any = await events.get("before_agent_start")?.({ prompt: "hello", systemPrompt: "base" }, fakeCtx().ctx);
		assert.match(result?.systemPrompt, /Mem0 local-memory policy/);
		assert.equal(called, false);
	});

	await t.test("fetch failure returns no injection", async () => {
		const { fetchFn, calls } = fakeFetch([new Error("boom")]);
		const { events } = registerMem0({ env: { MEM0_OSS_API_KEY: "secret" }, fetchFn, getOsUsername: () => "alice" });
		const result: any = await events.get("before_agent_start")?.({ prompt: "hello", systemPrompt: "base" }, fakeCtx().ctx);
		assert.match(result?.systemPrompt, /Mem0 local-memory policy/);
		assert.equal(calls.length, 1);
	});

	await t.test("malformed and empty responses return no injection", async () => {
		const { fetchFn, calls } = fakeFetch([{ status: 200, json: { nope: true } }, { status: 200, json: { results: [] } }]);
		const { events } = registerMem0({ env: { MEM0_OSS_API_KEY: "secret" }, fetchFn, getOsUsername: () => "alice" });
		const ctx = fakeCtx().ctx;
		const malformed: any = await events.get("before_agent_start")?.({ prompt: "hello", systemPrompt: "base" }, ctx);
		const empty: any = await events.get("before_agent_start")?.({ prompt: "hello", systemPrompt: "base" }, ctx);
		assert.match(malformed?.systemPrompt, /Mem0 local-memory policy/);
		assert.match(empty?.systemPrompt, /Mem0 local-memory policy/);
		assert.equal(calls.length, 2);
	});
});

test("mem0 scope uses safe non-git fallback without raw path", async () => {
	const { fetchFn, calls } = fakeFetch([{ status: 200, json: { results: [{ memory: "fallback memory" }] } }]);
	const { events } = registerMem0(
		{ env: { MEM0_OSS_API_KEY: "secret", MEM0_USER_ID: "alice" }, fetchFn },
		async () => ({ code: 128, stdout: "", stderr: "not a git repo" }),
	);
	const { ctx } = fakeCtx(null);
	ctx.cwd = "/private/not-git/project";

	const result = await events.get("before_agent_start")?.({ prompt: "hello", systemPrompt: "base" }, ctx) as any;
	assert.ok(result);
	const body = requestBody(calls[0]);
	assert.match(body.agent_id, /^no-git:[a-f0-9]{64}$/);
	assert.doesNotMatch(JSON.stringify(body), /\/private\/not-git\/project/);
});


test("manual unhealthy status warns once per process", async () => {
	resetMem0WarningForTests();
	const { commands } = registerMem0({ env: {}, getOsUsername: () => "alice" });
	const { ctx, notifications } = fakeCtx();

	await commands.get("mem0-status")?.handler("", ctx);
	await commands.get("mem0-status")?.handler("", ctx);

	assert.deepEqual(notifications.map((notification) => notification.level), ["warning", "info"]);
});

test("mem0-remember rejects blank input and stores explicit scoped text", async () => {
	const { fetchFn, calls } = fakeFetch([{ status: 200, json: { results: [{ id: "mem-1" }] } }]);
	const { commands } = registerMem0({
		env: { MEM0_OSS_URL: "http://mem0.local", MEM0_OSS_API_KEY: "secret", MEM0_USER_ID: "alice" },
		fetchFn,
	});
	const { ctx, notifications } = fakeCtx("run-1");
	ctx.cwd = "/tmp/project";

	await commands.get("mem0-remember")?.handler("   ", ctx);
	assert.equal(calls.length, 0);
	assert.deepEqual(notifications[0], { message: "Usage: /mem0-remember <text>", level: "warning" });

	await commands.get("mem0-remember")?.handler(" remember this exact text ", ctx);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].input, "http://mem0.local/memories");
	assert.equal(calls[0].init?.method, "POST");
	assert.deepEqual(calls[0].init?.headers, { "Content-Type": "application/json", "X-API-Key": "secret" });
	const body = requestBody(calls[0]);
	assert.deepEqual(body.messages, [{ role: "user", content: "remember this exact text" }]);
	assert.equal(body.user_id, "alice");
	assert.match(body.agent_id, /^sha256:[a-f0-9]{64}$/);
	assert.equal(body.infer, false);
	assert.equal(body.metadata.session_id, "run-1");
	assert.match(body.metadata.project_id, /^sha256:[a-f0-9]{64}$/);
	assert.equal(body.metadata.project_scope, "git-root-sha256");
	assert.equal(body.metadata.capture, "manual");
	assert.doesNotMatch(JSON.stringify(body), /\/tmp\/project/);
	assert.equal(notifications[1].message, "Remembered in Mem0.");
	assert.equal(notifications[1].level, "info");
});

test("mem0-remember fails open when add request fails", async () => {
	const { fetchFn, calls } = fakeFetch([{ status: 500, statusText: "Broken" }]);
	const { commands } = registerMem0({ env: { MEM0_OSS_API_KEY: "secret" }, fetchFn, getOsUsername: () => "alice" });
	const { ctx, notifications } = fakeCtx();

	await commands.get("mem0-remember")?.handler("remember me", ctx);

	assert.equal(calls.length, 1);
	assert.equal(notifications[0].level, "warning");
	assert.match(notifications[0].message, /Mem0 remember skipped: HTTP 500 Broken/);
});

test("mem0_memory tool registers guidance and executes bounded search and add", async () => {
	const { fetchFn, calls } = fakeFetch([
		{ status: 200, json: { results: [{ memory: "tool memory" }, { memory: "second" }] } },
		{ status: 200, json: { id: "added" } },
	]);
	const { tools } = registerMem0({
		env: { MEM0_OSS_URL: "http://mem0.local", MEM0_OSS_API_KEY: "secret", MEM0_USER_ID: "alice" },
		fetchFn,
	});
	const tool = tools.get("mem0_memory");
	assert.ok(tool);
	assert.match(tool.description, /Search or add/);
	assert.ok(tool.promptGuidelines?.some((line) => /only when the user explicitly asks/.test(line) && /never use it for automatic background capture/.test(line)));

	const { ctx } = fakeCtx("run-tool");
	const searchResult = await tool.execute("call-1", { action: "search", query: "find memory" }, undefined, undefined, ctx) as any;
	assert.match(searchResult.content[0].text, /UNTRUSTED LOCAL MEMORY/);
	assert.match(searchResult.content[0].text, /tool memory/);
	assert.ok(searchResult.content[0].text.length <= MEM0_MAX_INJECTION_CHARS);
	const searchBody = requestBody(calls[0]);
	assert.equal(calls[0].input, "http://mem0.local/search");
	assert.equal(searchBody.query, "find memory");
	assert.equal(searchBody.user_id, "alice");
	assert.match(searchBody.agent_id, /^sha256:[a-f0-9]{64}$/);
	assert.equal(searchBody.top_k, MEM0_MAX_RECALL_MEMORIES);

	const addResult = await tool.execute("call-2", { action: "add", text: "store from tool" }, undefined, undefined, ctx) as any;
	assert.equal(addResult.content[0].text, "Remembered in Mem0.");
	const addBody = requestBody(calls[1]);
	assert.equal(calls[1].input, "http://mem0.local/memories");
	assert.deepEqual(addBody.messages, [{ role: "user", content: "store from tool" }]);
	assert.equal(addBody.user_id, "alice");
	assert.match(addBody.agent_id, /^sha256:[a-f0-9]{64}$/);
	assert.equal(addBody.metadata.session_id, "run-tool");
	assert.equal(addBody.infer, false);
	assert.match(addBody.metadata.project_id, /^sha256:[a-f0-9]{64}$/);
});

test("mem0_memory tool validates blank search and add requests without network", async () => {
	const { fetchFn, calls } = fakeFetch([]);
	const { tools } = registerMem0({ env: { MEM0_OSS_API_KEY: "secret" }, fetchFn, getOsUsername: () => "alice" });
	const tool = tools.get("mem0_memory");
	assert.ok(tool);

	const searchResult = await tool.execute("call-1", { action: "search", query: "   " }, undefined, undefined, fakeCtx().ctx) as any;
	const addResult = await tool.execute("call-2", { action: "add", text: "   " }, undefined, undefined, fakeCtx().ctx) as any;
	assert.match(searchResult.content[0].text, /requires a non-empty query/);
	assert.match(addResult.content[0].text, /requires non-empty text/);
	assert.equal(calls.length, 0);
});

test("extension does not register agent_end or post-turn capture handlers", () => {
	const { events } = registerMem0({ env: {}, getOsUsername: () => "alice" });
	assert.equal(events.has("agent_end"), false);
	assert.equal(events.has("agent_settled"), false);
	assert.equal(events.has("turn_end"), false);
	assert.equal(events.has("message_end"), false);
});


test("commands recheck status, run doctor, and show static setup guide", async () => {
	resetMem0WarningForTests();
	const { fetchFn, calls } = fakeFetch([
		{ status: 200 },
		{ status: 200 },
		{ status: 200 },
		{ status: 403 },
	]);
	const { commands } = registerMem0({
		env: { MEM0_OSS_URL: "http://mem0.local/", MEM0_OSS_API_KEY: "secret", MEM0_USER_ID: "alice" },
		fetchFn,
		now: () => Date.parse("2026-07-20T12:00:00.000Z"),
	});
	const { ctx, notifications, statuses } = fakeCtx();

	assert.equal(commands.has("mem0-status"), true);
	assert.equal(commands.has("mem0-doctor"), true);
	assert.equal(commands.has("mem0-setup"), true);

	await commands.get("mem0-status")?.handler("", ctx);
	assert.equal(notifications[0].level, "info");
	assert.match(notifications[0].message, /^Mem0 ready/);
	assert.ok(statuses.some((entry) => entry.value === "[success]mem0: ready"));

	await commands.get("mem0-doctor")?.handler("", ctx);
	assert.equal(notifications[1].level, "warning");
	assert.match(notifications[1].message, /Mem0 doctor/);
	assert.match(notifications[1].message, /Status: unauthorized/);
	assert.match(notifications[1].message, /X-API-Key/);
	assert.ok(statuses.some((entry) => entry.value === "[error]mem0: unauthorized"));

	await commands.get("mem0-setup")?.handler("", ctx);
	assert.equal(notifications[2].level, "info");
	assert.match(notifications[2].message, /Default: http:\/\/127\.0\.0\.1:8888/);
	assert.match(notifications[2].message, /health probes remain non-mutating/);
	assert.match(notifications[2].message, /bounded POST \/search/);
	assert.match(notifications[2].message, /mem0-remember/);
	assert.equal(calls.length, 4, "setup guide must not make network requests");
});
