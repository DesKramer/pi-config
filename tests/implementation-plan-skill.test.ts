import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { formatSkillsForPrompt, loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

const packageRoot = new URL("../", import.meta.url);

test("package discovers implementation-plan but excludes it from model invocation", () => {
	const manifest = JSON.parse(readFileSync(new URL("package.json", packageRoot), "utf8"));
	assert.ok(manifest.pi.skills.includes("./skills"));

	const { skills, diagnostics } = loadSkillsFromDir({
		dir: fileURLToPath(new URL("skills/", packageRoot)),
		source: "path",
	});
	assert.deepEqual(diagnostics, []);

	const matches = skills.filter((skill) => skill.name === "implementation-plan");
	assert.equal(matches.length, 1, "skill remains discoverable for explicit user commands");
	assert.equal(matches[0].disableModelInvocation, true);
	assert.equal(formatSkillsForPrompt(matches), "");

	const visibleControl = { ...matches[0], name: "visible-control", disableModelInvocation: false };
	const prompt = formatSkillsForPrompt([...matches, visibleControl]);
	assert.ok(prompt.includes("<name>visible-control</name>"));
	assert.ok(!prompt.includes("<name>implementation-plan</name>"));
});
