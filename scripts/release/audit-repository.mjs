import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_POLICY = path.join(SCRIPT_DIR, "audit-policy.json");
const MAX_GREP_COMMITS = 24;

const CONTENT_RULES = [
	{
		id: "private-key",
		pattern: "-----BEGIN ([A-Z0-9 ]+ )?PRIVATE KEY-----",
		blocking: true,
	},
	{
		id: "github-token",
		pattern: "(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})",
		blocking: true,
	},
	{
		id: "provider-token",
		pattern:
			"(glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16})",
		blocking: true,
	},
	{
		id: "proton-document-url",
		pattern:
			"https?://docs\\.proton\\.me/u/[0-9]+/(document|doc|s)/[A-Za-z0-9_-]+",
		blocking: true,
	},
	{
		id: "proton-content-url",
		pattern: "protonusercontent\\.(com|ch)",
		blocking: true,
	},
	{
		id: "local-user-path",
		pattern: "(C:\\\\Users\\\\[^\\\\/[:space:]]+|/home/[^/[:space:]]+/)",
		blocking: true,
	},
	{
		id: "email-address-review",
		pattern: "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}",
		blocking: false,
	},
];

const PROHIBITED_PATH_RULES = [
	{ id: "raw-proton-import", pattern: /(^|\/)\.proton-import(\/|$)/i },
	{ id: "raw-vocal-import", pattern: /(^|\/)\.vocal-import(\/|$)/i },
	{ id: "environment-file", pattern: /(^|\/)\.env($|\.)/i },
	{
		id: "credential-file",
		pattern:
			/(^|\/)(credentials?|cookies?|id_rsa|id_ed25519)(\.|$)|\.(pem|key|p12|pfx|kdbx|sqlite|sqlite3)$/i,
	},
];

// Commit and annotated-tag messages are not part of any tree, so git grep
// cannot inspect them. Keep an independent, redacted metadata scan here.
const METADATA_MESSAGE_RULES = [
	{
		id: "private-key",
		pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/,
		blocking: true,
	},
	{
		id: "github-token",
		pattern: /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/,
		blocking: true,
	},
	{
		id: "provider-token",
		pattern:
			/(?:glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16})/,
		blocking: true,
	},
	{
		id: "proton-document-url",
		pattern:
			/https?:\/\/docs\.proton\.me\/u\/[0-9]+\/(?:document|doc|s)\/[A-Za-z0-9_-]+/,
		blocking: true,
	},
	{
		id: "proton-content-url",
		pattern: /protonusercontent\.(?:com|ch)/,
		blocking: true,
	},
	{
		id: "local-user-path",
		pattern: /(?:C:\\Users\\[^\\/\s]+|\/home\/[^/\s]+\/)/,
		blocking: true,
	},
];

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function runGit(args, options = {}) {
	const result = spawnSync("git", args, {
		cwd: options.cwd,
		encoding: "utf8",
		maxBuffer: options.maxBuffer ?? 128 * 1024 * 1024,
		input: options.input,
	});
	if (!options.allowNoMatch || ![0, 1].includes(result.status)) {
		if (result.status !== 0) {
			throw new Error(
				`git ${args[0]} failed (${result.status}): ${result.stderr.trim()}`,
			);
		}
	}
	return result.stdout;
}

function readGitBlob(cwd, object) {
	const result = spawnSync("git", ["cat-file", "blob", object], {
		cwd,
		encoding: null,
		maxBuffer: 128 * 1024 * 1024,
	});
	if (result.status !== 0) {
		throw new Error(
			`git cat-file failed (${result.status}): ${Buffer.from(
				result.stderr ?? [],
			)
				.toString("utf8")
				.trim()}`,
		);
	}
	return Buffer.from(result.stdout ?? []);
}

function readGitObjects(cwd, objectIds) {
	if (objectIds.length === 0) return new Map();
	const result = spawnSync("git", ["cat-file", "--batch"], {
		cwd,
		encoding: null,
		maxBuffer: 128 * 1024 * 1024,
		input: Buffer.from(`${objectIds.join("\n")}\n`, "ascii"),
	});
	if (result.status !== 0) {
		throw new Error(
			`git cat-file --batch failed (${result.status}): ${Buffer.from(
				result.stderr ?? [],
			)
				.toString("utf8")
				.trim()}`,
		);
	}

	const output = Buffer.from(result.stdout ?? []);
	const objects = new Map();
	let offset = 0;
	for (const requestedObject of objectIds) {
		const lineEnd = output.indexOf(0x0a, offset);
		if (lineEnd === -1) throw new Error("Malformed git cat-file batch header");
		const header = output.subarray(offset, lineEnd).toString("ascii");
		const match = header.match(/^([0-9a-f]+) ([a-z]+) ([0-9]+)$/);
		if (!match) throw new Error(`Unable to read Git object ${requestedObject}`);
		const [, object, type, sizeText] = match;
		const size = Number(sizeText);
		const contentStart = lineEnd + 1;
		const contentEnd = contentStart + size;
		if (contentEnd >= output.length || output[contentEnd] !== 0x0a) {
			throw new Error(`Malformed Git object payload for ${requestedObject}`);
		}
		objects.set(requestedObject, {
			object,
			type,
			content: output.subarray(contentStart, contentEnd),
		});
		offset = contentEnd + 1;
	}
	return objects;
}

function identityParts(header) {
	const match = header?.match(
		/^(?:author|committer|tagger) (.*) <([^<>]+)> [0-9]+ [+-][0-9]{4}$/,
	);
	return match ? { name: match[1], email: match[2] } : null;
}

function continuationHeaderValues(headers, name) {
	const values = [];
	for (let index = 0; index < headers.length; index += 1) {
		if (!headers[index].startsWith(`${name} `)) continue;
		const lines = [headers[index].slice(name.length + 1)];
		while (headers[index + 1]?.startsWith(" ")) {
			index += 1;
			lines.push(headers[index].slice(1));
		}
		values.push(lines.join("\n"));
	}
	return values;
}

function isGitHubNoreplyEmail(value) {
	const normalized = value.trim().toLowerCase();
	return (
		normalized === "noreply@github.com" ||
		normalized.endsWith("@users.noreply.github.com")
	);
}

function chunks(items, size) {
	const result = [];
	for (let offset = 0; offset < items.length; offset += size) {
		result.push(items.slice(offset, offset + size));
	}
	return result;
}

function parseArguments(argv) {
	const options = {
		cwd: process.cwd(),
		output: null,
		policy: DEFAULT_POLICY,
		gitleaksReport: null,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index];
		if (value === "--cwd") options.cwd = path.resolve(argv[++index]);
		else if (value === "--output") options.output = path.resolve(argv[++index]);
		else if (value === "--policy") options.policy = path.resolve(argv[++index]);
		else if (value === "--gitleaks-report")
			options.gitleaksReport = path.resolve(argv[++index]);
		else throw new Error(`Unknown argument: ${value}`);
	}
	return options;
}

function normalizeRepositoryPath(value) {
	return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isAllowed(cwd, policy, rule, repositoryPath, commit) {
	const allowed = policy.contentAllowlists?.[rule] ?? [];
	if (allowed.includes(normalizeRepositoryPath(repositoryPath))) return true;
	return (policy.contentAllowlistEntries ?? []).some((entry) => {
		const entryRules = Array.isArray(entry.rules) ? entry.rules : [entry.rule];
		if (
			!entryRules.includes(rule) ||
			normalizeRepositoryPath(entry.path) !==
				normalizeRepositoryPath(repositoryPath)
		) {
			return false;
		}
		if (entry.commit === commit) return true;
		if (typeof entry.blob !== "string") return false;
		const blob = runGit(
			["rev-parse", `${commit}:${normalizeRepositoryPath(repositoryPath)}`],
			{ cwd },
		).trim();
		return blob === entry.blob;
	});
}

function enumerateObjects(cwd) {
	const lines = runGit(["rev-list", "--objects", "--all"], { cwd })
		.split(/\r?\n/)
		.filter(Boolean);
	const pathsByObject = new Map();
	for (const line of lines) {
		const separator = line.indexOf(" ");
		const object = separator === -1 ? line : line.slice(0, separator);
		const repositoryPath =
			separator === -1
				? null
				: normalizeRepositoryPath(line.slice(separator + 1));
		if (!pathsByObject.has(object)) pathsByObject.set(object, new Set());
		if (repositoryPath) pathsByObject.get(object).add(repositoryPath);
	}

	const objectIds = [...pathsByObject.keys()];
	const metadata = runGit(
		["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
		{ cwd, input: `${objectIds.join("\n")}\n` },
	);
	const objects = [];
	for (const line of metadata.split(/\r?\n/).filter(Boolean)) {
		const [object, type, sizeText] = line.split(" ");
		if (type !== "blob") continue;
		objects.push({
			object,
			type,
			bytes: Number(sizeText),
			paths: [...(pathsByObject.get(object) ?? [])].sort(),
		});
	}
	return objects;
}

function enumerateHistoricalPaths(cwd) {
	const output = runGit(
		[
			"log",
			"--all",
			"--root",
			"--diff-merges=separate",
			"--pretty=format:",
			"--name-only",
			"-z",
			"--no-renames",
			"--diff-filter=ACDMRTUXB",
		],
		{ cwd, maxBuffer: 128 * 1024 * 1024 },
	);
	return new Set(
		output
			.split("\0")
			.map((entry) => normalizeRepositoryPath(entry.replace(/^[\r\n]+/, "")))
			.filter(Boolean),
	);
}

function scanPaths(repositoryPaths) {
	const findings = [];
	for (const repositoryPath of repositoryPaths) {
		for (const rule of PROHIBITED_PATH_RULES) {
			if (rule.pattern.test(repositoryPath)) {
				findings.push({
					type: "path",
					rule: rule.id,
					path: repositoryPath,
					blocking: true,
				});
			}
		}
	}
	return findings;
}

function scanContent(cwd, commits, policy) {
	const findings = new Map();
	for (const rule of CONTENT_RULES) {
		for (const commitChunk of chunks(commits, MAX_GREP_COMMITS)) {
			const output = runGit(
				["grep", "-I", "-l", "-E", "-e", rule.pattern, ...commitChunk, "--"],
				{ cwd, allowNoMatch: true },
			);
			for (const line of output.split(/\r?\n/).filter(Boolean)) {
				const separator = line.indexOf(":");
				const commit = line.slice(0, separator);
				const repositoryPath = normalizeRepositoryPath(
					line.slice(separator + 1),
				);
				if (isAllowed(cwd, policy, rule.id, repositoryPath, commit)) continue;
				const key = `${rule.id}\0${commit}\0${repositoryPath}`;
				findings.set(key, {
					type: "content",
					rule: rule.id,
					path: repositoryPath,
					commit,
					blocking: rule.blocking,
				});
			}
		}
	}
	return [...findings.values()];
}

async function parseGitleaksReport(file) {
	if (!file) return [];
	const report = JSON.parse(await readFile(file, "utf8"));
	if (!Array.isArray(report))
		throw new Error("Gitleaks report must be a JSON array");
	return report.map((finding) => ({
		type: "gitleaks",
		rule: finding.RuleID ?? finding.Description ?? "unclassified",
		path: normalizeRepositoryPath(finding.File ?? "unknown"),
		commit: finding.Commit ?? null,
		blocking: true,
	}));
}

function refs(cwd) {
	return runGit(
		[
			"for-each-ref",
			"--format=%(refname)%09%(objectname)%09%(objecttype)",
			"refs/heads",
			"refs/remotes",
			"refs/tags",
		],
		{ cwd },
	)
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => {
			const [name, object, type] = line.split("\t");
			return { name, object, type };
		});
}

function metadataPolicy(policy) {
	const entries = policy.gitMetadata?.allowedIdentityObjects ?? [];
	const allowedIdentityObjects = new Set();
	for (const entry of entries) {
		if (!/^[0-9a-f]{40}$/.test(entry.object ?? "")) {
			throw new Error(
				"Git metadata policy contains an invalid identity object",
			);
		}
		if (!["author", "committer", "tagger", "mergetag"].includes(entry.role)) {
			throw new Error("Git metadata policy contains an invalid identity role");
		}
		if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
			throw new Error("Git metadata identity exception requires a reason");
		}
		allowedIdentityObjects.add(`${entry.object}\0${entry.role}`);
	}
	const allowedMessageEmailObjects = new Set();
	for (const entry of policy.gitMetadata?.allowedMessageEmailObjects ?? []) {
		if (!/^[0-9a-f]{40}$/.test(entry.object ?? "")) {
			throw new Error(
				"Git metadata policy contains an invalid message-email object",
			);
		}
		if (
			!["commit-message", "tag-message", "mergetag-message"].includes(
				entry.location,
			)
		) {
			throw new Error(
				"Git metadata policy contains an invalid message-email location",
			);
		}
		if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
			throw new Error("Git metadata message-email exception requires a reason");
		}
		allowedMessageEmailObjects.add(`${entry.object}\0${entry.location}`);
	}
	const allowedSignedOffByObjects = new Set();
	for (const entry of policy.gitMetadata?.allowedSignedOffByObjects ?? []) {
		if (!/^[0-9a-f]{40}$/.test(entry.object ?? "")) {
			throw new Error(
				"Git metadata policy contains an invalid signed-off-by object",
			);
		}
		if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
			throw new Error("Git metadata signed-off-by exception requires a reason");
		}
		allowedSignedOffByObjects.add(entry.object);
	}
	const allowedPublicNames = new Set();
	for (const entry of policy.gitMetadata?.allowedPublicNames ?? []) {
		if (typeof entry.name !== "string" || entry.name.trim() === "") {
			throw new Error("Git metadata policy contains an invalid public name");
		}
		if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
			throw new Error("Git metadata public-name entry requires a reason");
		}
		allowedPublicNames.add(entry.name);
	}
	return {
		allowedIdentityObjects,
		allowedMessageEmailObjects,
		allowedSignedOffByObjects,
		allowedPublicNames,
		trustedUpstreamTips: policy.gitMetadata?.trustedUpstreamTips ?? [],
	};
}

function trustedUpstreamCommits(cwd, tips) {
	const commits = new Set();
	for (const entry of tips) {
		if (!/^[0-9a-f]{40}$/.test(entry.commit ?? "")) {
			throw new Error(
				"Git metadata policy contains an invalid upstream commit",
			);
		}
		if (typeof entry.reason !== "string" || entry.reason.trim() === "") {
			throw new Error("Trusted upstream metadata entry requires a reason");
		}
		for (const commit of runGit(["rev-list", entry.commit], { cwd })
			.split(/\r?\n/)
			.filter(Boolean)) {
			commits.add(commit);
		}
	}
	return commits;
}

function scanMessage(message, location) {
	const findings = [];
	for (const rule of METADATA_MESSAGE_RULES) {
		if (rule.pattern.test(message)) {
			findings.push({
				type: location.type,
				rule: `${location.kind}-message-${rule.id}`,
				path: location.path,
				commit: location.commit ?? null,
				blocking: rule.blocking,
			});
		}
	}
	return findings;
}

function scanRefMetadata(repositoryRefs) {
	const findings = [];
	for (const [index, ref] of repositoryRefs.entries()) {
		const location = {
			type: "ref-metadata",
			kind: "ref-name",
			path: `git-ref-${index + 1}`,
		};
		for (const finding of scanMessage(ref.name, location)) {
			findings.push({ ...finding, object: ref.object });
		}
		if (EMAIL_PATTERN.test(ref.name)) {
			findings.push({
				type: "ref-metadata",
				rule: "ref-name-email-review",
				path: location.path,
				object: ref.object,
				blocking: false,
			});
		}
		EMAIL_PATTERN.lastIndex = 0;
		for (const rule of PROHIBITED_PATH_RULES) {
			if (!rule.pattern.test(ref.name)) continue;
			findings.push({
				type: "ref-metadata",
				rule: `ref-name-${rule.id}`,
				path: location.path,
				object: ref.object,
				blocking: true,
			});
		}
	}
	return findings;
}

function redactedRefs(repositoryRefs) {
	return repositoryRefs.map((ref, index) => ({
		ordinal: index + 1,
		namespace: ref.name.startsWith("refs/heads/")
			? "head"
			: ref.name.startsWith("refs/tags/")
				? "tag"
				: ref.name.startsWith("refs/notes/")
					? "note"
					: ref.name.startsWith("refs/remotes/")
						? "remote"
						: "other",
		object: ref.object,
		type: ref.type,
	}));
}

function redactFindingPaths(findings) {
	const sensitiveTypes = new Set(["path", "content", "gitleaks"]);
	const paths = [
		...new Set(
			findings
				.filter((finding) => sensitiveTypes.has(finding.type))
				.map((finding) => finding.path),
		),
	].sort();
	const ordinals = new Map(
		paths.map((repositoryPath, index) => [repositoryPath, index + 1]),
	);
	return findings.map((finding) => {
		if (!sensitiveTypes.has(finding.type)) return finding;
		return {
			...finding,
			path: `repository-path-${ordinals.get(finding.path)}`,
		};
	});
}

function scanUnapprovedMessageEmails(
	message,
	location,
	trustedPublicMetadata = false,
) {
	if (trustedPublicMetadata) return [];
	for (const match of message.matchAll(EMAIL_PATTERN)) {
		if (isGitHubNoreplyEmail(match[0])) continue;
		return [
			{
				type: location.type,
				rule: `${location.kind}-message-email-review`,
				path: location.path,
				commit: location.commit ?? null,
				blocking: true,
			},
		];
	}
	return [];
}

function scanProjectSignedOffBy(message, location) {
	if (!/^Signed-off-by\s*:/imu.test(message)) return [];
	return [
		{
			type: location.type,
			rule: `${location.kind}-signed-off-by`,
			path: location.path,
			commit: location.commit ?? null,
			blocking: true,
		},
	];
}

function scanCommitMetadata(cwd, commits, policy) {
	const {
		allowedIdentityObjects,
		allowedMessageEmailObjects,
		allowedSignedOffByObjects,
		allowedPublicNames,
		trustedUpstreamTips,
	} = metadataPolicy(policy);
	const trustedCommits = trustedUpstreamCommits(cwd, trustedUpstreamTips);
	const objects = readGitObjects(cwd, commits);
	const findings = new Map();
	const upstreamEmails = new Set();
	const upstreamNames = new Set();
	const projectEmails = new Set();
	const projectNames = new Set();
	const approvedProjectEmails = new Set();
	const approvedProjectNames = new Set();
	let mergetagCount = 0;

	for (const commit of commits) {
		const object = objects.get(commit);
		if (object?.type !== "commit") {
			throw new Error(`Expected commit object for ${commit}`);
		}
		const content = object.content.toString("utf8");
		const separator = content.indexOf("\n\n");
		if (separator === -1) throw new Error(`Malformed commit object ${commit}`);
		const headers = content.slice(0, separator).split("\n");
		const message = content.slice(separator + 2);
		const identities = [
			[
				"author",
				identityParts(headers.find((line) => line.startsWith("author "))),
			],
			[
				"committer",
				identityParts(headers.find((line) => line.startsWith("committer "))),
			],
		];
		for (const [role, identity] of identities) {
			if (!identity)
				throw new Error(`Malformed ${role} identity in commit ${commit}`);
			const { name, email } = identity;
			if (trustedCommits.has(commit)) {
				upstreamEmails.add(email.trim().toLowerCase());
				upstreamNames.add(name);
				continue;
			}
			const normalizedEmail = email.trim().toLowerCase();
			projectEmails.add(normalizedEmail);
			projectNames.add(name);
			const identityObjectAllowed = allowedIdentityObjects.has(
				`${commit}\0${role}`,
			);
			if (isGitHubNoreplyEmail(email) || identityObjectAllowed) {
				approvedProjectEmails.add(normalizedEmail);
			} else {
				const key = `commit-${role}-email-review\0${commit}`;
				findings.set(key, {
					type: "commit-metadata",
					rule: `commit-${role}-email-review`,
					path: "commit-metadata",
					commit,
					blocking: true,
				});
			}
			if (allowedPublicNames.has(name) || identityObjectAllowed) {
				approvedProjectNames.add(name);
			} else {
				const key = `commit-${role}-name-review\0${commit}`;
				findings.set(key, {
					type: "commit-metadata",
					rule: `commit-${role}-name-review`,
					path: "commit-metadata",
					commit,
					blocking: true,
				});
			}
		}

		for (const mergetag of continuationHeaderValues(headers, "mergetag")) {
			mergetagCount += 1;
			const mergetagHeaders = mergetag.split("\n");
			const identity = identityParts(
				mergetagHeaders.find((line) => line.startsWith("tagger ")),
			);
			if (!identity) {
				throw new Error(`Malformed mergetag identity in commit ${commit}`);
			}
			if (!trustedCommits.has(commit)) {
				const identityObjectAllowed = allowedIdentityObjects.has(
					`${commit}\0mergetag`,
				);
				if (!isGitHubNoreplyEmail(identity.email) && !identityObjectAllowed) {
					findings.set(`commit-mergetag-email-review\0${commit}`, {
						type: "commit-metadata",
						rule: "commit-mergetag-email-review",
						path: "commit-mergetag",
						commit,
						blocking: true,
					});
				}
				if (!allowedPublicNames.has(identity.name) && !identityObjectAllowed) {
					findings.set(`commit-mergetag-name-review\0${commit}`, {
						type: "commit-metadata",
						rule: "commit-mergetag-name-review",
						path: "commit-mergetag",
						commit,
						blocking: true,
					});
				}
				const mergetagSeparator = mergetag.indexOf("\n\n");
				if (mergetagSeparator === -1) {
					throw new Error(`Malformed mergetag payload in commit ${commit}`);
				}
				const mergetagMessage = mergetag.slice(mergetagSeparator + 2);
				for (const finding of scanProjectSignedOffBy(mergetagMessage, {
					type: "commit-metadata",
					kind: "commit-mergetag",
					path: "commit-mergetag",
					commit,
				})) {
					findings.set(`${finding.rule}\0${commit}`, finding);
				}
				if (!allowedMessageEmailObjects.has(`${commit}\0mergetag-message`)) {
					for (const finding of scanUnapprovedMessageEmails(mergetagMessage, {
						type: "commit-metadata",
						kind: "commit-mergetag",
						path: "commit-mergetag",
						commit,
					})) {
						findings.set(`${finding.rule}\0${commit}`, finding);
					}
				}
			}
		}

		for (const finding of scanMessage(content, {
			type: "commit-metadata",
			kind: "commit",
			path: "commit-message",
			commit,
		})) {
			findings.set(`${finding.rule}\0${commit}`, finding);
		}
		if (
			!trustedCommits.has(commit) &&
			!allowedMessageEmailObjects.has(`${commit}\0commit-message`)
		) {
			for (const finding of scanUnapprovedMessageEmails(message, {
				type: "commit-metadata",
				kind: "commit",
				path: "commit-message",
				commit,
			})) {
				findings.set(`${finding.rule}\0${commit}`, finding);
			}
		}
		if (!trustedCommits.has(commit) && !allowedSignedOffByObjects.has(commit)) {
			for (const finding of scanProjectSignedOffBy(message, {
				type: "commit-metadata",
				kind: "commit",
				path: "commit-message",
				commit,
			})) {
				findings.set(`${finding.rule}\0${commit}`, finding);
			}
		}
	}

	return {
		findings: [...findings.values()],
		summary: {
			trustedUpstreamCommitCount: trustedCommits.size,
			trustedUpstreamIdentityCount: upstreamEmails.size,
			trustedUpstreamNameCount: upstreamNames.size,
			projectIdentityCount: projectEmails.size,
			projectNameCount: projectNames.size,
			approvedProjectIdentityCount: approvedProjectEmails.size,
			approvedProjectNameCount: approvedProjectNames.size,
			mergetagCount,
		},
	};
}

function scanAnnotatedTagMetadata(cwd, repositoryRefs, policy) {
	const {
		allowedIdentityObjects,
		allowedMessageEmailObjects,
		allowedPublicNames,
	} = metadataPolicy(policy);
	const tags = repositoryRefs.filter(
		(ref) => ref.name.startsWith("refs/tags/") && ref.type === "tag",
	);
	const objects = readGitObjects(
		cwd,
		tags.map((tag) => tag.object),
	);
	const findings = [];
	for (const tag of tags) {
		const object = objects.get(tag.object);
		if (object?.type !== "tag") {
			throw new Error(`Expected annotated tag object ${tag.object}`);
		}
		const content = object.content.toString("utf8");
		const separator = content.indexOf("\n\n");
		if (separator === -1)
			throw new Error(`Malformed annotated tag object ${tag.object}`);
		const headers = content.slice(0, separator).split("\n");
		const message = content.slice(separator + 2);
		const identity = identityParts(
			headers.find((line) => line.startsWith("tagger ")),
		);
		if (!identity)
			throw new Error(`Malformed tagger identity in tag object ${tag.object}`);
		const identityObjectAllowed = allowedIdentityObjects.has(
			`${tag.object}\0tagger`,
		);
		if (!isGitHubNoreplyEmail(identity.email) && !identityObjectAllowed) {
			findings.push({
				type: "tag-metadata",
				rule: "tagger-email-review",
				path: "annotated-tag",
				object: tag.object,
				blocking: true,
			});
		}
		if (!allowedPublicNames.has(identity.name) && !identityObjectAllowed) {
			findings.push({
				type: "tag-metadata",
				rule: "tagger-name-review",
				path: "annotated-tag",
				object: tag.object,
				blocking: true,
			});
		}
		for (const finding of [
			...scanMessage(content, {
				type: "tag-metadata",
				kind: "tag",
				path: "annotated-tag",
			}),
			...(allowedMessageEmailObjects.has(`${tag.object}\0tag-message`)
				? []
				: scanUnapprovedMessageEmails(message, {
						type: "tag-metadata",
						kind: "tag",
						path: "annotated-tag",
					})),
		]) {
			findings.push({ ...finding, object: tag.object });
		}
	}
	return findings;
}

export async function auditGitMetadata(options) {
	const cwd = path.resolve(options.cwd);
	const policy =
		typeof options.policy === "string"
			? JSON.parse(await readFile(options.policy, "utf8"))
			: options.policy;
	const includeRefMetadata = options.includeRefMetadata !== false;
	const repositoryRefs = includeRefMetadata ? refs(cwd) : [];
	const revisions = options.revisions ?? ["--all"];
	const commits = runGit(["rev-list", ...revisions], { cwd })
		.split(/\r?\n/)
		.filter(Boolean);
	const commitMetadata = scanCommitMetadata(cwd, commits, policy);
	const findings = [
		...(includeRefMetadata ? scanRefMetadata(repositoryRefs) : []),
		...commitMetadata.findings,
		...(includeRefMetadata
			? scanAnnotatedTagMetadata(cwd, repositoryRefs, policy)
			: []),
	].sort((left, right) =>
		`${left.rule}:${left.path}:${left.commit ?? ""}`.localeCompare(
			`${right.rule}:${right.path}:${right.commit ?? ""}`,
		),
	);
	return {
		repositoryRefs,
		commits,
		findings,
		summary: {
			...commitMetadata.summary,
			annotatedTagCount: repositoryRefs.filter(
				(ref) => ref.name.startsWith("refs/tags/") && ref.type === "tag",
			).length,
			lightweightTagCount: repositoryRefs.filter(
				(ref) => ref.name.startsWith("refs/tags/") && ref.type !== "tag",
			).length,
		},
	};
}

function validateAcceptedDisclosures(cwd, policy, objects) {
	const errors = [];
	for (const disclosure of policy.acceptedDisclosures ?? []) {
		const repositoryPath = normalizeRepositoryPath(disclosure.path);
		const treeEntry = runGit(["ls-tree", "HEAD", "--", repositoryPath], {
			cwd,
		}).trim();
		const [metadata, returnedPath] = treeEntry.split("\t");
		const [, type, objectId] = (metadata ?? "").split(" ");
		const match =
			type === "blob" &&
			normalizeRepositoryPath(returnedPath ?? "") === repositoryPath
				? objects.find((object) => object.object === objectId)
				: undefined;
		const sha256 = match
			? createHash("sha256")
					.update(readGitBlob(cwd, match.object))
					.digest("hex")
			: null;
		if (
			!match ||
			match.object !== disclosure.gitBlob ||
			match.bytes !== disclosure.bytes ||
			sha256 !== disclosure.sha256
		) {
			errors.push({
				type: "accepted-disclosure-drift",
				rule: "accepted-disclosure",
				path: disclosure.path,
				blocking: true,
			});
		}
	}
	return errors;
}

export async function auditRepository(options) {
	const cwd = path.resolve(options.cwd);
	const policy = JSON.parse(await readFile(options.policy, "utf8"));
	const worktreeStatus = runGit(
		["status", "--porcelain=v1", "--untracked-files=no"],
		{
			cwd,
		},
	).trim();
	const head = runGit(["rev-parse", "HEAD"], { cwd }).trim();
	const tree = runGit(["rev-parse", "HEAD^{tree}"], { cwd }).trim();
	const gitMetadataAudit = await auditGitMetadata({ cwd, policy });
	const { commits, repositoryRefs } = gitMetadataAudit;
	const objects = enumerateObjects(cwd);
	const historicalPaths = enumerateHistoricalPaths(cwd);
	const pathFindings = scanPaths(historicalPaths);
	const contentFindings = scanContent(cwd, commits, policy);
	const gitleaksFindings = await parseGitleaksReport(options.gitleaksReport);
	const disclosureFindings = validateAcceptedDisclosures(cwd, policy, objects);
	const findings = redactFindingPaths(
		[
			...pathFindings,
			...contentFindings,
			...gitMetadataAudit.findings,
			...gitleaksFindings,
			...disclosureFindings,
		].sort((left, right) =>
			`${left.rule}:${left.path}:${left.commit ?? ""}`.localeCompare(
				`${right.rule}:${right.path}:${right.commit ?? ""}`,
			),
		),
	);
	const acceptedDisclosurePaths = new Map(
		(policy.acceptedDisclosures ?? []).map((entry) => [
			entry.gitBlob,
			entry.path,
		]),
	);
	const largestBlobs = objects
		.toSorted((left, right) => right.bytes - left.bytes)
		.slice(0, 25)
		.map(({ paths, ...object }) => ({
			...object,
			pathCount: paths.length,
			acceptedDisclosurePath:
				acceptedDisclosurePaths.get(object.object) ?? null,
		}));
	const report = {
		version: 1,
		generatedAt: new Date().toISOString(),
		head,
		tree,
		worktreeClean: worktreeStatus.length === 0,
		refs: redactedRefs(repositoryRefs),
		commitCount: commits.length,
		blobCount: objects.length,
		historicalPathCount: historicalPaths.size,
		gitMetadata: {
			...gitMetadataAudit.summary,
		},
		largestBlobs,
		acceptedDisclosures: policy.acceptedDisclosures ?? [],
		findings,
		blockingFindings: findings.filter((finding) => finding.blocking).length,
		reviewFindings: findings.filter((finding) => !finding.blocking).length,
		policySha256: createHash("sha256")
			.update(JSON.stringify(policy))
			.digest("hex"),
	};
	if (options.output) {
		await writeFile(
			options.output,
			`${JSON.stringify(report, null, 2)}\n`,
			"utf8",
		);
	}
	return report;
}

async function main() {
	const options = parseArguments(process.argv.slice(2));
	const report = await auditRepository(options);
	console.log(
		`Audited ${report.refs.length} refs, ${report.commitCount} commits, and ${report.blobCount} blobs at ${report.head}.`,
	);
	console.log(
		`Privacy/security findings: ${report.blockingFindings} blocking, ${report.reviewFindings} requiring review.`,
	);
	for (const finding of report.findings) {
		console.log(
			`- ${finding.blocking ? "BLOCK" : "REVIEW"} ${finding.rule}: ${finding.path}${finding.commit ? ` at ${finding.commit}` : ""}`,
		);
	}
	if (!report.worktreeClean) {
		console.error(
			"Tracked worktree changes are present; this is not a final release audit.",
		);
		process.exitCode = 1;
	}
	if (report.blockingFindings > 0) process.exitCode = 1;
	if (report.reviewFindings > 0) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
