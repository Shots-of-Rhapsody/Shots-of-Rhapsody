import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	collectPresentationEvidence,
	verifyPresentationSignoffV2,
} from "../presentation.js";

function git(repoRoot, args) {
	const result = spawnSync("git", args, {
		cwd: repoRoot,
		encoding: "utf8",
		windowsHide: true,
	});
	assert.equal(result.status, 0, result.stderr);
}

test("presentation evidence binds renderer, built inventory, and commit ancestry", async () => {
	const repoRoot = await mkdtemp(path.join(os.tmpdir(), "shots-presentation-"));
	const distRoot = path.join(repoRoot, "dist");
	try {
		await mkdir(path.join(repoRoot, "src"), { recursive: true });
		await mkdir(path.join(repoRoot, "public"), { recursive: true });
		await mkdir(distRoot, { recursive: true });
		await writeFile(path.join(repoRoot, "src", "page.ts"), "export {};\n");
		await writeFile(path.join(repoRoot, "public", "mark.svg"), "<svg></svg>\n");
		await writeFile(path.join(distRoot, "index.html"), "<h1>Work</h1>\n");
		await writeFile(path.join(distRoot, "hero.webp"), "windows-encoded-image");
		git(repoRoot, ["init", "--quiet"]);
		git(repoRoot, ["add", "src", "public"]);
		git(repoRoot, [
			"-c",
			"user.name=Shots of Rhapsody",
			"-c",
			"user.email=shots@noreply.invalid",
			"commit",
			"--quiet",
			"-m",
			"fixture",
		]);

		const evidence = await collectPresentationEvidence({
			repoRoot,
			distRoot,
			release: "v1.1.0",
		});
		const ledger = {
			version: 2,
			releases: [
				{
					...evidence,
					reviewer: "Tai Song",
					reviewedAt: "2026-07-25T12:00:00.000Z",
					responsive: "passed",
					accessibility: "passed",
				},
			],
		};
		assert.deepEqual(
			await verifyPresentationSignoffV2({
				ledger,
				repoRoot,
				distRoot,
				release: "v1.1.0",
			}),
			evidence,
		);

		await writeFile(path.join(distRoot, "hero.webp"), "linux-encoded-image");
		assert.deepEqual(
			await verifyPresentationSignoffV2({
				ledger,
				repoRoot,
				distRoot,
				release: "v1.1.0",
			}),
			evidence,
		);

		await writeFile(path.join(distRoot, "unexpected.webp"), "extra-image");
		await assert.rejects(
			verifyPresentationSignoffV2({
				ledger,
				repoRoot,
				distRoot,
				release: "v1.1.0",
			}),
			/stale siteSha256/u,
		);

		await rm(path.join(distRoot, "unexpected.webp"));
		await writeFile(path.join(distRoot, "index.html"), "<h1>Changed</h1>\n");
		assert.deepEqual(
			await verifyPresentationSignoffV2({
				ledger,
				repoRoot,
				distRoot,
				release: "v1.1.0",
			}),
			evidence,
		);

		await writeFile(
			path.join(repoRoot, "src", "page.ts"),
			"export const changed = true;\n",
		);
		await assert.rejects(
			verifyPresentationSignoffV2({
				ledger,
				repoRoot,
				distRoot,
				release: "v1.1.0",
			}),
			/stale rendererSha256/u,
		);
	} finally {
		await rm(repoRoot, { recursive: true, force: true });
	}
});
