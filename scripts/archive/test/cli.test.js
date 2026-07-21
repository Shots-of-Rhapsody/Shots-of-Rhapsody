import assert from "node:assert/strict";
import test from "node:test";
import { main as importMain } from "../import.js";
import { main as verifyMain } from "../verify.js";

async function captureConsole(callback) {
	const output = [];
	const originalLog = console.log;
	const originalError = console.error;
	console.log = (...values) => output.push(values.join(" "));
	console.error = (...values) => output.push(values.join(" "));
	try {
		return { exitCode: await callback(), output: output.join("\n") };
	} finally {
		console.log = originalLog;
		console.error = originalError;
	}
}

test("archive import CLI exposes help and rejects unsafe option combinations", async () => {
	const help = await captureConsole(() => importMain(["--help"]));
	assert.equal(help.exitCode, 0);
	assert.match(help.output, /Reads only ignored, locally saved Proton Docs/u);

	const noSelection = await captureConsole(() => importMain([]));
	assert.equal(noSelection.exitCode, 2);
	assert.match(noSelection.output, /Select either --slug or --all/u);

	const unsafeUpdate = await captureConsole(() =>
		importMain(["--slug", "exact-article", "--update"]),
	);
	assert.equal(unsafeUpdate.exitCode, 2);
	assert.match(unsafeUpdate.output, /--update requires --write/u);
});

test("archive verify CLI exposes help and rejects unknown arguments", async () => {
	const help = await captureConsole(() => verifyMain(["--help"]));
	assert.equal(help.exitCode, 0);
	assert.match(help.output, /Re-extract and compare ignored local raw inputs/u);

	const invalid = await captureConsole(() => verifyMain(["--unknown"]));
	assert.equal(invalid.exitCode, 2);
	assert.match(invalid.output, /Unknown option/u);
});
