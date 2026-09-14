import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { loadPatchedPi, installedPi } from "../host-patch.ts";
import { getPiMemoryHost } from "../host-runtime.ts";
import { nativeHost, nativeTokenizer } from "../native-context.ts";
import { SqliteStore, canonical, digest, fail, json } from "../storage.ts";
import { SessionMemory } from "../memory.ts";
import { captureBranch } from "../pi-adapter.ts";
import { modelJson } from "../model-output.ts";
import type { Config, ModelBinding } from "../contracts.ts";

let sdkPromise: Promise<any> | undefined;
export function piSdk(): Promise<any> {
	return sdkPromise ??= loadPatchedPi(installedPi(), process.env.L_MEM_PI_RUNTIME ?? resolve("node_modules/.cache/l-mem/pi-0.85.1-v3"));
}
export function memoryModel(runtime: any, model: any): ModelBinding {
	return { identity: `${model.provider}/${model.id}`, async invoke(job) {
		const result = await runtime.complete(model, { systemPrompt: job.prompt, messages: [{ role: "user", content: canonical(job.input), timestamp: Date.now() }], tools: [] }, { maxTokens: Math.min(job.maxOutputTokens, model.maxTokens), signal: job.signal, maxRetries: 0, transport: "sse", cacheRetention: "none", sessionId: `l-mem-job-${crypto.randomUUID()}` });
		job.onResponse?.(json(result));
		job.onUsage?.(json(result.usage));
		if (["length", "error", "aborted"].includes(result.stopReason)) fail("WRITER_INVALID", `Memory model stopped with ${result.stopReason}: ${result.errorMessage ?? ""}`);
		return modelJson(result);
	} };
}
export async function isolatedSession(directory: string, runtime: any, model: any, configuration: Partial<Config> = {}, writer?: ModelBinding) {
	const sdk = await piSdk(); mkdirSync(directory, { recursive: true });
	const cwd = join(directory, "workspace"); mkdirSync(cwd, { recursive: true });
	const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, providerRetry: { maxRetries: 0 }, imageAutoResize: false });
	const loader = {
		getExtensions: () => ({ extensions: [], errors: [], runtime: sdk.createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => undefined, getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources() {}, async reload() {},
	};
	const { session } = await sdk.createAgentSession({ cwd, agentDir: join(directory, "agent"), modelRuntime: runtime, model, thinkingLevel: "off", tools: ["read", "bash", "edit", "write"], resourceLoader: loader, settingsManager, sessionManager: sdk.SessionManager.create(cwd, join(directory, "sessions")) });
	const sessionId = session.sessionManager.getSessionId(), host = getPiMemoryHost(sessionId)!;
	if (!host) throw new Error("Patched SDK did not install the dispatch host");
	const store = new SqliteStore(join(directory, "memory"));
	const binding = nativeHost(store, sessionId, join(store.directory, digest(sessionId))); binding.dispatch = host.binding();
	const memory = new SessionMemory(store, nativeTokenizer, binding, writer ?? memoryModel(runtime, model), configuration);
	const capture = { entryIds: [] as string[], eventIds: new Map<string, string>() };
	host.attach(store, memory, () => captureBranch(memory, sessionId, session.sessionManager.getBranch(), capture));
	return { sdk, session, sessionId, host, store, memory, capture, cwd, close() { host.detach(); session.dispose(); store.close(); } };
}
