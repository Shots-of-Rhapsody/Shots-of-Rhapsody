import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { auditGitMetadata, auditRepository } from "./audit-repository.mjs";

const scriptPath = fileURLToPath(
	new URL("./audit-repository.mjs", import.meta.url),
);
const identityScriptPath = fileURLToPath(
	new URL("./verify-git-identity.mjs", import.meta.url),
);
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

function git(cwd, args) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr || result.stdout);
	return result.stdout.trim();
}

function gitInput(cwd, args, input) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", input });
	assert.equal(result.status, 0, result.stderr || result.stdout);
	return result.stdout.trim();
}

test("identity policy audits an explicit maintained tip instead of a synthetic merge", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "shots-identity-test-"));
	try {
		const repository = path.join(root, "repository");
		git(root, ["clone", "--shared", repositoryRoot, repository]);
		const maintainedTip =
			process.env.PROJECT_HISTORY_TIP ?? git(repository, ["rev-parse", "HEAD"]);
		git(repository, ["checkout", "--detach", maintainedTip]);
		git(repository, ["config", "user.name", "Shots of Rhapsody"]);
		git(repository, [
			"config",
			"user.email",
			["shots-of-rhapsody", "users.noreply.github.com"].join("@"),
		]);
		await writeFile(
			path.join(repository, "synthetic-merge.txt"),
			"merge\n",
			"utf8",
		);
		git(repository, ["add", "synthetic-merge.txt"]);
		git(repository, [
			"-c",
			"user.name=Unreviewed Identity",
			"-c",
			`user.email=${["synthetic-merge", "users.noreply.github.com"].join("@")}`,
			"commit",
			"-m",
			"Create synthetic merge fixture",
		]);

		const maintained = spawnSync(
			process.execPath,
			[identityScriptPath, maintainedTip],
			{ cwd: repository, encoding: "utf8" },
		);
		assert.equal(maintained.status, 0, maintained.stderr || maintained.stdout);

		const syntheticHead = spawnSync(process.execPath, [identityScriptPath], {
			cwd: repository,
			encoding: "utf8",
		});
		assert.equal(syntheticHead.status, 1);
		assert.match(syntheticHead.stdout, /[1-9]\d* blocking/u);

		const malformed = spawnSync(
			process.execPath,
			[identityScriptPath, "not-a-commit"],
			{ cwd: repository, encoding: "utf8" },
		);
		assert.equal(malformed.status, 2);
		assert.match(malformed.stderr, /Usage:/u);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

async function writePolicy(
	file,
	acceptedDisclosure,
	allowedEmailBlob,
	allowedIdentityObjects = [],
	trustedUpstreamTips = [],
	allowedMessageEmailObjects = [],
	allowedSignedOffByObjects = [],
) {
	await writeFile(
		file,
		`${JSON.stringify(
			{
				version: 1,
				gitMetadata: {
					trustedUpstreamTips,
					allowedPublicNames: [
						{
							name: "Release Test",
							reason: "Synthetic public test identity.",
						},
					],
					allowedIdentityObjects,
					allowedMessageEmailObjects,
					allowedSignedOffByObjects,
				},
				contentAllowlists: {},
				contentAllowlistEntries: allowedEmailBlob
					? [
							{
								rule: "email-address-review",
								path: "contact.txt",
								blob: allowedEmailBlob,
								reason: "Synthetic public metadata fixture.",
							},
						]
					: [],
				acceptedDisclosures: acceptedDisclosure ? [acceptedDisclosure] : [],
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
}

test("repository audit binds an accepted renamed blob to its current path, bytes, and SHA-256", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "shots-audit-test-"));
	try {
		const repository = path.join(root, "repository");
		await mkdir(repository);
		git(repository, ["init", "--initial-branch=main"]);
		git(repository, ["config", "user.name", "Release Test"]);
		const publicEmail = ["123+release-test", "users.noreply.github.com"].join(
			"@",
		);
		git(repository, ["config", "user.email", publicEmail]);

		const bytes = Buffer.from([0, 1, 2, 3, 254, 255]);
		await writeFile(path.join(repository, "podcast.bin"), bytes);
		await writeFile(
			path.join(repository, "contact.txt"),
			`Public package metadata: ${["maintainer", "example.invalid"].join("@")}\n`,
		);
		git(repository, ["add", "--all"]);
		git(repository, ["commit", "-m", "Add fixtures"]);
		await mkdir(path.join(repository, "legacy"));
		git(repository, ["mv", "podcast.bin", "legacy/podcast.bin"]);
		git(repository, ["commit", "-m", "Move accepted asset"]);

		const gitBlob = git(repository, ["rev-parse", "HEAD:legacy/podcast.bin"]);
		const acceptedDisclosure = {
			path: "legacy/podcast.bin",
			gitBlob,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			bytes: bytes.length,
			reason: "Synthetic accepted binary fixture.",
		};
		const contactBlob = git(repository, ["rev-parse", "HEAD:contact.txt"]);
		const policy = path.join(root, "policy.json");
		await writePolicy(policy, acceptedDisclosure, contactBlob);
		const report = await auditRepository({
			cwd: repository,
			policy,
			gitleaksReport: null,
			output: null,
		});
		assert.equal(report.blockingFindings, 0);
		assert.equal(report.reviewFindings, 0);
		assert.equal(report.worktreeClean, true);

		await writePolicy(
			policy,
			{ ...acceptedDisclosure, sha256: "0".repeat(64) },
			contactBlob,
		);
		const drift = await auditRepository({
			cwd: repository,
			policy,
			gitleaksReport: null,
			output: null,
		});
		assert.equal(drift.blockingFindings, 1);

		await writePolicy(policy, acceptedDisclosure, null);
		const cli = spawnSync(
			process.execPath,
			[scriptPath, "--cwd", repository, "--policy", policy],
			{ encoding: "utf8" },
		);
		assert.equal(cli.status, 1, cli.stderr || cli.stdout);
		assert.match(cli.stdout, /requiring review/);

		await writeFile(path.join(repository, ".env"), "SYNTHETIC=true\n");
		git(repository, ["add", ".env"]);
		git(repository, ["commit", "-m", "Add prohibited path fixture"]);
		git(repository, ["mv", ".env", "public-config.txt"]);
		git(repository, ["commit", "-m", "Rename prohibited path fixture"]);
		await writePolicy(policy, acceptedDisclosure, contactBlob);
		const renamedPath = await auditRepository({
			cwd: repository,
			policy,
			gitleaksReport: null,
			output: null,
		});
		assert.ok(
			renamedPath.findings.some(
				(finding) => finding.rule === "environment-file",
			),
			"a prohibited historical path must survive a later rename",
		);
		assert.equal(JSON.stringify(renamedPath).includes(".env"), false);

		git(repository, ["checkout", "-b", "merge-fixture"]);
		await writeFile(path.join(repository, "branch.txt"), "branch\n");
		git(repository, ["add", "branch.txt"]);
		git(repository, ["commit", "-m", "Add merge branch fixture"]);
		git(repository, ["checkout", "main"]);
		await writeFile(path.join(repository, "main.txt"), "main\n");
		git(repository, ["add", "main.txt"]);
		git(repository, ["commit", "-m", "Advance main fixture"]);
		git(repository, ["merge", "--no-commit", "merge-fixture"]);
		await mkdir(path.join(repository, ".proton-import"));
		await writeFile(
			path.join(repository, ".proton-import", "raw.html"),
			"synthetic merge-only path\n",
		);
		git(repository, ["add", "--all"]);
		git(repository, ["commit", "-m", "Add merge-resolution fixture"]);
		const mergeResolution = await auditRepository({
			cwd: repository,
			policy,
			gitleaksReport: null,
			output: null,
		});
		assert.ok(
			mergeResolution.findings.some(
				(finding) => finding.rule === "raw-proton-import",
			),
			"a prohibited path introduced by merge resolution must be scanned",
		);
		assert.equal(
			JSON.stringify(mergeResolution).includes(".proton-import/raw.html"),
			false,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("repository audit redacts and exact-scopes unreviewed Git identities", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "shots-metadata-test-"));
	try {
		const repository = path.join(root, "repository");
		await mkdir(repository);
		git(repository, ["init", "--initial-branch=main"]);
		git(repository, ["config", "user.name", "Release Test"]);
		git(repository, [
			"config",
			"user.email",
			["123+release-test", "users.noreply.github.com"].join("@"),
		]);
		await writeFile(path.join(repository, "baseline.txt"), "baseline\n");
		git(repository, ["add", "baseline.txt"]);
		git(repository, ["commit", "-m", "Add baseline"]);

		const privateName = ["Unreviewed", "Fixture"].join(" ");
		const privateEmail = ["unreviewed", "private.invalid"].join("@");
		git(repository, ["config", "user.name", privateName]);
		git(repository, ["config", "user.email", privateEmail]);
		await writeFile(path.join(repository, "change.txt"), "change\n");
		git(repository, ["add", "change.txt"]);
		git(repository, ["commit", "-m", "Add identity fixture"]);
		const identityCommit = git(repository, ["rev-parse", "HEAD"]);
		git(repository, ["tag", "-a", "identity-tag", "-m", "Identity tag"]);
		const identityTag = git(repository, ["rev-parse", "identity-tag^{tag}"]);
		const policy = path.join(root, "policy.json");
		await writePolicy(policy, null, null);

		const review = await auditRepository({
			cwd: repository,
			policy,
			gitleaksReport: null,
			output: null,
		});
		assert.ok(
			review.findings.some(
				(finding) =>
					finding.commit === identityCommit &&
					finding.rule === "commit-author-email-review" &&
					finding.blocking,
			),
		);
		assert.ok(
			review.findings.some((finding) => finding.rule === "tagger-email-review"),
		);
		assert.ok(
			review.findings.some((finding) => finding.rule === "tagger-name-review"),
		);
		assert.ok(
			review.findings.some(
				(finding) =>
					finding.commit === identityCommit &&
					finding.rule === "commit-author-name-review",
			),
		);
		const serialized = JSON.stringify(review);
		assert.equal(serialized.includes(privateName), false);
		assert.equal(serialized.includes(privateEmail), false);
		const metadataOnly = await auditGitMetadata({
			cwd: repository,
			policy,
			revisions: ["HEAD"],
			includeRefMetadata: false,
		});
		assert.ok(
			metadataOnly.findings.some(
				(finding) =>
					finding.commit === identityCommit &&
					finding.rule === "commit-author-email-review" &&
					finding.blocking,
			),
			"the fast CI policy must enforce the same project identity boundary",
		);

		await writePolicy(policy, null, null, [
			{
				object: identityCommit,
				role: "author",
				reason: "Exact synthetic author identity review.",
			},
			{
				object: identityCommit,
				role: "committer",
				reason: "Exact synthetic committer identity review.",
			},
			{
				object: identityTag,
				role: "tagger",
				reason: "Exact synthetic tagger identity review.",
			},
		]);
		const approved = await auditRepository({
			cwd: repository,
			policy,
			gitleaksReport: null,
			output: null,
		});
		assert.equal(approved.blockingFindings, 0);
		assert.equal(approved.reviewFindings, 0);

		await writeFile(path.join(repository, "nearby.txt"), "nearby\n");
		git(repository, ["add", "nearby.txt"]);
		git(repository, ["commit", "-m", "Add nearby identity fixture"]);
		const nearby = await auditRepository({
			cwd: repository,
			policy,
			gitleaksReport: null,
			output: null,
		});
		assert.ok(
			nearby.findings.some(
				(finding) =>
					finding.commit === git(repository, ["rev-parse", "HEAD"]) &&
					finding.rule === "commit-author-email-review",
			),
			"an exact identity exception must not approve a later commit",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("repository audit scans redacted commit and annotated-tag messages", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "shots-message-test-"));
	try {
		const repository = path.join(root, "repository");
		await mkdir(repository);
		git(repository, ["init", "--initial-branch=main"]);
		git(repository, ["config", "user.name", "Release Test"]);
		const publicEmail = ["123+release-test", "users.noreply.github.com"].join(
			"@",
		);
		git(repository, ["config", "user.email", publicEmail]);
		await writeFile(path.join(repository, "fixture.txt"), "fixture\n");
		git(repository, ["add", "fixture.txt"]);
		const secret = ["github", "pat", "A".repeat(24)].join("_");
		const messageEmail = ["reviewer", "private.invalid"].join("@");
		git(repository, [
			"commit",
			"-m",
			`Synthetic ${secret}`,
			"-m",
			`Reviewed-by: ${messageEmail}\n\nSigned-off-by: Release Test <${publicEmail}>`,
		]);
		const upstreamTip = git(repository, ["rev-parse", "HEAD"]);
		await writeFile(path.join(repository, "project.txt"), "project\n");
		git(repository, ["add", "project.txt"]);
		git(repository, [
			"commit",
			"-m",
			"Add project fixture",
			"-m",
			`Signed-off-by: Release Fixture <${messageEmail}>`,
		]);
		const projectCommit = git(repository, ["rev-parse", "HEAD"]);
		await writeFile(
			path.join(repository, "project-noreply.txt"),
			"project noreply\n",
		);
		git(repository, ["add", "project-noreply.txt"]);
		git(repository, [
			"commit",
			"-m",
			"Add noreply trailer fixture",
			"-m",
			`Signed-off-by: Release Test <${publicEmail}>`,
		]);
		const noreplySignedOffCommit = git(repository, ["rev-parse", "HEAD"]);
		const protonUrl = [
			"https://docs.proton.me/u/1/document",
			"synthetic-document-id",
		].join("/");
		git(repository, [
			"tag",
			"-a",
			"v-test",
			"-m",
			protonUrl,
			"-m",
			`Reviewed-by: ${messageEmail}`,
		]);
		const annotatedTag = git(repository, ["rev-parse", "v-test^{tag}"]);
		git(repository, ["tag", "lightweight-test"]);
		const sensitiveRef = ["privacy", "credentials.json"].join("/");
		const emailRef = `review-${messageEmail}`;
		git(repository, ["branch", sensitiveRef]);
		git(repository, ["branch", emailRef]);
		const policy = path.join(root, "policy.json");
		await writePolicy(
			policy,
			null,
			null,
			[],
			[
				{
					commit: upstreamTip,
					reason: "Synthetic trusted upstream ancestry.",
				},
			],
		);

		const report = await auditRepository({
			cwd: repository,
			policy,
			gitleaksReport: null,
			output: null,
		});
		assert.ok(
			report.findings.some(
				(finding) => finding.rule === "commit-message-github-token",
			),
			"trusted upstream identity metadata must not suppress secret-like messages",
		);
		assert.ok(
			report.findings.some(
				(finding) => finding.rule === "tag-message-proton-document-url",
			),
		);
		assert.ok(
			report.findings.some(
				(finding) =>
					finding.rule === "commit-message-email-review" &&
					finding.commit === projectCommit &&
					finding.blocking,
			),
		);
		assert.ok(
			report.findings.some(
				(finding) =>
					finding.rule === "commit-signed-off-by" &&
					finding.commit === projectCommit &&
					finding.blocking,
			),
		);
		assert.ok(
			report.findings.some(
				(finding) =>
					finding.rule === "commit-signed-off-by" &&
					finding.commit === noreplySignedOffCommit &&
					finding.blocking,
			),
			"noreply addresses must not make project Signed-off-by trailers acceptable",
		);
		assert.equal(
			report.findings.some(
				(finding) =>
					finding.rule === "commit-signed-off-by" &&
					finding.commit === upstreamTip,
			),
			false,
			"the exact reviewed upstream ancestry must remain exempt",
		);
		assert.ok(
			report.findings.some(
				(finding) =>
					finding.rule === "tag-message-email-review" &&
					finding.object === annotatedTag,
			),
		);
		assert.ok(
			report.findings.some(
				(finding) => finding.rule === "ref-name-credential-file",
			),
		);
		assert.ok(
			report.findings.some(
				(finding) => finding.rule === "ref-name-email-review",
			),
		);
		assert.equal(report.gitMetadata.annotatedTagCount, 1);
		assert.equal(report.gitMetadata.lightweightTagCount, 1);
		const serialized = JSON.stringify(report);
		assert.equal(serialized.includes(secret), false);
		assert.equal(serialized.includes(messageEmail), false);
		assert.equal(serialized.includes(protonUrl), false);
		assert.equal(serialized.includes(sensitiveRef), false);
		assert.equal(serialized.includes(emailRef), false);

		await writePolicy(
			policy,
			null,
			null,
			[],
			[
				{
					commit: upstreamTip,
					reason: "Synthetic trusted upstream ancestry.",
				},
			],
			[
				{
					object: projectCommit,
					location: "commit-message",
					reason: "Exact synthetic commit-message email review.",
				},
				{
					object: annotatedTag,
					location: "tag-message",
					reason: "Exact synthetic tag-message email review.",
				},
			],
		);
		const approvedMessages = await auditRepository({
			cwd: repository,
			policy,
			gitleaksReport: null,
			output: null,
		});
		assert.equal(
			approvedMessages.findings.some(
				(finding) =>
					finding.rule === "commit-message-email-review" &&
					finding.commit === projectCommit,
			),
			false,
		);
		assert.ok(
			approvedMessages.findings.some(
				(finding) =>
					finding.rule === "commit-signed-off-by" &&
					finding.commit === projectCommit,
			),
			"an exact message-email exception must not approve a project Signed-off-by trailer",
		);

		await writePolicy(
			policy,
			null,
			null,
			[],
			[
				{
					commit: upstreamTip,
					reason: "Synthetic trusted upstream ancestry.",
				},
			],
			[
				{
					object: projectCommit,
					location: "commit-message",
					reason: "Exact synthetic commit-message email review.",
				},
			],
			[
				{
					object: projectCommit,
					reason: "Exact synthetic provider signed-off-by review.",
				},
			],
		);
		const approvedSignedOffBy = await auditRepository({
			cwd: repository,
			policy,
			gitleaksReport: null,
			output: null,
		});
		assert.equal(
			approvedSignedOffBy.findings.some(
				(finding) =>
					finding.rule === "commit-signed-off-by" &&
					finding.commit === projectCommit,
			),
			false,
		);
		assert.ok(
			approvedSignedOffBy.findings.some(
				(finding) =>
					finding.rule === "commit-signed-off-by" &&
					finding.commit === noreplySignedOffCommit,
			),
			"a signed-off-by exception must remain bound to its exact commit",
		);
		assert.ok(
			approvedSignedOffBy.findings.some(
				(finding) => finding.rule === "commit-message-github-token",
			),
			"signed-off-by exceptions must never suppress secret-like findings",
		);
		assert.equal(
			approvedMessages.findings.some(
				(finding) =>
					finding.rule === "tag-message-email-review" &&
					finding.object === annotatedTag,
			),
			false,
		);
		assert.ok(
			approvedMessages.findings.some(
				(finding) => finding.rule === "commit-message-github-token",
			),
			"message-email exceptions must never suppress secret-like findings",
		);
		assert.ok(
			approvedMessages.findings.some(
				(finding) => finding.rule === "tag-message-proton-document-url",
			),
			"message-email exceptions must never suppress private URL findings",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("repository audit reviews embedded mergetags and fails closed on malformed identities", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "shots-mergetag-test-"));
	try {
		const repository = path.join(root, "repository");
		await mkdir(repository);
		git(repository, ["init", "--initial-branch=main"]);
		git(repository, ["config", "user.name", "Release Test"]);
		git(repository, [
			"config",
			"user.email",
			["123+release-test", "users.noreply.github.com"].join("@"),
		]);
		await writeFile(path.join(repository, "fixture.txt"), "fixture\n");
		git(repository, ["add", "fixture.txt"]);
		git(repository, ["commit", "-m", "Add fixture"]);
		const parent = git(repository, ["rev-parse", "HEAD"]);
		const tree = git(repository, ["rev-parse", "HEAD^{tree}"]);
		const privateName = ["Embedded", "Fixture"].join(" ");
		const privateEmail = ["embedded", "private.invalid"].join("@");
		const messageEmail = ["mergetag-review", "private.invalid"].join("@");
		const secret = ["github", "pat", "B".repeat(24)].join("_");
		const tagPayload = [
			`object ${parent}`,
			"type commit",
			"tag embedded-test",
			`tagger ${privateName} <${privateEmail}> 1700000000 +0000`,
			"",
			`Embedded ${secret}`,
			`Reviewed-by: ${messageEmail}`,
		].join("\n");
		const mergetagHeader = tagPayload
			.split("\n")
			.map((line, index) => (index === 0 ? `mergetag ${line}` : ` ${line}`))
			.join("\n");
		const publicEmail = ["123+release-test", "users.noreply.github.com"].join(
			"@",
		);
		const commitPayload = [
			`tree ${tree}`,
			`parent ${parent}`,
			`author Release Test <${publicEmail}> 1700000001 +0000`,
			`committer Release Test <${publicEmail}> 1700000001 +0000`,
			mergetagHeader,
			"",
			"Merge embedded tag fixture",
			"",
		].join("\n");
		const mergetagCommit = gitInput(
			repository,
			["hash-object", "-t", "commit", "-w", "--stdin"],
			commitPayload,
		);
		git(repository, ["update-ref", "refs/heads/mergetag-test", mergetagCommit]);
		const policy = path.join(root, "policy.json");
		await writePolicy(policy, null, null);

		const report = await auditRepository({
			cwd: repository,
			policy,
			gitleaksReport: null,
			output: null,
		});
		assert.ok(
			report.findings.some(
				(finding) => finding.rule === "commit-mergetag-email-review",
			),
		);
		assert.ok(
			report.findings.some(
				(finding) => finding.rule === "commit-mergetag-name-review",
			),
		);
		assert.ok(
			report.findings.some(
				(finding) => finding.rule === "commit-message-github-token",
			),
		);
		assert.ok(
			report.findings.some(
				(finding) => finding.rule === "commit-mergetag-message-email-review",
			),
		);
		const serialized = JSON.stringify(report);
		assert.equal(serialized.includes(privateName), false);
		assert.equal(serialized.includes(privateEmail), false);
		assert.equal(serialized.includes(messageEmail), false);
		assert.equal(serialized.includes(secret), false);

		await writePolicy(
			policy,
			null,
			null,
			[],
			[],
			[
				{
					object: mergetagCommit,
					location: "mergetag-message",
					reason: "Exact synthetic embedded-tag message email review.",
				},
			],
		);
		const approvedMessage = await auditRepository({
			cwd: repository,
			policy,
			gitleaksReport: null,
			output: null,
		});
		assert.equal(
			approvedMessage.findings.some(
				(finding) => finding.rule === "commit-mergetag-message-email-review",
			),
			false,
		);
		assert.ok(
			approvedMessage.findings.some(
				(finding) => finding.rule === "commit-mergetag-email-review",
			),
			"message approval must not approve the embedded tagger identity",
		);
		assert.ok(
			approvedMessage.findings.some(
				(finding) => finding.rule === "commit-message-github-token",
			),
			"message-email approval must not suppress secret-like content",
		);

		const malformedPayload = [
			`tree ${tree}`,
			`parent ${parent}`,
			"author Malformed Identity 1700000002 +0000",
			`committer Release Test <${publicEmail}> 1700000002 +0000`,
			"",
			"Malformed identity fixture",
			"",
		].join("\n");
		const malformedCommit = gitInput(
			repository,
			["hash-object", "--literally", "-t", "commit", "-w", "--stdin"],
			malformedPayload,
		);
		git(repository, [
			"update-ref",
			"refs/heads/malformed-test",
			malformedCommit,
		]);
		await assert.rejects(
			auditRepository({
				cwd: repository,
				policy,
				gitleaksReport: null,
				output: null,
			}),
			/Malformed author identity/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
