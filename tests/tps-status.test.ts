import assert from "node:assert/strict";
import test from "node:test";
import { formatCodexUsage } from "../extensions/tps-status.ts";

const NOW = 2_000_000_000;

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
