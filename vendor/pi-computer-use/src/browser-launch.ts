import os from "node:os";
import path from "node:path";

/** Resolve a configured profile path without touching the filesystem. */
export function resolveUserDataDir(value: string | undefined, cwd: string, home = os.homedir()): string | undefined {
	const configured = value?.trim();
	if (!configured) return undefined;
	if (configured === "~") return path.resolve(home);
	if (configured.startsWith("~/") || configured.startsWith("~\\")) {
		return path.resolve(home, configured.slice(2));
	}
	if (configured.startsWith("~")) {
		throw new Error("user_data_dir supports '~' only as the whole path or as the first path segment.");
	}
	return path.isAbsolute(configured) ? path.normalize(configured) : path.resolve(cwd, configured);
}

export function managedBrowserProfileDir(userDataDir: string | undefined, browser: "helium" | "chrome", port: number, tempDir = os.tmpdir()): string {
	return userDataDir ?? path.join(tempDir, `pi-${browser}-cdp-${port}`);
}

/** Keep every Chromium switch, including user-data-dir paths with spaces, in its own argv entry. */
export function managedBrowserLaunchArgs(port: number, userDataDir: string, url: string): string[] {
	return [
		`--remote-debugging-port=${port}`,
		`--user-data-dir=${userDataDir}`,
		"--no-first-run",
		"--no-default-browser-check",
		url,
	];
}
