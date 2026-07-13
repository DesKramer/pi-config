import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";

type ContentBlock = {
	type?: string;
	text?: string;
	thinking?: string;
};

type AssistantMessage = {
	role?: string;
	content?: string | ContentBlock[];
	stopReason?: string;
};

function assistantText(message: AssistantMessage): string {
	const content = message.content;
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text!.trim())
		.filter(Boolean)
		.join("\n\n")
		.trim();
}

function lastAgentFinalText(entries: unknown[]): string | undefined {
	const branch = Array.isArray(entries) ? entries : [];
	let fallback: string | undefined;

	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i] as { type?: string; message?: AssistantMessage };
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;

		const text = assistantText(entry.message);
		if (!text) continue;

		// A tool-use assistant message is an intermediate step, not the final agent answer.
		if (entry.message.stopReason !== "toolUse") return text;

		fallback ??= text;
	}

	return fallback;
}

function runClipboardCommand(command: string, args: string[], text: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["pipe", "ignore", "pipe"] });
		let stderr = "";

		child.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
		});

		child.stdin.end(text);
	});
}

async function copyToClipboard(text: string): Promise<string> {
	const candidates: Array<{ command: string; args: string[]; label: string }> = process.platform === "darwin"
		? [{ command: "pbcopy", args: [], label: "pbcopy" }]
		: process.platform === "win32"
			? [{ command: "clip", args: [], label: "clip" }]
			: [
				{ command: "wl-copy", args: [], label: "wl-copy" },
				{ command: "xclip", args: ["-selection", "clipboard"], label: "xclip" },
				{ command: "xsel", args: ["--clipboard", "--input"], label: "xsel" },
			];

	const errors: string[] = [];
	for (const candidate of candidates) {
		try {
			await runClipboardCommand(candidate.command, candidate.args, text);
			return candidate.label;
		} catch (error) {
			errors.push(`${candidate.label}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	throw new Error(errors.join("; ") || "No clipboard command available");
}

export default function copyAgentLast(pi: ExtensionAPI) {
	pi.registerCommand("copy-agent-last", {
		description: "Copy the last agent final message text to the clipboard",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();

			const text = lastAgentFinalText(ctx.sessionManager.getBranch());
			if (!text) {
				ctx.ui.notify("No final agent message found to copy.", "warning");
				return;
			}

			try {
				const method = await copyToClipboard(text);
				ctx.ui.notify(`Copied last agent final message to clipboard (${text.length} chars via ${method}).`, "info");
			} catch (error) {
				ctx.ui.notify(`Failed to copy last agent message: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
