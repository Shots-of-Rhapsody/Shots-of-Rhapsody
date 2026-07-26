import path from "node:path";
import { fileURLToPath } from "node:url";

export const INVENTORY_SCHEMA_VERSION = 1;
export const MANIFEST_SCHEMA_VERSION = 1;
export const SNAPSHOT_SCHEMA_VERSION = 1;
export const AUTHORITY_PLATFORM = "Medium";
export const CAPTURE_FORMAT = "account-export-zip";
export const AUTHOR_NAME = "Tai Song";
export const AUTHOR_PROFILE_URL = "https://medium.com/@ShotsOfRhapsody";
export const ALL_RIGHTS_RESERVED = "All Rights Reserved";

export const DEFAULT_REPO_ROOT = fileURLToPath(
	new URL("../../../", import.meta.url),
);

export class MediumContractError extends Error {
	constructor(message, options = {}) {
		super(message, options);
		this.name = "MediumContractError";
	}
}

export function isPlainObject(value) {
	if (value === null || typeof value !== "object") return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

export function assertPlainObject(value, label) {
	if (!isPlainObject(value)) {
		throw new MediumContractError(`${label} must be a JSON object`);
	}
	return value;
}

export function assertOnlyKeys(value, allowed, label) {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) {
			throw new MediumContractError(
				`${label} contains unsupported key ${JSON.stringify(key)}`,
			);
		}
	}
}

export function assertString(value, label) {
	if (typeof value !== "string" || value.includes("\0")) {
		throw new MediumContractError(
			`${label} must be a string without NUL characters`,
		);
	}
	return value;
}

export function assertNonEmptyString(value, label) {
	assertString(value, label);
	if (value.length === 0) {
		throw new MediumContractError(`${label} must be a non-empty string`);
	}
	return value;
}

export function assertNullableString(value, label) {
	if (value === null) return null;
	return assertString(value, label);
}

export function assertInteger(value, label, { positive = false } = {}) {
	if (!Number.isSafeInteger(value) || value < 0 || (positive && value === 0)) {
		throw new MediumContractError(
			`${label} must be a ${positive ? "positive" : "non-negative"} safe integer`,
		);
	}
	return value;
}

export function assertSlug(value, label = "slug") {
	if (typeof value !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)) {
		throw new MediumContractError(
			`${label} must use lowercase ASCII kebab-case`,
		);
	}
	return value;
}

export function assertCanonicalUtc(value, label) {
	assertNonEmptyString(value, label);
	const parsed = new Date(value);
	if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
		throw new MediumContractError(
			`${label} must use canonical UTC ISO 8601 form, for example 2026-07-25T12:34:56.000Z`,
		);
	}
	return value;
}

export function assertSha256(value, label) {
	if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
		throw new MediumContractError(
			`${label} must be a lowercase SHA-256 digest`,
		);
	}
	return value;
}

export function assertHttpsUrl(value, label, { hostname } = {}) {
	assertNonEmptyString(value, label);
	let url;
	try {
		url = new URL(value);
	} catch (error) {
		throw new MediumContractError(`${label} must be an absolute URL`, {
			cause: error,
		});
	}
	if (url.protocol !== "https:") {
		throw new MediumContractError(`${label} must use HTTPS`);
	}
	if (url.username || url.password) {
		throw new MediumContractError(`${label} must not contain credentials`);
	}
	if (hostname && url.hostname !== hostname) {
		throw new MediumContractError(`${label} must use ${hostname}`);
	}
	return url;
}

export function assertSafeRepositoryPath(value, label) {
	assertNonEmptyString(value, label);
	if (
		value.includes("\\") ||
		value.startsWith("/") ||
		/^[A-Za-z]:/u.test(value) ||
		value
			.split("/")
			.some((segment) => segment === "" || segment === "." || segment === "..")
	) {
		throw new MediumContractError(
			`${label} must be a normalized repository-relative path`,
		);
	}
	return value;
}

export function resolveInside(root, repositoryPath, label) {
	assertSafeRepositoryPath(repositoryPath, label);
	const absoluteRoot = path.resolve(root);
	const absolutePath = path.resolve(absoluteRoot, ...repositoryPath.split("/"));
	const relative = path.relative(absoluteRoot, absolutePath);
	if (
		relative === "" ||
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	) {
		throw new MediumContractError(`${label} escapes its allowed root`);
	}
	return absolutePath;
}

export function toRepositoryPath(repoRoot, absolutePath) {
	const root = path.resolve(repoRoot);
	const relative = path.relative(root, path.resolve(absolutePath));
	if (
		relative === "" ||
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	) {
		throw new MediumContractError(
			`Path is outside the repository: ${absolutePath}`,
		);
	}
	return relative.split(path.sep).join("/");
}

export function getMediumPaths(repoRoot = DEFAULT_REPO_ROOT) {
	const root = path.resolve(repoRoot);
	return {
		root,
		rawRoot: path.join(root, ".medium-import", "raw"),
		candidatePath: path.join(
			root,
			".medium-import",
			"inventory-candidate.json",
		),
		assetChecklistPath: path.join(
			root,
			".medium-import",
			"hero-acquisition-checklist.json",
		),
		reviewProposalPath: path.join(
			root,
			".medium-import",
			"inventory-review-proposal.json",
		),
		inventoryPath: path.join(root, "provenance", "medium", "inventory.json"),
		manifestPath: path.join(root, "provenance", "medium", "manifest.json"),
		snapshotRoot: path.join(root, "provenance", "medium", "posts"),
		postsRoot: path.join(root, "src", "content", "posts"),
	};
}

export function getMediumArticlePaths(repoRoot, article) {
	const roots = getMediumPaths(repoRoot);
	const slug = assertSlug(article.slug);
	const postDirectory = path.join(roots.postsRoot, slug);
	return {
		...roots,
		snapshotPath: path.join(roots.snapshotRoot, `${slug}.json`),
		markdownPath: path.join(postDirectory, "index.md"),
		postDirectory,
		rawAssetRoot: path.join(roots.rawRoot, "assets", slug),
	};
}

export function serializeJson(value) {
	return `${JSON.stringify(value, null, 2)}\n`;
}
