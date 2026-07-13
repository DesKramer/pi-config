import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_OUTPUT_CHARS = 50_000;
const MAX_OUTPUT_LINES = 2_000;
const DEFAULT_TIMEOUT_MS = 60_000;

const SearchParams = Type.Object({
	query: Type.String({ description: "Web search query" }),
	limit: Type.Optional(Type.Number({ description: "Maximum results to return (default 5, max 100)", minimum: 1, maximum: 100 })),
	sources: Type.Optional(Type.Array(Type.String({ description: "Source: web, images, or news" }), {
		description: "Sources to search. Defaults to ['web'].",
	})),
	categories: Type.Optional(Type.Array(Type.String({ description: "Category filter: github, research, or pdf" }), {
		description: "Optional category filters.",
	})),
	tbs: Type.Optional(Type.String({ description: "Time filter: qdr:h (hour), qdr:d (day), qdr:w (week), qdr:m (month), qdr:y (year)" })),
	location: Type.Optional(Type.String({ description: "Geo target location, e.g. 'Germany' or 'San Francisco,California,United States'" })),
	country: Type.Optional(Type.String({ description: "ISO country code for geo targeting, e.g. US, DE, BR" })),
	scrape: Type.Optional(Type.Boolean({ description: "Also scrape result pages and include page content. Uses more Firecrawl credits. Default false." })),
	scrapeFormats: Type.Optional(Type.Array(Type.String({ description: "Scrape format, e.g. markdown, html, rawHtml, links" }), {
		description: "Formats to return when scrape=true. Default ['markdown'].",
	})),
	onlyMainContent: Type.Optional(Type.Boolean({ description: "When scrape=true, include only main page content. Default true." })),
	ignoreInvalidUrls: Type.Optional(Type.Boolean({ description: "Exclude URLs invalid for other Firecrawl endpoints. Default false." })),
	timeoutMs: Type.Optional(Type.Number({ description: "Firecrawl request timeout in milliseconds. Default 60000." })),
});

const ScrapeParams = Type.Object({
	url: Type.String({ description: "URL to scrape" }),
	formats: Type.Optional(Type.Array(Type.String({ description: "Format: markdown, html, rawHtml, links, images, screenshot, summary, json, attributes, branding" }), {
		description: "Output formats. Default ['markdown'].",
	})),
	onlyMainContent: Type.Optional(Type.Boolean({ description: "Include only main content. Default true for this tool." })),
	waitForMs: Type.Optional(Type.Number({ description: "Wait before scraping, in milliseconds" })),
	maxAgeMs: Type.Optional(Type.Number({ description: "Maximum age of cached content in milliseconds" })),
	country: Type.Optional(Type.String({ description: "ISO country code for geo-targeted scraping, e.g. US, DE, BR" })),
	languages: Type.Optional(Type.Array(Type.String({ description: "Language code, e.g. en, es" }), {
		description: "Language codes for scraping.",
	})),
	includeTags: Type.Optional(Type.Array(Type.String({ description: "HTML tag/selector to include" }), {
		description: "Comma-separated include tags/selectors passed to Firecrawl.",
	})),
	excludeTags: Type.Optional(Type.Array(Type.String({ description: "HTML tag/selector to exclude" }), {
		description: "Comma-separated exclude tags/selectors passed to Firecrawl.",
	})),
	query: Type.Optional(Type.String({ description: "Ask a focused question about the page content. Firecrawl returns an answer." })),
	profile: Type.Optional(Type.String({ description: "Persistent browser profile name for maintaining state across scrapes" })),
	proxy: Type.Optional(Type.String({ description: "Proxy mode, e.g. auto or basic" })),
	lockdown: Type.Optional(Type.Boolean({ description: "Enable Firecrawl lockdown mode. Default false." })),
	redactPii: Type.Optional(Type.Boolean({ description: "Redact personally identifiable information. Default false." })),
	timeoutMs: Type.Optional(Type.Number({ description: "Local CLI timeout in milliseconds. Default 60000." })),
});

type ExecResult = Awaited<ReturnType<ExtensionAPI["exec"]>>;

type ToolOutputDetails = {
	command: string[];
	code: number;
	stderr?: string;
	truncated: boolean;
	fullOutputPath?: string;
	parsedSummary?: unknown;
};

function cleanStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const cleaned = value.map((item) => String(item).trim()).filter(Boolean);
	return cleaned.length > 0 ? cleaned : undefined;
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pushCsv(args: string[], flag: string, values: unknown): void {
	const cleaned = cleanStringArray(values);
	if (cleaned) args.push(flag, cleaned.join(","));
}

function pushOptional(args: string[], flag: string, value: unknown): void {
	if (typeof value === "string" && value.trim()) args.push(flag, value.trim());
	else if (typeof value === "number" && Number.isFinite(value)) args.push(flag, String(value));
}

function parseJsonMaybe(text: string): unknown | undefined {
	const trimmed = text.trim();
	if (!trimmed) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
}

function summarizeParsed(value: unknown): unknown {
	if (!value || typeof value !== "object") return undefined;
	const obj = value as Record<string, any>;

	if (obj.data && typeof obj.data === "object") {
		const data = obj.data as Record<string, any>;
		const summary: Record<string, unknown> = {
			success: obj.success,
			id: obj.id,
			creditsUsed: obj.creditsUsed,
		};
		for (const key of ["web", "images", "news"]) {
			const items = data[key];
			if (Array.isArray(items)) {
				summary[key] = {
					count: items.length,
					results: items.slice(0, 10).map((item) => ({
						title: item?.title,
						url: item?.url,
						imageUrl: item?.imageUrl,
						date: item?.date,
						category: item?.category,
						description: item?.description ?? item?.snippet,
						markdownChars: typeof item?.markdown === "string" ? item.markdown.length : undefined,
					})),
				};
			}
		}
		return summary;
	}

	const summary: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(obj)) {
		if (typeof item === "string") summary[key] = { type: "string", chars: item.length };
		else if (Array.isArray(item)) summary[key] = { type: "array", count: item.length };
		else if (item && typeof item === "object") summary[key] = key === "metadata" ? item : { type: "object", keys: Object.keys(item) };
		else summary[key] = item;
	}
	return summary;
}

async function truncateOutput(output: string, prefix = ""): Promise<{ text: string; truncated: boolean; fullOutputPath?: string }> {
	const full = prefix ? `${prefix}${output}` : output;
	const lines = full.split(/\r?\n/);
	let truncated = lines.length > MAX_OUTPUT_LINES;
	let kept = truncated ? lines.slice(0, MAX_OUTPUT_LINES).join("\n") : full;

	if (kept.length > MAX_OUTPUT_CHARS) {
		kept = kept.slice(0, MAX_OUTPUT_CHARS);
		truncated = true;
	}

	if (!truncated) return { text: kept, truncated: false };

	const fullOutputPath = join(tmpdir(), `pi-firecrawl-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
	await writeFile(fullOutputPath, full, "utf8");
	const notice = `\n\n[Firecrawl output truncated to ${MAX_OUTPUT_LINES} lines / ${MAX_OUTPUT_CHARS} chars. Full output saved to: ${fullOutputPath}]`;
	return { text: kept + notice, truncated: true, fullOutputPath };
}

async function runFirecrawl(pi: ExtensionAPI, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<ExecResult> {
	return pi.exec("firecrawl", args, { timeout: timeoutMs, signal });
}

function commandText(args: string[]): string {
	return ["firecrawl", ...args].join(" ");
}

async function formatResult(args: string[], result: ExecResult): Promise<{ content: [{ type: "text"; text: string }]; details: ToolOutputDetails }> {
	const stderr = result.stderr?.trim();
	if (result.code !== 0) {
		const message = [`firecrawl command failed with exit code ${result.code}.`, `Command: ${commandText(args)}`];
		if (stderr) message.push(`stderr:\n${stderr}`);
		if (result.stdout?.trim()) message.push(`stdout:\n${result.stdout.trim()}`);
		throw new Error(message.join("\n\n"));
	}

	const parsed = parseJsonMaybe(result.stdout);
	const prefix = stderr ? `[firecrawl stderr]\n${stderr}\n\n[firecrawl stdout]\n` : "";
	const output = await truncateOutput(result.stdout.trimEnd(), prefix);
	return {
		content: [{ type: "text", text: output.text || "Firecrawl returned no output." }],
		details: {
			command: ["firecrawl", ...args],
			code: result.code,
			stderr: stderr || undefined,
			truncated: output.truncated,
			fullOutputPath: output.fullOutputPath,
			parsedSummary: summarizeParsed(parsed),
		},
	};
}

export default function firecrawlTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "firecrawl_search",
		label: "Firecrawl Search",
		description: "Search the web using the Firecrawl CLI. Can optionally scrape search results and return page content.",
		promptSnippet: "Search the web using Firecrawl; optionally scrape result pages for markdown/html content",
		promptGuidelines: [
			"Use firecrawl_search when current web information is needed and Firecrawl is appropriate.",
			"Set firecrawl_search.scrape=true only when snippets are insufficient; scraping uses additional Firecrawl credits.",
		],
		parameters: SearchParams,
		async execute(_toolCallId, params, signal) {
			const args = ["search", params.query, "--json"];
			args.push("--limit", String(Math.min(Math.max(Math.round(params.limit ?? 5), 1), 100)));

			pushCsv(args, "--sources", params.sources);
			pushCsv(args, "--categories", params.categories);
			pushOptional(args, "--tbs", params.tbs);
			pushOptional(args, "--location", params.location);
			pushOptional(args, "--country", params.country);
			pushOptional(args, "--timeout", optionalNumber(params.timeoutMs));

			if (params.ignoreInvalidUrls === true) args.push("--ignore-invalid-urls");
			if (params.scrape === true) {
				args.push("--scrape");
				pushCsv(args, "--scrape-formats", params.scrapeFormats);
				if (params.onlyMainContent !== false) args.push("--only-main-content");
			}

			const result = await runFirecrawl(pi, args, optionalNumber(params.timeoutMs) ?? DEFAULT_TIMEOUT_MS, signal);
			return formatResult(args, result);
		},
	});

	pi.registerTool({
		name: "firecrawl_scrape",
		label: "Firecrawl Scrape",
		description: "Scrape a page using the Firecrawl CLI and return markdown, HTML, links, images, screenshots, summaries, or structured JSON.",
		promptSnippet: "Scrape a URL using Firecrawl and return markdown/html/links/images/summary/JSON content",
		promptGuidelines: [
			"Use firecrawl_scrape when the user asks to read, summarize, or extract data from a specific URL.",
			"Prefer firecrawl_scrape formats=['markdown'] unless the user needs links, images, HTML, screenshots, summaries, or structured JSON.",
		],
		parameters: ScrapeParams,
		async execute(_toolCallId, params, signal) {
			const formats = cleanStringArray(params.formats) ?? ["markdown"];
			const args = ["scrape", params.url, "--json", "--format", formats.join(",")];

			if (params.onlyMainContent !== false) args.push("--only-main-content");
			pushOptional(args, "--wait-for", optionalNumber(params.waitForMs));
			pushOptional(args, "--max-age", optionalNumber(params.maxAgeMs));
			pushOptional(args, "--country", params.country);
			pushCsv(args, "--languages", params.languages);
			pushCsv(args, "--include-tags", params.includeTags);
			pushCsv(args, "--exclude-tags", params.excludeTags);
			pushOptional(args, "--query", params.query);
			pushOptional(args, "--profile", params.profile);
			pushOptional(args, "--proxy", params.proxy);
			if (params.lockdown === true) args.push("--lockdown");
			if (params.redactPii === true) args.push("--redact-pii");

			const result = await runFirecrawl(pi, args, optionalNumber(params.timeoutMs) ?? DEFAULT_TIMEOUT_MS, signal);
			return formatResult(args, result);
		},
	});

	pi.registerCommand("firecrawl-status", {
		description: "Show Firecrawl CLI auth/concurrency/credit status",
		handler: async (_args, ctx) => {
			const result = await runFirecrawl(pi, ["--status"], 10_000);
			const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
			ctx.ui.notify(output || `firecrawl --status exited with code ${result.code}`, result.code === 0 ? "info" : "error");
		},
	});
}
