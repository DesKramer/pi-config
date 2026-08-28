import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	collectPlugStatus,
	createPlugRunner,
	formatPlugStatus,
	type PlugRunner,
} from "./runtime.ts";

const pluginName = Type.String({
	description: "Installed PLUG plugin name",
	minLength: 1,
	maxLength: 128,
	pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$",
});
const noExtraProperties = { additionalProperties: false } as const;

function result(execution: Awaited<ReturnType<PlugRunner>>) {
	return {
		content: [{ type: "text" as const, text: execution.stdout }],
		details: {
			exitCode: execution.code,
			ok: execution.envelope.ok,
			...(execution.stderr ? { diagnostic: execution.stderr } : {}),
		},
	};
}

export function createPlugExtension(options: { run?: PlugRunner; env?: NodeJS.ProcessEnv } = {}) {
	return (pi: ExtensionAPI): void => {
		const run = options.run ?? createPlugRunner({ env: options.env });

		pi.registerTool({
			name: "plug_list",
			label: "PLUG List",
			description: "List installed PLUG plugins and their broker-provided tool contracts. Returns the complete bounded PLUG JSON envelope.",
			parameters: Type.Object({
				plugin: Type.Optional(pluginName),
			}, noExtraProperties),
			async execute(_id, params, signal) {
				return result(await run(params.plugin ? ["list", params.plugin] : ["list"], { signal }));
			},
		});

		pi.registerTool({
			name: "plug_run",
			label: "PLUG Run",
			description: "Run an installed PLUG plugin through the local broker without a shell. Arguments are passed verbatim as an argv array. Returns the complete bounded PLUG JSON envelope.",
			parameters: Type.Object({
				plugin: pluginName,
				arguments: Type.Array(Type.String({ maxLength: 65_536 }), {
					description: "Arguments after `plug run <plugin>`, each as a separate argv item",
					maxItems: 256,
				}),
			}, noExtraProperties),
			async execute(_id, params, signal) {
				return result(await run(["run", params.plugin, ...params.arguments], { signal }));
			},
		});

		pi.registerTool({
			name: "plug_auth_status",
			label: "PLUG Auth Status",
			description: "Read a PLUG plugin's authentication state without authenticating or exposing credentials. Returns the complete bounded PLUG JSON envelope.",
			parameters: Type.Object({ plugin: pluginName }, noExtraProperties),
			async execute(_id, params, signal) {
				return result(await run(["auth", "status", params.plugin], { signal }));
			},
		});

		pi.registerTool({
			name: "plug_reauth",
			label: "PLUG Reauthenticate",
			description: "Explicitly initiate PLUG reauthentication for one installed plugin. This may require a human browser or trusted desktop action; call only when the user requests reauthentication. Returns the complete bounded PLUG JSON envelope.",
			parameters: Type.Object({ plugin: pluginName }, noExtraProperties),
			promptGuidelines: [
				"Use plug_reauth only when the user explicitly requests reauthentication; never call it during status or discovery checks.",
			],
			async execute(_id, params, signal) {
				return result(await run(["reauth", params.plugin], { signal }));
			},
		});

		pi.registerCommand("plug-status", {
			description: "Diagnose the local plug and plugd executables, socket, broker, and plugin auth states (never reauthenticates)",
			handler: async (_args, ctx) => {
				const status = await collectPlugStatus(run, options.env ?? process.env);
				const healthy = status.executable.ok && status.daemonExecutable.ok && status.socket.ok && status.broker.ok && status.pluginAuth.every((entry) => entry.ok);
				ctx.ui.notify(formatPlugStatus(status), healthy ? "info" : "warning");
			},
		});
	};
}

export default createPlugExtension();
