import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

// Keep these defaults aligned with remote-pi/apps/daemon/src/config.ts.
export function resolveBridgeSocketPath(
	platform: NodeJS.Platform = process.platform,
	home: string = homedir(),
	env: NodeJS.ProcessEnv = process.env,
): string {
	if (env.REMOTE_PI_BRIDGE_SOCKET !== undefined) return env.REMOTE_PI_BRIDGE_SOCKET;
	const xdg = env.XDG_DATA_HOME;
	const defaultDataDir = platform === "linux"
		? join(xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "share"), "remote-pi")
		: join(home, "Library", "Application Support", "remote-pi");
	return join(env.REMOTE_PI_DATA_DIR ?? defaultDataDir, "bridge.sock");
}
