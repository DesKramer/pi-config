import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

export const PLUG_MAX_OUTPUT_BYTES = 1_100_000;
const ERROR_TEXT_LIMIT = 2_000;
const DEFAULT_TIMEOUT_MS = 25_000;

export type PlugEnvelope = {
	ok: boolean;
	plugins?: Array<{ name?: unknown }>;
	connection?: { plugin?: unknown; state?: unknown };
	error?: { code?: unknown; message?: unknown };
	[key: string]: unknown;
};

export type PlugExecution = {
	stdout: string;
	stderr: string;
	code: number;
	envelope: PlugEnvelope;
};

export type PlugRunner = (args: readonly string[], options?: { signal?: AbortSignal; timeoutMs?: number }) => Promise<PlugExecution>;

export type PlugStatus = {
	executable: { ok: boolean; path?: string; message: string };
	daemonExecutable: { ok: boolean; path?: string; message: string };
	socket: { ok: boolean; path: string; message: string };
	broker: { ok: boolean; message: string; pluginCount?: number };
	pluginAuth: Array<{ plugin: string; ok: boolean; state?: string; message: string }>;
};

function cleanText(value: string): string {
	return value
		.replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
		.replace(/([?&](?:access_token|api_key|code|key|password|secret|token)=)[^&\s]+/gi, "$1[REDACTED]")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
		.trim()
		.slice(0, ERROR_TEXT_LIMIT);
}

export function defaultSocketPath(env: NodeJS.ProcessEnv = process.env): string {
	if (env.PLUG_SOCKET) return env.PLUG_SOCKET;
	if (env.XDG_RUNTIME_DIR) return join(env.XDG_RUNTIME_DIR, "plug", "plug.sock");
	return join(homedir(), ".plug", "plug.sock");
}

async function resolveExecutable(name: "plug" | "plugd", override: string | undefined, env: NodeJS.ProcessEnv): Promise<string | undefined> {
	const candidates: string[] = [];
	if (override) candidates.push(override);
	candidates.push(join(homedir(), ".local", "bin", name));
	for (const directory of (env.PATH ?? "").split(delimiter)) {
		if (directory) candidates.push(join(directory, name));
	}
	for (const candidate of [...new Set(candidates)]) {
		if (!isAbsolute(candidate)) continue;
		try {
			await access(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Try the next explicit path without invoking a shell.
		}
	}
	return undefined;
}

export async function resolvePlugExecutable(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
	return resolveExecutable("plug", env.PLUG_BIN, env);
}

export async function resolvePlugdExecutable(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
	return resolveExecutable("plugd", env.PLUGD_BIN, env);
}

function parseEnvelope(stdout: string): PlugEnvelope {
	let value: unknown;
	try {
		value = JSON.parse(stdout);
	} catch {
		throw new Error("PLUG returned invalid JSON; verify that `plug --json list` works locally.");
	}
	if (!value || typeof value !== "object" || typeof (value as { ok?: unknown }).ok !== "boolean") {
		throw new Error("PLUG returned a JSON response without a boolean `ok` field; rebuild compatible plug/plugd binaries.");
	}
	return value as PlugEnvelope;
}

export function createPlugRunner(options: { env?: NodeJS.ProcessEnv; maxOutputBytes?: number } = {}): PlugRunner {
	const env = options.env ?? process.env;
	const maxOutputBytes = options.maxOutputBytes ?? PLUG_MAX_OUTPUT_BYTES;
	return async (args, runOptions = {}) => {
		const executable = await resolvePlugExecutable(env);
		if (!executable) {
			throw new Error("PLUG executable not found. Build cmd/plug into ~/.local/bin or set PLUG_BIN to an absolute executable path.");
		}
		if (runOptions.signal?.aborted) throw new Error("PLUG command cancelled.");

		return await new Promise<PlugExecution>((resolve, reject) => {
			const child = spawn(executable, ["--json", ...args], {
				env,
				stdio: ["ignore", "pipe", "pipe"],
				shell: false,
			});
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			let stdoutBytes = 0;
			let stderrBytes = 0;
			let settled = false;
			let overflowed = false;
			let timedOut = false;

			const stop = () => child.kill("SIGTERM");
			const timeout = setTimeout(() => {
				timedOut = true;
				stop();
			}, runOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS);
			const abort = () => stop();
			runOptions.signal?.addEventListener("abort", abort, { once: true });

			const collect = (target: Buffer[], chunk: Buffer, stream: "stdout" | "stderr") => {
				if (stream === "stdout") stdoutBytes += chunk.length;
				else stderrBytes += chunk.length;
				if (stdoutBytes + stderrBytes > maxOutputBytes) {
					overflowed = true;
					stop();
					return;
				}
				target.push(chunk);
			};
			child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk, "stdout"));
			child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk, "stderr"));
			child.on("error", (error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				runOptions.signal?.removeEventListener("abort", abort);
				reject(new Error(`Unable to execute PLUG: ${cleanText(error.message)}`));
			});
			child.on("close", (code) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				runOptions.signal?.removeEventListener("abort", abort);
				if (overflowed) return reject(new Error(`PLUG output exceeded the ${maxOutputBytes}-byte integration limit; narrow the request.`));
				if (runOptions.signal?.aborted) return reject(new Error("PLUG command cancelled."));
				if (timedOut) return reject(new Error("PLUG command timed out; check `plugd` and ~/.plug/plugd.log."));
				const stdoutText = Buffer.concat(stdout).toString("utf8").trim();
				const stderrText = cleanText(Buffer.concat(stderr).toString("utf8"));
				try {
					const envelope = parseEnvelope(stdoutText);
					resolve({ stdout: stdoutText, stderr: stderrText, code: code ?? 1, envelope });
				} catch (error) {
					const detail = stderrText ? ` ${stderrText}` : "";
					reject(new Error(`${(error as Error).message}${detail}`));
				}
			});
		});
	};
}

export async function collectPlugStatus(
	run: PlugRunner = createPlugRunner(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<PlugStatus> {
	const [executablePath, daemonExecutablePath] = await Promise.all([
		resolvePlugExecutable(env),
		resolvePlugdExecutable(env),
	]);
	const executable = executablePath
		? { ok: true, path: executablePath, message: `plug executable: ready (${cleanText(executablePath)})` }
		: { ok: false, message: "plug executable: missing (build cmd/plug into ~/.local/bin or set PLUG_BIN)" };
	const daemonExecutable = daemonExecutablePath
		? { ok: true, path: daemonExecutablePath, message: `plugd executable: ready (${cleanText(daemonExecutablePath)})` }
		: { ok: false, message: "plugd executable: missing (build cmd/plugd into ~/.local/bin or set PLUGD_BIN)" };
	const socketPath = defaultSocketPath(env);
	const displaySocketPath = cleanText(socketPath);
	let socket: PlugStatus["socket"];
	try {
		const info = await lstat(socketPath);
		socket = info.isSocket()
			? { ok: true, path: socketPath, message: `socket: ready (${displaySocketPath})` }
			: { ok: false, path: socketPath, message: `socket: path exists but is not a Unix socket (${displaySocketPath})` };
	} catch {
		socket = { ok: false, path: socketPath, message: `socket: missing (${displaySocketPath})` };
	}

	if (!executable.ok) {
		return { executable, daemonExecutable, socket, broker: { ok: false, message: "broker: not probed without plug executable" }, pluginAuth: [] };
	}
	try {
		const listed = await run(["list"], { timeoutMs: 5_000 });
		if (!listed.envelope.ok) {
			const error = listed.envelope.error;
			return {
				executable,
				daemonExecutable,
				socket,
				broker: { ok: false, message: `broker: ${cleanText(String(error?.code ?? "error"))} ${cleanText(String(error?.message ?? "probe failed"))}` },
				pluginAuth: [],
			};
		}
		const names = (listed.envelope.plugins ?? [])
			.map((plugin) => plugin.name)
			.filter((name): name is string => typeof name === "string" && name.length > 0);
		const pluginAuth: PlugStatus["pluginAuth"] = [];
		for (const plugin of names) {
			const result = await run(["auth", "status", plugin], { timeoutMs: 5_000 });
			const state = result.envelope.connection?.state;
			pluginAuth.push(typeof state === "string" && result.envelope.ok
				? { plugin, ok: true, state, message: `${plugin}: ${state}` }
				: { plugin, ok: false, message: `${plugin}: auth status unavailable` });
		}
		return {
			executable,
			daemonExecutable,
			socket,
			broker: { ok: true, pluginCount: names.length, message: `broker: ready (${names.length} plugin${names.length === 1 ? "" : "s"})` },
			pluginAuth,
		};
	} catch (error) {
		return { executable, daemonExecutable, socket, broker: { ok: false, message: `broker: ${cleanText((error as Error).message)}` }, pluginAuth: [] };
	}
}

export function formatPlugStatus(status: PlugStatus): string {
	return [status.executable.message, status.daemonExecutable.message, status.socket.message, status.broker.message, ...status.pluginAuth.map((entry) => `auth: ${entry.message}`)].join("\n");
}
