import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";

const MAX_SUGGESTIONS = 20;

type SkillRef = {
	name: string;
	description?: string;
	filePath: string;
	baseDir: string;
};

function stripFrontmatter(content: string): string {
	if (!content.startsWith("---")) return content;
	return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

function escapeXmlAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function getSkills(pi: ExtensionAPI): SkillRef[] {
	return pi
		.getCommands()
		.filter((command) => command.source === "skill" && command.name.startsWith("skill:"))
		.map((command) => {
			const filePath = command.sourceInfo.path;
			return {
				name: command.name.slice("skill:".length),
				description: command.description,
				filePath,
				baseDir: command.sourceInfo.baseDir ?? dirname(filePath),
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

function extractSkillToken(textBeforeCursor: string): string | undefined {
	const match = textBeforeCursor.match(/(?:^|[ \t([{])\$([A-Za-z0-9-]*)$/);
	return match?.[1];
}

function formatSkillItem(skill: SkillRef): AutocompleteItem {
	return {
		value: `$${skill.name}`,
		label: `$${skill.name}`,
		description: skill.description ?? skill.filePath,
	};
}

function fuzzyScore(haystack: string, needle: string): number | undefined {
	let score = 0;
	let lastIndex = -1;
	const lowerHaystack = haystack.toLowerCase();
	const lowerNeedle = needle.toLowerCase();

	for (const char of lowerNeedle) {
		const index = lowerHaystack.indexOf(char, lastIndex + 1);
		if (index === -1) return undefined;
		score += index === lastIndex + 1 ? 1 : 5 + index - lastIndex;
		lastIndex = index;
	}

	return score + haystack.length / 1000;
}

function filterSkills(skills: SkillRef[], query: string): AutocompleteItem[] {
	if (!query.trim()) {
		return skills.slice(0, MAX_SUGGESTIONS).map(formatSkillItem);
	}

	const lowerQuery = query.toLowerCase();
	const prefixMatches = skills.filter((skill) => skill.name.startsWith(lowerQuery));
	const matches = prefixMatches.length > 0
		? prefixMatches
		: skills
			.map((skill) => ({ skill, score: fuzzyScore(`${skill.name} ${skill.description ?? ""}`, query) }))
			.filter((match): match is { skill: SkillRef; score: number } => match.score !== undefined)
			.sort((a, b) => a.score - b.score)
			.map((match) => match.skill);

	return matches.slice(0, MAX_SUGGESTIONS).map(formatSkillItem);
}

function createSkillAutocompleteProvider(current: AutocompleteProvider, pi: ExtensionAPI): AutocompleteProvider {
	return {
		triggerCharacters: ["$"],

		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const currentLine = lines[cursorLine] ?? "";
			const textBeforeCursor = currentLine.slice(0, cursorCol);
			const token = extractSkillToken(textBeforeCursor);
			if (token === undefined) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const suggestions = filterSkills(getSkills(pi), token);
			if (options.signal.aborted || suggestions.length === 0) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			return {
				prefix: `$${token}`,
				items: suggestions,
			};
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

function formatSkillBlock(skill: SkillRef): string {
	const content = readFileSync(skill.filePath, "utf8");
	const body = stripFrontmatter(content).trim();
	return `<skill name="${escapeXmlAttribute(skill.name)}" location="${escapeXmlAttribute(skill.filePath)}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
}

function expandDollarSkillMentions(text: string, skills: SkillRef[]): string | undefined {
	const byName = new Map(skills.map((skill) => [skill.name, skill]));
	const referenced = new Map<string, SkillRef>();

	const rewritten = text.replace(/(^|[^\\\w-])\$([a-z0-9][a-z0-9-]{0,63})(?=$|[^\w-])/g, (full, prefix: string, name: string) => {
		const skill = byName.get(name);
		if (!skill) return full;
		referenced.set(name, skill);
		return `${prefix}skill:${name}`;
	});

	if (referenced.size === 0) return undefined;

	const blocks = [...referenced.values()].map(formatSkillBlock).join("\n\n");
	return `${blocks}\n\nUser request:\n${rewritten}`;
}

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.addAutocompleteProvider((current) => createSkillAutocompleteProvider(current, pi));
	});

	pi.on("input", (event, ctx) => {
		if (event.source === "extension") return { action: "continue" as const };

		try {
			const expanded = expandDollarSkillMentions(event.text, getSkills(pi));
			if (!expanded) return { action: "continue" as const };
			return { action: "transform" as const, text: expanded, images: event.images };
		} catch (error) {
			if (ctx.hasUI) {
				ctx.ui.notify(`skill-dollar: failed to expand skill mention: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
			return { action: "continue" as const };
		}
	});
}
