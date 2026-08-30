import assert from "node:assert/strict";
import test from "node:test";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import {
	createFuzzyFileProvider,
	extractAtToken,
	FdFileIndex,
	isWithinOneEdit,
	rankFileEntries,
} from "../extensions/fuzzy-file-autocomplete.ts";

test("recognizes pi-compatible quoted and unquoted @ path tokens", () => {
	assert.deepEqual(extractAtToken("read @src/utls"), {
		prefix: "@src/utls",
		rawQuery: "src/utls",
		quoted: false,
	});
	assert.deepEqual(extractAtToken('read @"docs/my fle'), {
		prefix: '@"docs/my fle',
		rawQuery: "docs/my fle",
		quoted: true,
	});
	assert.equal(extractAtToken("email@example.com"), undefined);
});

test("matcher permits one insertion, deletion, or substitution but not two edits", () => {
	assert.equal(isWithinOneEdit("utils", "utls"), true);
	assert.equal(isWithinOneEdit("utils", "utiils"), true);
	assert.equal(isWithinOneEdit("utils", "utxils"), true);
	assert.equal(isWithinOneEdit("utils", "utxlos"), false);
	assert.equal(isWithinOneEdit("readme", "raedme"), false, "transposition is two edits");
});

test("ranking keeps exact matches first and tolerates one edit in a scoped leaf query", () => {
	const entries = [
		{ path: "src/nested/utility.ts", isDirectory: false },
		{ path: "src/utils.ts", isDirectory: false },
		{ path: "src/utls-notes.ts", isDirectory: false },
		{ path: "other/utils.ts", isDirectory: false },
	];
	const token = extractAtToken("@src/utls")!;
	const items = rankFileEntries(entries, token);

	assert.deepEqual(items.map((item) => item.value), [
		"@src/utls-notes.ts",
		"@src/utils.ts",
	]);
	assert.ok(items.every((item) => !item.value.includes("other/")));
});

test("ranking preserves quotes, hidden files, directories, and deterministic ordering", () => {
	const items = rankFileEntries([
		{ path: "z/my file.ts", isDirectory: false },
		{ path: ".hidden/my folder", isDirectory: true },
		{ path: "a/my file.ts", isDirectory: false },
	], extractAtToken('@"my fil')!);

	assert.deepEqual(items.map((item) => item.value), [
		'@"a/my file.ts"',
		'@"z/my file.ts"',
		'@".hidden/my folder/"',
	]);
});

test("fd index requests ignore-aware hidden traversal, excludes .git, and caches results", async () => {
	const calls: Array<{ command: string; args: string[] }> = [];
	const index = new FdFileIndex(async (command, args) => {
		calls.push({ command, args });
		return {
			code: 0,
			stdout: "./src/\0./src/file.ts\0./.hidden\0./.git/config\0",
		};
	});
	const signal = new AbortController().signal;
	const first = await index.get(signal);
	const second = await index.get(signal);

	assert.deepEqual(first, [
		{ path: ".hidden", isDirectory: false },
		{ path: "src", isDirectory: true },
		{ path: "src/file.ts", isDirectory: false },
	]);
	assert.equal(second, first);
	assert.equal(calls.length, 1);
	assert.ok(calls[0]!.args.includes("--hidden"));
	assert.ok(calls[0]!.args.includes("--print0"));
	assert.ok(calls[0]!.args.includes(".git/**"));
});

test("provider preserves existing suggestions before adding typo matches", async () => {
	const current: AutocompleteProvider = {
		async getSuggestions() {
			return {
				prefix: "@utls",
				items: [{ value: "@utls-notes.ts", label: "utls-notes.ts" }],
			};
		},
		applyCompletion(lines, cursorLine, cursorCol) {
			return { lines, cursorLine, cursorCol };
		},
	};
	const index = new FdFileIndex(async () => ({
		code: 0,
		stdout: "utils.ts\0utls-notes.ts\0",
	}));
	const provider = createFuzzyFileProvider(current, index);
	const result = await provider.getSuggestions(
		["@utls"],
		0,
		5,
		{ signal: new AbortController().signal },
	);

	assert.deepEqual(result?.items.map((item) => item.value), ["@utls-notes.ts", "@utils.ts"]);
});

test("an aborted request returns without starting fd", async () => {
	let called = false;
	const index = new FdFileIndex(async () => {
		called = true;
		return { code: 0, stdout: "file.ts\0" };
	});
	const controller = new AbortController();
	controller.abort();
	assert.equal(await index.get(controller.signal), undefined);
	assert.equal(called, false);
});
