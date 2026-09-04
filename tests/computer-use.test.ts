import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	managedBrowserLaunchArgs,
	managedBrowserProfileDir,
	resolveUserDataDir,
} from "../vendor/pi-computer-use/src/browser-launch.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendoredPackage = join(repoRoot, "vendor", "pi-computer-use");

test("persistent browser profile paths resolve predictably without filesystem access", () => {
	assert.equal(resolveUserDataDir("~/.pi/browser-profiles/agent", "/work/project", "/home/test user"), "/home/test user/.pi/browser-profiles/agent");
	assert.equal(resolveUserDataDir("profiles/agent", "/work/project", "/home/test"), "/work/project/profiles/agent");
	assert.equal(resolveUserDataDir(" /absolute/profile ", "/work/project", "/home/test"), "/absolute/profile");
	assert.equal(resolveUserDataDir(undefined, "/work/project", "/home/test"), undefined);
	assert.throws(() => resolveUserDataDir("~someone/profile", "/work/project", "/home/test"), /supports '~' only/);
});

test("managed browser keeps temporary fallback and user-data-dir as one argv entry", () => {
	assert.equal(managedBrowserProfileDir(undefined, "chrome", 43123, "/tmp/safe"), "/tmp/safe/pi-chrome-cdp-43123");
	assert.equal(managedBrowserProfileDir("/persistent/profile", "chrome", 43123, "/tmp/safe"), "/persistent/profile");
	assert.deepEqual(managedBrowserLaunchArgs(43123, "/profile path/with spaces", "about:blank"), [
		"--remote-debugging-port=43123",
		"--user-data-dir=/profile path/with spaces",
		"--no-first-run",
		"--no-default-browser-check",
		"about:blank",
	]);
});

test("apply-config replaces npm computer-use sources and installs its global config", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-config-computer-use-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
		packages: [
			"npm:@injaneity/pi-computer-use",
			"npm:@injaneity/pi-computer-use@0.5.0",
			vendoredPackage,
			"npm:machine-local-package",
		],
	}));

	try {
		execFileSync(process.execPath, [join(repoRoot, "scripts", "apply-config.mjs")], {
			cwd: repoRoot,
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
			stdio: "pipe",
		});
		const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
		assert.equal(settings.packages.filter((source: string) => source === vendoredPackage).length, 1);
		assert.equal(settings.packages.some((source: string) => /^npm:@injaneity\/pi-computer-use(?:@.*)?$/.test(source)), false);
		assert.ok(settings.packages.includes("npm:machine-local-package"));

		const extensionConfig = JSON.parse(readFileSync(join(agentDir, "extensions", "pi-computer-use.json"), "utf8"));
		assert.deepEqual(extensionConfig, {
			browser_use: true,
			managed_browser: "chrome",
			user_data_dir: "~/.pi/browser-profiles/agent",
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
