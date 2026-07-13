import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ExecResult = Awaited<ReturnType<ExtensionAPI["exec"]>>;

const KEY = "git-status-widget";
const INTERVAL_MS = 3000;

function countUnstaged(porcelain: string): number {
	return porcelain
		.split(/\r?\n/)
		.filter(Boolean)
		.filter((line) => line.startsWith("??") || line[1] !== " ").length;
}

function cleanBranch(stdout: string): string {
	return stdout.trim() || "detached";
}

async function git(pi: ExtensionAPI, cwd: string, args: string[]): Promise<ExecResult> {
	return pi.exec("git", args, { cwd, timeout: 5000 });
}

export default function gitStatusWidget(pi: ExtensionAPI) {
	let timer: NodeJS.Timeout | undefined;
	let activeCwd: string | undefined;
	let inFlight = false;

	async function update(ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1]) {
		if (!activeCwd || inFlight) return;
		inFlight = true;
		try {
			const inside = await git(pi, activeCwd, ["rev-parse", "--is-inside-work-tree"]);
			if (inside.code !== 0 || inside.stdout.trim() !== "true") {
				ctx.ui.setWidget(KEY, undefined);
				return;
			}

			const [branch, status] = await Promise.all([
				git(pi, activeCwd, ["branch", "--show-current"]),
				git(pi, activeCwd, ["status", "--porcelain"]),
			]);
			const unstaged = countUnstaged(status.stdout);
			const color = unstaged === 0 ? "success" : "warning";
			ctx.ui.setWidget(KEY, [
				ctx.ui.theme.fg("dim", "git ") +
					ctx.ui.theme.fg("accent", cleanBranch(branch.stdout)) +
					ctx.ui.theme.fg("dim", " · ") +
					ctx.ui.theme.fg(color, `${unstaged} unstaged`),
			]);
		} catch {
			ctx.ui.setWidget(KEY, undefined);
		} finally {
			inFlight = false;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		activeCwd = ctx.cwd;
		if (timer) clearInterval(timer);
		await update(ctx);
		timer = setInterval(() => void update(ctx), INTERVAL_MS);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (timer) clearInterval(timer);
		timer = undefined;
		activeCwd = undefined;
		ctx.ui.setWidget(KEY, undefined);
	});
}
