import assert from "node:assert/strict";
import test from "node:test";
import { main as captureFinalizeMain } from "./capture-finalize.mjs";
import { main as captureScaffoldMain } from "./capture-scaffold.mjs";
import { main as cloudCaptureMain } from "./cloud-capture.mjs";
import { main as cloudVerifyMain } from "./cloud-verify.mjs";
import { main as recordV2Main } from "./record-v2.mjs";
import { main as updateMain } from "./update.mjs";
import { main as verifyV2Main } from "./verify-v2.mjs";

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

test("Proton cloud CLIs require explicit evidence paths", async () => {
	const missingPathCases = [
		{
			label: "cloud capture",
			run: () => cloudCaptureMain(["--cli", "C:\\Tools\\proton-drive.exe"]),
			expected: /--cli and --output are required/u,
		},
		{
			label: "cloud verify",
			run: () => cloudVerifyMain([]),
			expected: /--capture is required/u,
		},
		{
			label: "capture scaffold",
			run: () =>
				captureScaffoldMain(["--generated-at", "2026-07-28T12:34:56.789Z"]),
			expected: /--generated-at, --cloud, and --output are required/u,
		},
		{
			label: "capture finalize",
			run: () => captureFinalizeMain([]),
			expected: /--cloud is required/u,
		},
		{
			label: "V2 record",
			run: () => recordV2Main([]),
			expected: /--cloud is required/u,
		},
		{
			label: "V2 update",
			run: () =>
				updateMain([
					"--slug",
					"exact-work",
					"--previous-ledger-sha",
					`sha256:${"0".repeat(64)}`,
				]),
			expected: /--slug, --previous-ledger-sha, and --cloud are required/u,
		},
		{
			label: "V2 raw/cloud verify",
			run: () => verifyV2Main(["--with-cloud"]),
			expected: /--cloud is required with --with-raw or --with-cloud/u,
		},
	];

	for (const { label, run, expected } of missingPathCases) {
		const result = await captureConsole(run);
		assert.equal(result.exitCode, 1, label);
		assert.match(result.output, expected, label);
	}
});
