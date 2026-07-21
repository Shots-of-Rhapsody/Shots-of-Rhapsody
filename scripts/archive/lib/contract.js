import path from "node:path";
import { fileURLToPath } from "node:url";

export const MANIFEST_SCHEMA_VERSION = 1;
export const SNAPSHOT_SCHEMA_VERSION = 1;
export const INVENTORY_SCHEMA_VERSION = 1;
export const AUTHORITY_PLATFORM = "Proton Docs";
export const CAPTURE_FORMAT = "html-export";
export const PUBLICATION_PLATFORM = "Vocal";
export const AUTHOR_NAME = "Tai Song";
export const ALL_RIGHTS_RESERVED = "All Rights Reserved";

export const DEFAULT_REPO_ROOT = fileURLToPath(
	new URL("../../../", import.meta.url),
);

export class ContractError extends Error {
	constructor(message, options = {}) {
		super(message, options);
		this.name = "ContractError";
	}
}

export function isPlainObject(value) {
	if (value === null || typeof value !== "object") return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

export function assertPlainObject(value, label) {
	if (!isPlainObject(value)) {
		throw new ContractError(`${label} must be a JSON object`);
	}
	return value;
}

export function assertOnlyKeys(value, allowed, label) {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) {
			throw new ContractError(
				`${label} contains unsupported key ${JSON.stringify(key)}`,
			);
		}
	}
}

export function assertString(value, label) {
	if (typeof value !== "string" || value.includes("\0")) {
		throw new ContractError(`${label} must be a string without NUL characters`);
	}
	return value;
}

export function assertNonEmptyString(value, label) {
	assertString(value, label);
	if (value.length === 0) {
		throw new ContractError(`${label} must be a non-empty string`);
	}
	return value;
}

export function assertOptionalString(value, label) {
	if (value === undefined || value === null) return undefined;
	return assertString(value, label);
}

export function assertInteger(value, label, { positive = false } = {}) {
	if (!Number.isSafeInteger(value) || value < 0 || (positive && value === 0)) {
		throw new ContractError(
			`${label} must be a ${positive ? "positive" : "non-negative"} safe integer`,
		);
	}
	return value;
}

export function assertSlug(slug) {
	if (typeof slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
		throw new ContractError(
			`Invalid slug ${JSON.stringify(slug)}; use lowercase kebab-case`,
		);
	}
	return slug;
}

export function assertCanonicalUtc(value, label = "capturedAt") {
	assertNonEmptyString(value, label);
	const parsed = new Date(value);
	if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
		throw new ContractError(
			`${label} must use canonical UTC ISO 8601 form, for example 2026-07-21T12:34:56.000Z`,
		);
	}
	return value;
}

export function assertDateString(value, label) {
	assertNonEmptyString(value, label);
	if (Number.isNaN(new Date(value).valueOf())) {
		throw new ContractError(`${label} must be a parseable date string`);
	}
	return value;
}

export function assertSha256(value, label) {
	if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
		throw new ContractError(`${label} must be a lowercase SHA-256 digest`);
	}
	return value;
}

export function assertHttpsUrl(value, label) {
	assertNonEmptyString(value, label);
	let url;
	try {
		url = new URL(value);
	} catch (error) {
		throw new ContractError(`${label} must be an absolute URL`, {
			cause: error,
		});
	}
	if (url.protocol !== "https:") {
		throw new ContractError(`${label} must use HTTPS`);
	}
	return url;
}

export function assertVocalPublication(value, label) {
	const publication = assertPlainObject(value, label);
	assertOnlyKeys(publication, new Set(["platform", "url"]), label);
	if (publication.platform !== PUBLICATION_PLATFORM) {
		throw new ContractError(
			`${label}.platform must equal ${JSON.stringify(PUBLICATION_PLATFORM)}`,
		);
	}
	const url = assertHttpsUrl(publication.url, `${label}.url`);
	if (url.hostname !== "vocal.media") {
		throw new ContractError(`${label}.url must use https://vocal.media`);
	}
	return { platform: PUBLICATION_PLATFORM, url: url.toString() };
}

export function assertNoPrivateProtonReferences(value, label) {
	const serialized = typeof value === "string" ? value : serializeJson(value);
	const patterns = [
		/https?:\/\/(?:docs|drive)\.proton\.(?:me|ch)\b/iu,
		/https?:\/\/[^\s"']+\.protonusercontent\.com\b/iu,
		/\bproton\.me\/drive\/urls\//iu,
	];
	if (patterns.some((pattern) => pattern.test(serialized))) {
		throw new ContractError(`${label} contains a private Proton reference`);
	}
}

export function getRepositoryPaths(repoRoot = DEFAULT_REPO_ROOT) {
	const root = path.resolve(repoRoot);
	return {
		root,
		rawRoot: path.join(root, ".proton-import", "raw"),
		inventoryPath: path.join(root, "provenance", "tai-song", "inventory.json"),
		manifestPath: path.join(root, "provenance", "tai-song", "manifest.json"),
		snapshotRoot: path.join(root, "provenance", "tai-song", "posts"),
		postsRoot: path.join(root, "src", "content", "posts"),
	};
}

export function getArticlePaths(repoRoot, slug) {
	assertSlug(slug);
	const roots = getRepositoryPaths(repoRoot);
	const rawDirectory = path.join(roots.rawRoot, slug);
	const postDirectory = path.join(roots.postsRoot, slug);
	return {
		...roots,
		rawDirectory,
		rawPagePath: path.join(rawDirectory, "page.html"),
		rawImagePath: path.join(rawDirectory, "hero-original.png"),
		snapshotPath: path.join(roots.snapshotRoot, `${slug}.json`),
		postDirectory,
		markdownPath: path.join(postDirectory, "index.md"),
		imagePath: path.join(postDirectory, "hero-original.png"),
	};
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
		throw new ContractError(`Path is outside the repository: ${absolutePath}`);
	}
	return relative.split(path.sep).join("/");
}

export function serializeJson(value) {
	return `${JSON.stringify(value, null, 2)}\n`;
}
