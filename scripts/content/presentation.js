import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { validatePresentationSignoffsV2 } from "./signoffs.js";

const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const RENDER_INPUTS = [
	"src",
	"public",
	"astro.config.mjs",
	"package.json",
	"pagefind.yml",
	"pnpm-lock.yaml",
	"pnpm-workspace.yaml",
	"provenance/publication-catalog.json",
	"tsconfig.json",
];

function sha256Entries(entries) {
	const hash = createHash("sha256");
	for (const entry of entries) {
		const name = Buffer.from(entry.path.replaceAll("\\", "/"), "utf8");
		hash.update(String(name.byteLength));
		hash.update("\0");
		hash.update(name);
		hash.update("\0");
		hash.update(String(entry.bytes.byteLength));
		hash.update("\0");
		hash.update(entry.bytes);
		hash.update("\0");
	}
	return `sha256:${hash.digest("hex")}`;
}

async function readRegularFiles(root, relativePaths) {
	const entries = [];
	for (const relativePath of [...relativePaths].sort()) {
		const absolutePath = path.join(root, ...relativePath.split("/"));
		const metadata = await lstat(absolutePath);
		if (!metadata.isFile())
			throw new Error(
				`Presentation evidence rejects non-file input: ${relativePath}`,
			);
		entries.push({ path: relativePath, bytes: await readFile(absolutePath) });
	}
	return entries;
}

function listRendererPaths(repoRoot) {
	const result = spawnSync(
		"git",
		[
			"ls-files",
			"-z",
			"--cached",
			"--others",
			"--exclude-standard",
			"--",
			...RENDER_INPUTS,
		],
		{
			cwd: repoRoot,
			encoding: "utf8",
			maxBuffer: 10 * 1024 * 1024,
			windowsHide: true,
		},
	);
	if (result.status !== 0)
		throw new Error("Presentation renderer inputs could not be enumerated");
	return result.stdout
		.split("\0")
		.filter(Boolean)
		.map((file) => file.replaceAll("\\", "/"))
		.sort();
}

async function walkFiles(root, directory = root) {
	const results = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const absolutePath = path.join(directory, entry.name);
		if (entry.isSymbolicLink())
			throw new Error("Presentation site evidence rejects symbolic links");
		if (entry.isDirectory())
			results.push(...(await walkFiles(root, absolutePath)));
		else if (entry.isFile())
			results.push(path.relative(root, absolutePath).replaceAll("\\", "/"));
	}
	return results.sort();
}

function resolveCommit(repoRoot, revision) {
	const result = spawnSync(
		"git",
		[
			"rev-parse",
			"--verify",
			"--quiet",
			"--end-of-options",
			`${revision}^{commit}`,
		],
		{ cwd: repoRoot, encoding: "utf8", windowsHide: true },
	);
	const commit = result.stdout?.trim();
	return result.status === 0 && COMMIT_PATTERN.test(commit) ? commit : null;
}

export async function collectPresentationEvidence({
	repoRoot,
	distRoot = path.join(repoRoot, "dist"),
	release,
}) {
	const reviewedCommit = resolveCommit(repoRoot, "HEAD");
	if (!reviewedCommit)
		throw new Error("Presentation evidence requires a valid Git HEAD commit");
	const rendererPaths = listRendererPaths(repoRoot);
	const sitePaths = await walkFiles(distRoot);
	if (rendererPaths.length === 0 || sitePaths.length === 0)
		throw new Error("Presentation evidence cannot hash an empty input set");
	return {
		release,
		reviewedCommit,
		rendererSha256: sha256Entries(
			await readRegularFiles(repoRoot, rendererPaths),
		),
		siteSha256: sha256Entries(await readRegularFiles(distRoot, sitePaths)),
	};
}

export async function verifyPresentationSignoffV2({
	ledger,
	repoRoot,
	distRoot = path.join(repoRoot, "dist"),
	release,
}) {
	const evidence = await collectPresentationEvidence({
		repoRoot,
		distRoot,
		release,
	});
	const records = validatePresentationSignoffsV2(ledger);
	const record = records.find((candidate) => candidate.release === release);
	if (!record)
		throw new Error(`Presentation signoff is missing for ${release}`);
	for (const field of ["rendererSha256", "siteSha256"]) {
		if (record[field] !== evidence[field])
			throw new Error(`Presentation signoff has stale ${field}`);
	}
	const reviewedCommit = resolveCommit(repoRoot, record.reviewedCommit);
	if (!reviewedCommit)
		throw new Error("Presentation reviewed commit does not exist");
	const ancestry = spawnSync(
		"git",
		["merge-base", "--is-ancestor", reviewedCommit, evidence.reviewedCommit],
		{ cwd: repoRoot, encoding: "utf8", windowsHide: true },
	);
	if (ancestry.status === 1)
		throw new Error("Presentation reviewed commit is not a release ancestor");
	if (ancestry.status !== 0)
		throw new Error("Presentation review ancestry could not be verified");
	return { ...evidence, reviewedCommit: record.reviewedCommit };
}
