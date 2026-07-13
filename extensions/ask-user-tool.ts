import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type AskUserDetails = {
	question: string;
	options: string[];
	answer: string | null;
	wasCustom?: boolean;
};

const AskUserParams = Type.Object({
	question: Type.String({ description: "Question to ask the user" }),
	options: Type.Array(Type.String({ description: "A concise answer option" }), {
		description: "2 to 5 multiple-choice options",
		minItems: 2,
		maxItems: 5,
	}),
});

export default function askUserTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description:
			"Ask the user a multiple-choice question with 2-5 options plus a write-your-own answer option. Use when you need clarification before proceeding.",
		promptSnippet: "Ask the user a 2-5 option clarification question with an optional free-form answer",
		promptGuidelines: [
			"Use ask_user when you need a decision or clarification before making changes; provide 2-5 concrete options.",
		],
		parameters: AskUserParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const options = params.options.map((option) => option.trim()).filter(Boolean).slice(0, 5);
			if (options.length < 2) {
				return {
					content: [{ type: "text", text: "ask_user error: provide at least 2 non-empty options" }],
					details: { question: params.question, options, answer: null } satisfies AskUserDetails,
				};
			}

			if (ctx.mode !== "tui") {
				return {
					content: [{ type: "text", text: "ask_user error: interactive UI is not available" }],
					details: { question: params.question, options, answer: null } satisfies AskUserDetails,
				};
			}

			const allOptions = [...options, "Write my own answer…"];
			const result = await ctx.ui.custom<{ answer: string; wasCustom: boolean; index?: number } | null>(
				(tui, theme, _keybindings, done) => {
					let selectedIndex = 0;
					let editMode = false;
					let cachedLines: string[] | undefined;

					const editorTheme: EditorTheme = {
						borderColor: (s) => theme.fg("accent", s),
						selectList: {
							selectedPrefix: (s) => theme.fg("accent", s),
							selectedText: (s) => theme.fg("accent", s),
							description: (s) => theme.fg("muted", s),
							scrollInfo: (s) => theme.fg("dim", s),
							noMatch: (s) => theme.fg("warning", s),
						},
					};
					const editor = new Editor(tui, editorTheme);

					function refresh() {
						cachedLines = undefined;
						tui.requestRender();
					}

					editor.onSubmit = (value) => {
						const answer = value.trim();
						if (!answer) {
							editMode = false;
							editor.setText("");
							refresh();
							return;
						}
						done({ answer, wasCustom: true });
					};

					function addWrapped(lines: string[], width: number, prefix: string, text: string) {
						const prefixWidth = visibleWidth(prefix);
						const bodyWidth = Math.max(1, width - prefixWidth);
						const wrapped = wrapTextWithAnsi(text, bodyWidth);
						const continuation = " ".repeat(prefixWidth);
						for (let i = 0; i < wrapped.length; i++) {
							lines.push(`${i === 0 ? prefix : continuation}${wrapped[i]}`);
						}
					}

					return {
						handleInput(data: string) {
							if (editMode) {
								if (matchesKey(data, Key.escape)) {
									editMode = false;
									editor.setText("");
									refresh();
									return;
								}
								editor.handleInput(data);
								refresh();
								return;
							}

							if (matchesKey(data, Key.up)) {
								selectedIndex = Math.max(0, selectedIndex - 1);
								refresh();
								return;
							}
							if (matchesKey(data, Key.down)) {
								selectedIndex = Math.min(allOptions.length - 1, selectedIndex + 1);
								refresh();
								return;
							}
							if (matchesKey(data, Key.enter)) {
								if (selectedIndex === allOptions.length - 1) {
									editMode = true;
									refresh();
									return;
								}
								done({ answer: options[selectedIndex], wasCustom: false, index: selectedIndex + 1 });
								return;
							}
							if (matchesKey(data, Key.escape)) done(null);
						},
						render(width: number) {
							if (cachedLines) return cachedLines;
							const w = Math.max(1, width);
							const lines: string[] = [theme.fg("accent", "─".repeat(w))];
							addWrapped(lines, w, " ", theme.fg("text", params.question));
							lines.push("");

							for (let i = 0; i < allOptions.length; i++) {
								const selected = i === selectedIndex;
								const prefix = selected ? theme.fg("accent", "> ") : "  ";
								const label = `${i + 1}. ${allOptions[i]}${editMode && i === allOptions.length - 1 ? " ✎" : ""}`;
								addWrapped(lines, w, prefix, theme.fg(selected ? "accent" : "text", label));
							}

							if (editMode) {
								lines.push("");
								addWrapped(lines, w, " ", theme.fg("muted", "Your answer:"));
								for (const line of editor.render(Math.max(1, w - 2))) lines.push(` ${line}`);
							}

							lines.push("");
							addWrapped(lines, w, " ", theme.fg("dim", editMode ? "Enter submit • Esc back" : "↑↓ choose • Enter select • Esc cancel"));
							lines.push(theme.fg("accent", "─".repeat(w)));
							cachedLines = lines;
							return lines;
						},
						invalidate() {
							cachedLines = undefined;
						},
					};
				},
				{ overlay: true, overlayOptions: { width: "80%", maxHeight: "80%" } },
			);

			if (!result) {
				return {
					content: [{ type: "text", text: "User cancelled ask_user" }],
					details: { question: params.question, options, answer: null } satisfies AskUserDetails,
				};
			}

			return {
				content: [
					{
						type: "text",
						text: result.wasCustom
							? `User wrote: ${result.answer}`
							: `User selected: ${result.index}. ${result.answer}`,
					},
				],
				details: {
					question: params.question,
					options,
					answer: result.answer,
					wasCustom: result.wasCustom,
				} satisfies AskUserDetails,
			};
		},

		renderCall(args, theme) {
			const options = Array.isArray(args.options) ? args.options : [];
			const optionText = options.length ? `\n${theme.fg("dim", `  Options: ${options.map((o: string, i: number) => `${i + 1}. ${o}`).join(", ")}, write own`)}` : "";
			return new Text(theme.fg("toolTitle", theme.bold("ask_user ")) + theme.fg("muted", args.question ?? "") + optionText, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as AskUserDetails | undefined;
			if (!details?.answer) return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			const prefix = details.wasCustom ? "✎ " : "✓ ";
			return new Text(theme.fg(details.wasCustom ? "accent" : "success", prefix) + theme.fg("accent", details.answer), 0, 0);
		},
	});
}
