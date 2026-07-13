import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const PATCH_SYMBOL = Symbol.for("deskramer.prettyMarkdownCodeBlocks.originalRenderToken");

type MarkdownInstance = {
	theme: {
		codeBlock: (text: string) => string;
		codeBlockBorder: (text: string) => string;
		highlightCode?: (code: string, lang?: string) => string[];
	};
	renderToken: (token: any, width: number, nextTokenType?: string, styleContext?: unknown) => string[];
	[PATCH_SYMBOL]?: MarkdownInstance["renderToken"];
};

function renderPrettyCodeBlock(instance: MarkdownInstance, token: any, width: number, nextTokenType?: string): string[] {
	const theme = instance.theme;
	const lines: string[] = [];
	const lang = typeof token.lang === "string" && token.lang.trim() ? token.lang.trim() : "text";
	const indent = "  ";
	const codeWidth = Math.max(1, width - visibleWidth(indent));

	// Keep a lightweight top label with the fence language/type, but remove the
	// literal ``` fences and the boxed border.
	lines.push(theme.codeBlockBorder(`▸ ${lang}`));

	const highlighted = theme.highlightCode
		? theme.highlightCode(String(token.text ?? ""), typeof token.lang === "string" ? token.lang : undefined)
		: String(token.text ?? "")
			.split("\n")
			.map((line) => theme.codeBlock(line));

	for (const codeLine of highlighted.length > 0 ? highlighted : [""]) {
		const wrapped = visibleWidth(codeLine) === 0 ? [""] : wrapTextWithAnsi(codeLine, codeWidth);
		for (const segment of wrapped.length > 0 ? wrapped : [""]) {
			lines.push(`${indent}${segment}`);
		}
	}

	if (nextTokenType && nextTokenType !== "space") {
		lines.push("");
	}
	return lines;
}

function patchMarkdownCodeBlocks(): void {
	const proto = Markdown.prototype as unknown as MarkdownInstance;
	if (proto[PATCH_SYMBOL]) return;

	const original = proto.renderToken;
	proto[PATCH_SYMBOL] = original;
	proto.renderToken = function patchedRenderToken(token: any, width: number, nextTokenType?: string, styleContext?: unknown): string[] {
		if (token?.type === "code") {
			return renderPrettyCodeBlock(this as MarkdownInstance, token, width, nextTokenType);
		}
		return original.call(this, token, width, nextTokenType, styleContext);
	};
}

export default function prettyMarkdownCode(_pi: ExtensionAPI) {
	patchMarkdownCodeBlocks();
}
