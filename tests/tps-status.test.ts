import assert from "node:assert/strict";
import test from "node:test";
import { formatCodexUsage } from "../extensions/tps-status.ts";

const NOW = 2_000_000_000;

for (const [seconds, expected] of [
	[0, "0s"],
	[1, "1s"],
	[59, "59s"],
	[60, "1m"],
	[61, "1m 1s"],
	[42 * 60 + 15, "42m 15s"],
	[3_599, "59m 59s"],
	[3_600, "1h"],
	[3_601, "1h"],
	[7_199, "1h"],
	[86_399, "23h"],
	[86_400, "1d"],
	[86_401, "1d"],
	[90_000, "1d 1h"],
	[2 * 86_400 + 5 * 3_600 + 59 * 60 + 59, "2d 5h"],
] as const) {
	test(`Codex quota formats ${seconds} seconds as ${expected}`, () => {
		assert.equal(formatCodexUsage({
			primary: {
				usedPercent: 25,
				limitWindowSeconds: 7 * 86_400,
				resetAt: NOW + seconds,
			},
		}, NOW), `${expected} 75%`);
	});
}

test("Codex quota formats both windows with the same duration rules", () => {
	assert.equal(formatCodexUsage({
		primary: { usedPercent: 25, limitWindowSeconds: 5 * 3_600, resetAt: NOW + 61 },
		secondary: { usedPercent: 40, limitWindowSeconds: 7 * 86_400, resetAt: NOW + 90_001 },
	}, NOW), "1m 1s 75% · 1d 1h 60%");
});

test("Codex quota shows remaining time until reset instead of the window length", () => {
	assert.equal(formatCodexUsage({
		primary: {
			usedPercent: 25,
			limitWindowSeconds: 7 * 24 * 60 * 60,
			resetAt: NOW + 3 * 60 * 60,
		},
	}, NOW), "3h 75%");
});

test("Codex quota falls back to the window length when reset_at is missing", () => {
	assert.equal(formatCodexUsage({
		primary: {
			usedPercent: 25,
			limitWindowSeconds: 7 * 24 * 60 * 60,
		},
	}, NOW), "7d 75%");
});

test("Codex quota clamps an expired reset to zero", () => {
	assert.equal(formatCodexUsage({
		primary: {
			usedPercent: 25,
			limitWindowSeconds: 7 * 24 * 60 * 60,
			resetAt: NOW - 1,
		},
	}, NOW), "0s 75%");
});
