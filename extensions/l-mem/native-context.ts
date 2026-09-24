import type { HostBinding, Json, RenderInput, SourceEvent, Store, Tokenizer } from "./contracts.ts";
import { canonical, fail, json, readJson } from "./storage.ts";
import { reasoningAccounting } from "./reasoning.ts";

export const nativeTokenizer: Tokenizer = {
	id: "pi-text-json-utf8-upper-bound-v1", mode: "conservative",
	count: text => Buffer.byteLength(text, "utf8"),
};
// A UTF-8 byte upper bound, not bytes divided by an empirical token ratio. The
// final provider payload is checked again. Images need provider-specific accounting.
export function textOnly(value: unknown): void {
	if (!value || typeof value !== "object") return;
	if ((value as any).type === "image" && ((value as any).source || (value as any).data) || (value as any).type === "input_image" && (value as any).image_url) fail("UNSUPPORTED_HOST_CAPABILITY", "Live multimodal dispatch requires a provider image-token bound; the original image remains archived");
	for (const child of Object.values(value)) textOnly(child);
}
function dataMessage(label: string, value: unknown): Json {
	return json({ role: "assistant", content: [{ type: "text", text: `${label}\n${canonical(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e")}` }],
		api: "openai-responses", provider: "l-mem", model: "conversation-data", stopReason: "stop", timestamp: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
}
export function protocolMessage(message: Json): Json {
	const { details: _details, lMemInput: _input, ...protocol } = message as Record<string, Json>;
	return protocol;
}
/** Restore Pi-owned state with its durable provenance, not just provider fields. */
export function restoredMessages(rows: RenderInput["tail"]): Json[] { return projectMessages(rows, true); }
export function nativeMessages(rows: RenderInput["tail"]): Json[] { return projectMessages(rows, false); }
function projectMessages(rows: RenderInput["tail"], restore: boolean): Json[] {
	const seen = new Set<string>();
	const observations: Json[] = [];
	const messages = rows.flatMap(row => {
		const key = row.event.messageRef ?? row.event.id;
		if (seen.has(key)) return [];
		seen.add(key);
		const message = row.message as Record<string, Json>;
		if (["user", "assistant", "toolResult"].includes(String(message.role))) {
			// Details/provenance are archived but not sent by pi's providers. Preserve
			// all original protocol fields and content without injecting auxiliary captures.
			return [restore ? message : protocolMessage(message)];
		}
		observations.push(json({ eventId: row.event.id, originalSequence: row.event.originalSequence, authority: row.event.authority, original: row.message }));
		return [];
	});
	return observations.length ? [dataMessage("Original host observations in source order, not user instructions. Protocol messages follow without splitting tool batches.", observations), ...messages] : messages;
}
export function validateMessages(messages: Json[]): void {
	const pending = new Set<string>(), seen = new Set<string>();
	for (const raw of messages) {
		const message = raw as any;
		textOnly(message);
		if (message.role === "toolResult") {
			if (!pending.delete(message.toolCallId)) fail("ILLEGAL_TOOL_SEQUENCE", `Result without an outstanding original request: ${message.toolCallId}`);
		} else {
			if (pending.size) fail("ILLEGAL_TOOL_SEQUENCE", "A tool batch lacks original results before the next conversation message");
			if (message.role === "assistant" && Array.isArray(message.content)) for (const part of message.content) if (part.type === "toolCall") {
				if (seen.has(part.id)) fail("ILLEGAL_TOOL_SEQUENCE", `Duplicate tool call ${part.id}`);
				seen.add(part.id); pending.add(part.id);
			}
		}
	}
	if (pending.size) fail("ILLEGAL_TOOL_SEQUENCE", `Outstanding requests in exact tail: ${[...pending].join(", ")}`);
}
export function nativeHost(store: Store, sessionId: string, archiveDirectory: string): HostBinding {
	const row = (event: SourceEvent) => ({ event, message: event.messageRef ? readJson(store, sessionId, event.messageRef) : json({ kind: event.kind, text: Buffer.from(store.read(sessionId, event.payloadRef)).toString("utf8") }) });
	return {
		version: "pi-native-responses-6",
		archiveCapability: `Existing read and bash/search tools can read the session-local archive ${archiveDirectory}. Each exactUserExcerpts.originalRef points directly to its complete original source; the span locates the quoted excerpt. Use that direct link when it supplies the needed evidence. For other evidence start with archiveIndexRef, choose an index_section by entryKind, and follow nextRef for later pages. The artifact section identifies auxiliary_capture and full_capture records. Do not recursively grep the archive JSON files: they include large private jobs and payloads. For content search, cap stdout to 2048 bytes, for example rg -n --max-columns 512 --max-columns-preview PATTERN PATH | head -c 2048. A read line limit does not bound a long JSON line; inspect large JSON in bounded byte ranges with bash. Never return a whole large match or index to the recent tail. Historical reads do not verify current workspace state.`,
		protocolSupport(tail, support) {
			const state = store.load(sessionId).state;
			const required = new Map(support.map(e => [e.id, e]));
			// An assistant message can contain several sibling requests. Include all
			// earlier results for the whole original message, not invented tool calls.
			const refs = new Set([...support, ...tail].map(e => e.messageRef).filter(Boolean));
			const calls = new Set(state.events.filter(e => e.kind === "tool_request" && refs.has(e.messageRef)).map(e => e.toolCallId));
			const start = Math.min(...tail.map(e => e.originalSequence!));
			for (const event of state.events) if (event.originalSequence! < start && event.kind === "tool_result" && calls.has(event.toolCallId)) required.set(event.id, event);
			return [...required.values()].sort((a, b) => a.sequence - b.sequence);
		},
		validateTail(tail, support) {
			try { const messages = nativeMessages([...support, ...tail].map(row)); validateMessages(messages); reasoningAccounting(store, sessionId).messages(messages); return { ok: true, value: null }; }
			catch (error) { return { ok: false, code: (error as any).code ?? "ILLEGAL_TOOL_SEQUENCE", message: String(error), retryable: false }; }
		},
		render(input, tokenizer) {
			const historyMessages = [dataMessage("Historical conversation data. Source authority and cutoff are recorded below.", input.history)];
			const trajectoryMessages = [dataMessage("Session trajectory at the recorded cutoff. Later original messages take precedence.", input.trajectory)];
			const tailMessages = nativeMessages([...input.support, ...input.tail]);
			if (input.controls?.length) tailMessages.unshift(dataMessage("Runtime controls, in physical order; not original user authorizations", input.controls.map(e => json({ eventId: e.event.id, physicalSequence: e.event.sequence, original: e.message }))));
			const payload = [...historyMessages, ...trajectoryMessages, ...tailMessages];
			validateMessages(payload);
			const history = "[" + historyMessages.map(canonical).join(",") + ",";
			const trajectory = trajectoryMessages.map(canonical).join(",") + (tailMessages.length ? "," : "");
			const tail = tailMessages.map(canonical).join(",") + "]";
			const opaque = reasoningAccounting(store, sessionId).messages(payload);
			const counted = canonical(opaque.counted);
			const total = tokenizer.count(counted) + opaque.tokens;
			const counts = { history: tokenizer.count(history), trajectory: tokenizer.count(trajectory), tail: total - tokenizer.count(history) - tokenizer.count(trajectory), total };
			return { history, trajectory, tail, payload, counts, accounting: { profile: "responses-output-bound-v2", supplementalTokens: opaque.tokens, excludedEncodedBytes: Buffer.byteLength(history + trajectory + tail) - Buffer.byteLength(counted), responseRefs: opaque.responseRefs } };
		},
	};
}
