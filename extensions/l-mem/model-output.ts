import type { Json } from "./contracts.ts";
import { fail } from "./storage.ts";

/** Parse one structured answer, not a concatenation of commentary and final output. */
type TextResponse = { api?: string; content: readonly { type: string; text?: string; textSignature?: string }[] };
export function finalText(message: TextResponse): string {
	const parts = message.content.filter(p => p.type === "text");
	const phases: (string | undefined)[] = parts.map(p => {
		if (!["openai-responses", "openai-codex-responses"].includes(message.api ?? "")) return undefined;
		try {
			const value = JSON.parse(p.textSignature ?? "");
			if (value.v === 1 && typeof value.id === "string" && ["commentary", "final_answer"].includes(value.phase)) return value.phase;
		} catch { /* Older unphased output must itself be one JSON value. */ }
	});
	const final = phases.includes("final_answer");
	if (final && phases.some(p => p === undefined)) fail("WRITER_INVALID", "Unclassified text accompanies the final structured answer");
	return parts.filter((_, index) => !final || phases[index] === "final_answer").map(p => p.text ?? "").join("\n");
}
export function modelJson(message: TextResponse): Json {
	const text = finalText(message);
	try { return JSON.parse(text); }
	catch { return fail("WRITER_INVALID", "Model returned invalid JSON in its final structured answer"); }
}
