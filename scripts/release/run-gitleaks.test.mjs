import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	createScanArguments,
	GITLEAKS_CONFIG,
	GITLEAKS_CONFIG_SHA256,
	isolatedGitleaksEnvironment,
	sanitizeGitleaksReport,
} from "./run-gitleaks.mjs";

test("Gitleaks scan pins compiled defaults and disables ambient overrides", () => {
	assert.equal(
		createHash("sha256").update(GITLEAKS_CONFIG).digest("hex"),
		GITLEAKS_CONFIG_SHA256,
	);
	assert.match(GITLEAKS_CONFIG, /\[extend\]\nuseDefault = true/);
	const args = createScanArguments({
		configPath: "C:/temporary/pinned.toml",
		ignorePath: "C:/temporary/empty.ignore",
		reportPath: "C:/temporary/report.json",
		source: "C:/repository",
	});
	assert.ok(args.includes("--config=C:/temporary/pinned.toml"));
	assert.ok(args.includes("--gitleaks-ignore-path=C:/temporary/empty.ignore"));
	assert.equal(args.at(-1), "C:/repository");
	const environment = isolatedGitleaksEnvironment({
		GITLEAKS_CONFIG: "ambient-path",
		GITLEAKS_CONFIG_TOML: "ambient-content",
		PATH: "retained-path",
	});
	assert.deepEqual(environment, { PATH: "retained-path" });
});

test("Gitleaks evidence omits secret, identity, message, and repository paths", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "shots-gitleaks-test-"));
	try {
		const source = path.join(root, "raw.json");
		const destination = path.join(root, "sanitized.json");
		const sensitive = {
			secret: ["github", "pat", "A".repeat(24)].join("_"),
			author: "Unreviewed Fixture",
			email: ["unreviewed", "private.invalid"].join("@"),
			message: "Private commit message fixture",
			file: ".proton-import/private-document-id/page.html",
		};
		await writeFile(
			source,
			JSON.stringify([
				{
					RuleID: "generic-api-key",
					Commit: "a".repeat(40),
					StartLine: 4,
					EndLine: 5,
					Secret: sensitive.secret,
					Author: sensitive.author,
					Email: sensitive.email,
					Message: sensitive.message,
					File: sensitive.file,
				},
			]),
			"utf8",
		);

		await sanitizeGitleaksReport(source, destination);
		const output = await readFile(destination, "utf8");
		for (const value of Object.values(sensitive)) {
			assert.equal(output.includes(value), false);
		}
		assert.deepEqual(JSON.parse(output), [
			{
				RuleID: "generic-api-key",
				File: "redacted",
				Commit: "a".repeat(40),
				StartLine: 4,
				EndLine: 5,
			},
		]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
