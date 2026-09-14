import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { hash, fail } from "./storage.ts";

const EXPECTED = {
	"node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js": "b5d9f001e97bfafa8dfeef2e292f923c39f77fa8aef014132bf3530760f222e3",
	"node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js": "f5705d45ae72102110238d6265a548df3aef50b777f654f1f91a32d563c91b3e",
	"node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js": "87085aa3c3c865fb51774bc13b669599461fd29e497fc6063bd6f5b9b5262d33",
	"node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js": "1e2097ced37cf0e21aa5711297eecc77916de8a4ed81a9019bc7d97b22825fa3",
	"node_modules/@earendil-works/pi-ai/dist/api/transform-messages.js": "e51975857b2fefa7e9cc108850ddab5a2fd1753a399f3cde00d76cd700ce6d10",
	"dist/core/tools/bash.js": "5f5bc414757f2b4888c9300646d14518979cda638c68ba1836acca8835dd280a",
	"dist/core/sdk.js": "6969bd56ba8e1628cd033bb15cb15fe38299f00b5ad84f4f8ef37a33a98681c9",
	"dist/core/agent-session.js": "fb8a3981c20c8c0bbd42231b1c99a10335fb3858b659056b341954de9cfa467f",
	"node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js": "6732a1c65c09577d2ffcb716b48e4f4673e57e3e333f10ebfce5132d82e4d7a2",
};
function replace(source: string, before: string, after: string): string {
	if (source.split(before).length !== 2) fail("UNSUPPORTED_HOST_CAPABILITY", `Host patch does not match exactly: ${before.slice(0, 80)}`);
	return source.replace(before, after);
}
export function patchSources(sdk: string, session: string, loop: string, hostModule: string) {
	sdk = `import { installPiMemoryHost } from ${JSON.stringify(hostModule)};\n` + sdk;
	sdk = replace(sdk, "    const extensionsResult = resourceLoader.getExtensions();\n    return {", "    installPiMemoryHost(session, convertToLlmWithBlockImages);\n    const extensionsResult = resourceLoader.getExtensions();\n    return {");
	loop = replace(loop, "        apiKey: resolvedApiKey,\n        signal,", "        apiKey: resolvedApiKey,\n        signal,\n        lMemBoundary: { context, emit },");
	session = replace(session, "        const expandPromptTemplates = options?.expandPromptTemplates ?? true;", "        const lMemInput = { id: crypto.randomUUID(), source: options?.source ?? 'interactive', rawText: text };\n        const expandPromptTemplates = options?.expandPromptTemplates ?? true;");
	for (const mode of ["Steer", "FollowUp"]) {
		session = replace(session, `await this._queue${mode}(expandedText, currentImages);`, `await this._queue${mode}(expandedText, currentImages, lMemInput);`);
		session = replace(session, `await this._queue${mode}(expandedText, images);`, `await this._queue${mode}(expandedText, images, { id: crypto.randomUUID(), source: 'interactive', rawText: text });`);
		session = replace(session, `async _queue${mode}(text, images) {`, `async _queue${mode}(text, images, lMemInput = { id: crypto.randomUUID(), source: 'extension', rawText: text }) {`);
	}
	session = replace(session, "                content: userContent,\n                timestamp: Date.now(),", "                content: userContent,\n                lMemInput,\n                timestamp: Date.now(),");
	// Both queue constructors have the same shape; verify exactly two matches.
	const queueMessage = "            role: \"user\",\n            content,\n            timestamp: Date.now(),";
	if (session.split(queueMessage).length !== 3) fail("UNSUPPORTED_HOST_CAPABILITY", "Unexpected queue message constructors");
	session = session.replaceAll(queueMessage, "            role: \"user\",\n            content,\n            lMemInput,\n            timestamp: Date.now(),");
	return { sdk, session, loop };
}
/** Builds a private, hash-checked pi runtime. Never edits installed pi files. */
export function buildPatchedPi(sourceDirectory: string, destination: string): string {
	const source = resolve(sourceDirectory), target = resolve(destination);
	if (target === source || target.startsWith(source + "/") || source.startsWith(target + "/")) fail("INVALID_EVENT", "Patched runtime must be separate from the installed package");
	const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
	if (pkg.version !== "0.85.1") fail("UNSUPPORTED_HOST_CAPABILITY", `Host patch supports pi 0.85.1, found ${pkg.version}`);
	for (const [path, checksum] of Object.entries(EXPECTED)) if (hash(readFileSync(join(source, path))) !== checksum) fail("UNSUPPORTED_HOST_CAPABILITY", `Installed host file differs from the audited pi build: ${path}`);
	const sources = patchSources(readFileSync(join(source, "dist/core/sdk.js"), "utf8"), readFileSync(join(source, "dist/core/agent-session.js"), "utf8"), readFileSync(join(source, "node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js"), "utf8"), new URL("./host-runtime.ts", import.meta.url).href);
	let bash = readFileSync(join(source, "dist/core/tools/bash.js"), "utf8");
	bash = `import { getPiMemoryHost } from ${JSON.stringify(new URL("./host-runtime.ts", import.meta.url).href)};\n` + bash;
	const publish = `getPiMemoryHost(ctx?.sessionManager?.getSessionId())?.recordExecution(_toolCallId, { command: spawnContext.command, cwd: spawnContext.cwd, exitCode, fullOutputPath: snapshot.fullOutputPath });`;
	bash = replace(bash, "                const { text: outputText, details } = formatOutput(snapshot);", `                ${publish}\n                const { text: outputText, details } = formatOutput(snapshot);`);
	bash = replace(bash, "                    const { text } = formatOutput(snapshot, \"\");", `                    getPiMemoryHost(ctx?.sessionManager?.getSessionId())?.recordExecution(_toolCallId, { command: spawnContext.command, cwd: spawnContext.cwd, exitCode: null, interrupted: true, fullOutputPath: snapshot.fullOutputPath });\n                    const { text } = formatOutput(snapshot, \"\");`);
	const manifest = JSON.stringify({ version: 3, source, audited: EXPECTED, sdk: hash(Buffer.from(sources.sdk)), session: hash(Buffer.from(sources.session)), loop: hash(Buffer.from(sources.loop)), bash: hash(Buffer.from(bash)) });
	if (existsSync(target)) {
		if (!existsSync(join(target, "l-mem-patch.json")) || readFileSync(join(target, "l-mem-patch.json"), "utf8") !== manifest) fail("REVISION_CONFLICT", "Runtime destination exists with a different patch. Choose a new destination; it was not overwritten");
		for (const [path, content] of [["dist/core/sdk.js", sources.sdk], ["dist/core/agent-session.js", sources.session], ["dist/core/tools/bash.js", bash], ["node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js", sources.loop]]) if (readFileSync(join(target, path), "utf8") !== content) fail("UNSUPPORTED_HOST_CAPABILITY", "Patched runtime was modified");
		for (const [path, checksum] of Object.entries(EXPECTED).filter(([path]) => path.includes("/pi-ai/"))) if (hash(readFileSync(join(target, path))) !== checksum) fail("UNSUPPORTED_HOST_CAPABILITY", `Private provider adapter was modified: ${path}`);
		return join(target, "dist/index.js");
	}
	cpSync(source, target, { recursive: true, filter: path => path === source || !path.slice(source.length + 1).split("/").includes("node_modules") });
	const deps = join(target, "node_modules"); mkdirSync(deps, { recursive: true });
	for (const entry of readdirSync(join(source, "node_modules"), { withFileTypes: true })) {
		if (entry.name === "@earendil-works") {
			mkdirSync(join(deps, entry.name));
			for (const name of readdirSync(join(source, "node_modules", entry.name))) {
				const from = join(source, "node_modules", entry.name, name), to = join(deps, entry.name, name);
				if (name === "pi-agent-core" || name === "pi-ai") cpSync(from, to, { recursive: true }); else symlinkSync(from, to);
			}
		} else symlinkSync(join(source, "node_modules", entry.name), join(deps, entry.name));
	}
	writeFileSync(join(target, "dist/core/tools/bash.js"), bash);
	writeFileSync(join(target, "dist/core/sdk.js"), sources.sdk);
	writeFileSync(join(target, "dist/core/agent-session.js"), sources.session);
	writeFileSync(join(target, "node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js"), sources.loop);
	writeFileSync(join(target, "l-mem-patch.json"), manifest);
	return join(target, "dist/index.js");
}
export function installedPi(): string {
	if (process.env.L_MEM_PI_PACKAGE) return resolve(process.env.L_MEM_PI_PACKAGE);
	return dirname(createRequire(import.meta.url).resolve("@earendil-works/pi-coding-agent/package.json"));
}
export async function loadPatchedPi(directory: string, destination: string): Promise<any> {
	return import(pathToFileURL(buildPatchedPi(directory, destination)).href);
}
