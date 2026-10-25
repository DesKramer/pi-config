import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import herdrPrompts from "../extensions/herdr-prompts.ts";

function setup(insideHerdr = true) {
	const handlers = new Map<string, (event: unknown, ctx: { mode: string }) => void>();
	const reports: Array<{ name: string; data: unknown }> = [];
	const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
	const previous = process.env.HERDR_ENV;
	try {
		process.env.HERDR_ENV = insideHerdr ? "1" : "0";
		herdrPrompts({
			registerCommand: (name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) => commands.set(name, command),
			exec: async () => ({ stdout: "state: idle", stderr: "", code: 0 }),
			on: (name: string, handler: (event: unknown, ctx: { mode: string }) => void) => handlers.set(name, handler),
			events: { emit: (name: string, data: unknown) => reports.push({ name, data }) },
		} as unknown as ExtensionAPI);
	} finally {
		if (previous === undefined) delete process.env.HERDR_ENV;
		else process.env.HERDR_ENV = previous;
	}
	return {
		handlers,
		commands,
		reports,
		emit: (name: string, mode = "tui") => handlers.get(name)?.({ title: "Private question" }, { mode }),
	};
}

test("diagnostics appear together in a single notification", async () => {
	const h = setup();
	const notifications: string[] = [];
	await h.commands.get("herdr-status")!.handler("", {
		mode: "tui",
		ui: { notify: (text: string) => notifications.push(text) },
	});
	assert.equal(notifications.length, 1);
	assert.match(notifications[0], /Herdr prompt bridge loaded; mode=tui/);
	assert.match(notifications[0], /Prompts seen since reload=0; waiting=false/);
});

test("reports a generic waiting indication and clears it when the prompt ends", () => {
	const h = setup();
	h.emit("ui_prompt_start");
	h.emit("ui_prompt_end");
	assert.deepEqual(h.reports, [
		{ name: "herdr:blocked", data: { active: true, label: "Waiting for your input" } },
		{ name: "herdr:blocked", data: { active: false } },
	]);
});

test("ignores duplicate starts and unmatched ends without unbalancing Herdr's counter", () => {
	const h = setup();
	h.emit("ui_prompt_end");
	h.emit("ui_prompt_start");
	h.emit("ui_prompt_start");
	h.emit("ui_prompt_end");
	h.emit("ui_prompt_end");
	assert.equal(h.reports.length, 2);
});

test("clears an outstanding wait on shutdown and can handle another session", () => {
	const h = setup();
	h.emit("ui_prompt_start");
	h.emit("session_shutdown");
	h.emit("ui_prompt_end");
	h.emit("session_shutdown");
	assert.equal(h.reports.length, 2);
	assert.deepEqual(h.reports[1].data, { active: false });
	h.emit("ui_prompt_start");
	h.emit("ui_prompt_end");
	assert.equal(h.reports.length, 4);
});

test("does not report headless prompts or register outside Herdr", () => {
	const h = setup();
	for (const mode of ["rpc", "json", "print"]) {
		h.emit("ui_prompt_start", mode);
		h.emit("ui_prompt_end", mode);
	}
	assert.deepEqual(h.reports, []);
	assert.equal(setup(false).handlers.size, 0);
});
