import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Requires Herdr's official Pi integration and Pi >= 0.84.4. */
export default function herdrPrompts(pi: ExtensionAPI) {
	let waiting = false;
	let promptsSeen = 0;
	pi.registerCommand("herdr-status", {
		description: "Diagnose Herdr prompt reporting in this Pi process",
		handler: async (_args, ctx) => {
			const pane = process.env.HERDR_PANE_ID;
			const lines = [
				`Herdr prompt bridge loaded; mode=${ctx.mode}`,
				`HERDR_ENV=${process.env.HERDR_ENV ?? "unset"}; pane=${pane ?? "unset"}`,
				`Socket=${process.env.HERDR_SOCKET_PATH ?? "unset"}`,
				`Prompts seen since reload=${promptsSeen}; waiting=${waiting}`,
			];
			if (process.env.HERDR_ENV === "1" && pane) {
				const result = await pi.exec(process.env.HERDR_BIN_PATH || "herdr", ["agent", "explain", pane], { timeout: 3000 });
				lines.push(result.stdout || result.stderr || `Herdr exited ${result.code}`);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
	if (process.env.HERDR_ENV !== "1") return;
	function clearWaiting() {
		if (!waiting) return;
		waiting = false;
		pi.events.emit("herdr:blocked", { active: false });
	}

	// Pi coalesces overlapping/nested prompts into one outer waiting span.
	pi.on("ui_prompt_start", (_event, ctx) => {
		promptsSeen += 1;
		if (ctx.mode !== "tui" || waiting) return;
		waiting = true;
		pi.events.emit("herdr:blocked", {
			active: true,
			label: "Waiting for your input",
		});
	});

	pi.on("ui_prompt_end", (_event, ctx) => {
		if (ctx.mode === "tui") clearWaiting();
	});
	pi.on("session_shutdown", clearWaiting);
}
