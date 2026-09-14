import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ArtifactInput, EventInput, HostBinding, Json, ModelBinding, RenderInput, Tokenizer } from "./contracts.ts";
import { jsonRenderer } from "./context.ts";
import { canonical, fail, json } from "./storage.ts";
import { modelJson } from "./model-output.ts";
import type { SessionMemory } from "./memory.ts";

/** Used only for shadow estimates. Not asserted to bound every pi provider's
 * image, protocol or tokenizer costs. Live replacement must supply its own counter.
 */
export const shadowTokenizer: Tokenizer = { id: "shadow-utf8-bytes-1", mode: "conservative", count: text => Buffer.byteLength(text, "utf8") };
export function piShadowHost(archiveDirectory: string): HostBinding {
	return {
		version: "pi-shadow-1",
		archiveCapability: `Use the existing read tool for absolute files in ${archiveDirectory}, and the existing bash/search tools to discover archived text. Observations are historical; inspect mutable files again before relying on freshness.`,
		render(input: RenderInput, tokenizer) {
			// Several lifecycle records can refer to one real assistant message.
			const seen = new Set<string>();
			const dedupe = (rows: RenderInput["tail"]) => rows.filter(row => {
				if (!row.event.messageRef) return true; // Preserve original operation observations as labeled data, not synthetic tool messages.
				if (seen.has(row.event.messageRef)) return false;
				seen.add(row.event.messageRef); return true;
			});
			const support = dedupe(input.support), tail = dedupe(input.tail);
			return jsonRenderer({ ...input, support, tail }, tokenizer);
		},
		validateTail(tail, support) {
			const requests = new Set([...support, ...tail].filter(e => e.kind === "tool_request").map(e => e.toolCallId));
			const missing = tail.find(e => e.kind === "tool_result" && !requests.has(e.toolCallId));
			return missing ? { ok: false, code: "ILLEGAL_TOOL_SEQUENCE", retryable: false, message: `Missing original call for ${missing.id}` } : { ok: true, value: null };
		},
		// Pi's documented extension interface does not expose the dispatch transaction.
		// Deliberately absent. A context hook plus appendEntry is not equivalent.
	};
}
export function piMemoryModel(ctx: ExtensionContext, lifetime: AbortSignal): ModelBinding | undefined {
	const model = ctx.model;
	const registry = ctx.modelRegistry as unknown as { complete?: (model: unknown, context: unknown, options: unknown) => Promise<{ stopReason: string; content: { type: string; text?: string }[]; usage?: unknown }> };
	if (!model || typeof registry.complete !== "function") return undefined;
	const complete = registry.complete.bind(ctx.modelRegistry);
	return {
		identity: `${model.provider}/${model.id}`,
		async invoke(job) {
			const response = await complete(model, { systemPrompt: job.prompt, messages: [{ role: "user", content: [{ type: "text", text: canonical(job.input) }], timestamp: Date.now() }], tools: [] }, { maxTokens: Math.min(job.maxOutputTokens, model.maxTokens), signal: AbortSignal.any([job.signal, lifetime]), maxRetries: 0, transport: "sse", cacheRetention: "none", sessionId: `l-mem-${crypto.randomUUID()}` });
			job.onResponse?.(json(response));
			if (response.usage !== undefined) job.onUsage?.(json(response.usage));
			if (response.stopReason === "length" || response.stopReason === "error" || response.stopReason === "aborted") fail("WRITER_INVALID", `Memory invocation ended with ${response.stopReason}; extraction is incomplete`);
			return modelJson(response);
		},
	};
}
function visible(message: Record<string, unknown>): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return typeof message.output === "string" ? message.output : "";
	return message.content.filter(c => c && typeof c === "object" && (c as { type?: string }).type !== "toolCall").map(c => (c as { type: string }).type === "thinking" ? `[Agent reasoning, not user authorization]\n${(c as { thinking?: string }).thinking ?? "[Opaque reasoning retained only in the original protocol message]"}` : (c as { type: string }).type === "text" ? (c as { text: string }).text : (c as { type: string }).type === "image" ? "[Original image artifact attached. No text interpretation was supplied.]" : canonical(c)).join("\n");
}
export interface PiCaptureState { entryIds: string[]; eventIds: Map<string, string>; blockedReason?: string }
export function captureBranch(memory: SessionMemory, sessionId: string, entries: readonly unknown[], capture: PiCaptureState): void {
	const messages = entries.flatMap((entry: any) => entry?.type === "message" ? [entry] : entry?.type === "custom_message" ? [{ ...entry, message: { role: "custom", customType: entry.customType, content: entry.content, details: entry.details, timestamp: Date.parse(entry.timestamp) } }] : []) as { id: string; timestamp: string; message: Record<string, unknown> }[];
	const entryIds = messages.map(e => e.id);
	if (capture.entryIds.some((id, index) => entryIds[index] !== id)) {
		capture.blockedReason = "UNSUPPORTED_HOST_CAPABILITY: branch changed. l-mem will not merge abandoned and active branches.";
		fail("UNSUPPORTED_HOST_CAPABILITY", capture.blockedReason);
	}
	const record = (producerId: string, input: EventInput) => {
		const result = memory.recordEvent(sessionId, producerId, input);
		if (!result.ok) fail(result.code, result.message);
		return result.value;
	};
	for (const entry of messages) {
		const m = entry.message, role = m.role;
		if (capture.eventIds.has(entry.id)) continue;
		const timestamp = typeof m.timestamp === "number" ? m.timestamp : Date.parse(entry.timestamp);
		const artifacts: ArtifactInput[] = Array.isArray(m.content) ? m.content.flatMap(part => {
			const image = part as { type?: string; data?: string; mimeType?: string; source?: { type: string; data?: string; mediaType?: string } };
			const data = image.source?.type === "base64" ? image.source.data : image.data, mediaType = image.source?.mediaType ?? image.mimeType;
			return image?.type === "image" && typeof data === "string" && typeof mediaType === "string" ? [{ content: data, encoding: "base64" as const, mediaType, captureKind: "agent_visible" as const, completeness: "complete" as const }] : [];
		}) : [];
		const details = m.details && typeof m.details === "object" ? m.details as Record<string, unknown> : undefined;
		const base = { artifacts, producer: String(role), timestamp, payload: visible(m), message: json(m), causalParentIds: [] as string[], deliveryState: "delivered" as const, coherentCut: role === "toolResult" || (role === "assistant" && m.stopReason === "stop") };
		const inputOrigin = m.lMemInput as { source?: string; rawText?: string } | undefined;
		if (typeof inputOrigin?.rawText === "string" && inputOrigin.rawText !== base.payload) artifacts.push({ content: inputOrigin.rawText, encoding: "utf8", mediaType: "text/plain", captureKind: "agent_visible", completeness: "complete", externalLocator: "original user input before host expansion" });
		if (role === "user" && inputOrigin?.source === "extension") {
			const result = record(`entry:${entry.id}`, { ...base, kind: "agent_message", authority: "host", origin: "runtime_control", observationScope: "Extension-manufactured user-shaped input, not explicit user authorization" });
			capture.eventIds.set(entry.id, result.id);
		} else if (role === "user" || role === "assistant") {
			const result = record(`entry:${entry.id}`, { ...base, kind: role === "user" ? "user_message" : "agent_message", authority: role === "user" ? "user" : "agent", origin: "original" });
			capture.eventIds.set(entry.id, result.id);
			if (role === "assistant" && Array.isArray(m.content)) {
				for (const part of m.content) {
					if (!part || typeof part !== "object" || (part as { type?: string }).type !== "toolCall") continue;
					const call = part as { id: string; name: string; arguments: Json };
					record(`call:${entry.id}:${call.id}`, { ...base, kind: "tool_request", authority: "agent", origin: "original", producer: call.name, payload: canonical({ tool: call.name, arguments: call.arguments }), toolCallId: call.id, operationId: call.id, operationStatus: "unknown", causalParentIds: [result.id], coherentCut: false });
				}
			}
		} else if (role === "toolResult") {
			const result = record(`entry:${entry.id}`, { ...base, kind: "tool_result", authority: "tool", origin: "original", producer: String(m.toolName), toolCallId: String(m.toolCallId), operationId: String(m.toolCallId), operationStatus: m.isError ? "failed" : "completed", truncationMetadata: details?.truncation ? json(details.truncation) : undefined, workspaceVersion: (details?.lMemEvidence as any)?.workspaceVersion, causalParentIds: (details?.lMemEvidence as any)?.sourceEventId ? [(details!.lMemEvidence as any).sourceEventId] : [], originalEvidenceIds: (details?.lMemEvidence as any)?.originalEvidenceIds, observationScope: (details?.lMemEvidence as any)?.observationScope ?? "Exact pi-visible result. Workspace verification identity is not supplied by this host." });
			capture.eventIds.set(entry.id, result.id);
		} else if (role === "bashExecution") {
			const operationId = `user-bash:${entry.id}`;
			record(`call:${entry.id}`, { ...base, message: json({ command: m.command }), payload: canonical({ command: m.command }), kind: "tool_request", producer: "user_bash", authority: "user", origin: m.excludeFromContext ? "runtime_control" : "original", operationId, toolCallId: operationId, operationStatus: "unknown", coherentCut: false });
			const result = record(`entry:${entry.id}`, { ...base, payload: canonical({ command: m.command, output: m.output, exitCode: m.exitCode, cancelled: m.cancelled, truncated: m.truncated }), kind: "tool_result", producer: "user_bash", authority: "tool", origin: m.excludeFromContext ? "runtime_control" : "original", operationId, toolCallId: operationId, operationStatus: m.cancelled || m.exitCode !== 0 ? "failed" : "completed", truncationMetadata: json({ truncated: m.truncated ?? false, fullOutputPath: m.fullOutputPath }), observationScope: "User shell observation; workspace scope is uncertain" });
			capture.eventIds.set(entry.id, result.id);
		} else {
			// Custom messages and compaction/branch summaries are never new source coverage.
			const result = record(`entry:${entry.id}`, { ...base, kind: "agent_message", authority: "host", origin: role === "custom" ? "runtime_control" : "derived_memory" });
			capture.eventIds.set(entry.id, result.id);
		}
	}
	capture.entryIds = entryIds;
}
