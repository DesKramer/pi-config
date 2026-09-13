import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPlugExtension } from "../extensions/plug/index.ts";
import {
	collectPlugStatus,
	createPlugRunner,
	formatPlugStatus,
	type PlugExecution,
	type PlugRunner,
} from "../extensions/plug/runtime.ts";

type RegisteredTool = {
	name: string;
	parameters: any;
	promptSnippet?: string;
	promptGuidelines?: string[];
	execute: (...args: any[]) => Promise<any>;
};
type RegisteredCommand = { handler: (args: string, ctx: any) => Promise<void> };

function execution(envelope: Record<string, unknown>, code = 0): PlugExecution {
	const stdout = JSON.stringify(envelope);
	return { stdout, stderr: "", code, envelope: envelope as PlugExecution["envelope"] };
}

function register(run: PlugRunner) {
	const tools = new Map<string, RegisteredTool>();
	const commands = new Map<string, RegisteredCommand>();
	createPlugExtension({ run, env: { PLUG_BIN: "/missing", PLUG_SOCKET: "/missing.sock" } })({
		registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: RegisteredCommand) => commands.set(name, command),
	} as any);
	return { tools, commands };
}

test("registers four strict tools and forwards argv without interpolation", async () => {
	const calls: string[][] = [];
	const run: PlugRunner = async (args) => {
		calls.push([...args]);
		return execution({ ok: true, result: { value: "complete" } });
	};
	const { tools, commands } = register(run);
	assert.deepEqual([...tools.keys()], ["plug_list", "plug_run", "plug_auth_status", "plug_reauth"]);
	assert.equal(commands.has("plug-status"), true);
	for (const tool of tools.values()) assert.equal(tool.parameters.additionalProperties, false);

	const args = ["literal; echo unsafe", "$(touch /tmp/never)", "space kept"];
	const result = await tools.get("plug_run")?.execute("id", { plugin: "demo", arguments: args }, undefined);
	assert.deepEqual(calls[0], ["run", "demo", ...args]);
	assert.equal(result.content[0].text, JSON.stringify({ ok: true, result: { value: "complete" } }));
});

test("exposes PLUG discovery, execution, and auth guidance through system-prompt metadata without probing the broker", () => {
	const calls: string[][] = [];
	const { tools } = register(async (args) => {
		calls.push([...args]);
		return execution({ ok: true });
	});
	for (const tool of tools.values()) {
		assert.ok(tool.promptSnippet?.length, `${tool.name} must appear in Available tools`);
		assert.ok(tool.promptGuidelines?.length, `${tool.name} must contribute usage guidance`);
		for (const guideline of tool.promptGuidelines!) {
			assert.ok(guideline.includes(tool.name), "flat prompt guidelines must name their tool");
		}
	}
	const guidelines = [...tools.values()].flatMap((tool) => tool.promptGuidelines ?? []).join("\n");
	assert.match(guidelines, /plug_list.*MCP, or API access/);
	assert.match(guidelines, /Inspect the relevant plugin's returned contract/);
	assert.match(guidelines, /no suitable integration.*available MCP tool or direct API\/CLI/);
	assert.match(guidelines, /plug_run.*separate literal arguments item/);
	assert.match(guidelines, /ok\/error fields/);
	assert.match(guidelines, /untrusted data/);
	assert.match(guidelines, /plug_auth_status.*do not read credential stores/);
	assert.match(guidelines, /plug_reauth only when the user explicitly requests reauthentication/);
	assert.deepEqual(calls, [], "registering prompt guidance must not execute PLUG or authenticate");
});

test("preserves a complete PLUG error envelope even when the CLI exits nonzero", async () => {
	const envelope = { ok: false, error: { code: "PLUGIN_NOT_FOUND", message: "plugin not found" } };
	const { tools } = register(async () => execution(envelope, 1));
	const result = await tools.get("plug_list")?.execute("id", { plugin: "missing" }, undefined);
	assert.equal(result.content[0].text, JSON.stringify(envelope));
	assert.equal(result.details.exitCode, 1);
	assert.equal(result.details.ok, false);
});

test("status probes list and auth status only and never reauthenticates", async () => {
	const calls: string[][] = [];
	const run: PlugRunner = async (args) => {
		calls.push([...args]);
		if (args[0] === "list") return execution({ ok: true, plugins: [{ name: "alpha" }, { name: "beta" }] });
		return execution({ ok: true, connection: { plugin: args[2], state: args[2] === "alpha" ? "connected" : "not_required" } });
	};
	const status = await collectPlugStatus(run, { PLUG_BIN: process.execPath, PLUG_SOCKET: "/missing-plug-test.sock" });
	assert.deepEqual(calls, [["list"], ["auth", "status", "alpha"], ["auth", "status", "beta"]]);
	assert.equal(calls.some((args) => args.includes("reauth")), false);
	assert.equal(status.broker.ok, true);
	assert.equal(status.broker.pluginCount, 2);
	assert.match(formatPlugStatus(status), /alpha: connected/);
});

test("status independently resolves and sanitizes the plugd executable", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-plugd-status-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const plugd = join(directory, "plugd?token=daemon-secret");
	await writeFile(plugd, `#!${process.execPath}\n`);
	await chmod(plugd, 0o755);
	const run: PlugRunner = async () => execution({ ok: true, plugins: [] });
	const status = await collectPlugStatus(run, {
		PLUG_BIN: process.execPath,
		PLUGD_BIN: plugd,
		PLUG_SOCKET: join(directory, "missing.sock"),
		PATH: "",
	});

	assert.equal(status.executable.path, process.execPath);
	assert.equal(status.daemonExecutable.path, plugd);
	assert.equal(status.daemonExecutable.ok, true);
	assert.match(status.daemonExecutable.message, /^plugd executable: ready/);
	assert.doesNotMatch(formatPlugStatus(status), /daemon-secret/);
	assert.match(formatPlugStatus(status), /token=\[REDACTED\]/);
	assert.equal(status.broker.ok, true);
});

test("runner is shell-free, preserves argv, and honors AbortSignal", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-plug-test-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const fake = join(directory, "plug");
	await writeFile(fake, `#!${process.execPath}\nconst args = process.argv.slice(2);\nif (args.includes("delay")) setTimeout(() => console.log(JSON.stringify({ok:true,args})), 10000);\nelse console.log(JSON.stringify({ok:true,args}));\n`);
	await chmod(fake, 0o755);
	const run = createPlugRunner({ env: { ...process.env, PLUG_BIN: fake } });
	const marker = join(directory, "must-not-exist");
	const normal = await run(["run", "demo", `;touch ${marker}`]);
	assert.deepEqual(normal.envelope.args, ["--json", "run", "demo", `;touch ${marker}`]);
	await assert.rejects(import("node:fs/promises").then(({ access }) => access(marker)));

	const controller = new AbortController();
	const pending = run(["delay"], { signal: controller.signal });
	setTimeout(() => controller.abort(), 50);
	await assert.rejects(pending, /cancelled/);
});
