import { StringDecoder } from "node:string_decoder";

export type JsonlParseResult =
	| { ok: true; value: unknown }
	| { ok: false; error: Error; raw: string };

/**
 * Encode one strict LF-delimited JSONL record.
 * Writers always append a single LF and never CRLF.
 */
export function encodeJsonlRecord(value: unknown): string {
	const json = JSON.stringify(value);
	if (json === undefined) throw new Error("JSONL record must be JSON-serializable");
	if (json.includes("\n") || json.includes("\r")) {
		// JSON.stringify escapes ordinary string newlines; raw CR/LF would indicate a
		// custom toJSON/raw JSON value or other unsafe framing source.
		throw new Error("JSONL record contains a raw line delimiter");
	}
	return `${json}\n`;
}

export class StrictLfJsonlParser {
	private decoder = new StringDecoder("utf8");
	private buffer = "";

	push(chunk: Buffer | string): JsonlParseResult[] {
		this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
		return this.drain(false);
	}

	end(): JsonlParseResult[] {
		this.buffer += this.decoder.end();
		return this.drain(true);
	}

	private drain(flushRemainder: boolean): JsonlParseResult[] {
		const results: JsonlParseResult[] = [];
		while (true) {
			const newline = this.buffer.indexOf("\n");
			if (newline === -1) break;
			const raw = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			results.push(parseJsonlLine(raw));
		}

		if (flushRemainder && this.buffer.length > 0) {
			const raw = this.buffer;
			this.buffer = "";
			results.push(parseJsonlLine(raw));
		}

		return results;
	}
}

function parseJsonlLine(raw: string): JsonlParseResult {
	try {
		if (raw.endsWith("\r")) {
			throw new Error("CRLF is not valid strict bridge JSONL framing");
		}
		const value = JSON.parse(raw) as unknown;
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error("JSONL record must be a JSON object");
		}
		return { ok: true, value };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error : new Error(String(error)), raw };
	}
}
