import path from "node:path";
import { fileURLToPath } from "node:url";

export const MANIFEST_SCHEMA_VERSION = 1;
export const SNAPSHOT_JSON_POINTER = "/props/pageProps/post";
export const VOCAL_AUTHOR_NAME = "Tai Song";
export const VOCAL_AUTHOR_URL = "https://vocal.media/authors/tai-song";
export const VOCAL_PLATFORM = "Vocal";
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

export function assertNonEmptyString(value, label) {
	if (typeof value !== "string" || value.length === 0) {
		throw new ContractError(`${label} must be a non-empty string`);
	}
	if (value.includes("\0")) {
		throw new ContractError(`${label} must not contain a NUL character`);
	}
	return value;
}

export function assertOptionalString(value, label) {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") {
		throw new ContractError(`${label} must be a string when present`);
	}
	if (value.includes("\0")) {
		throw new ContractError(`${label} must not contain a NUL character`);
	}
	return value;
}

export function assertSafeJsonNumbers(value, label = "post") {
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new ContractError(`${label} contains a non-finite number`);
		}
		if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
			throw new ContractError(`${label} contains an unsafe integer`);
		}
		return;
	}
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index += 1) {
			assertSafeJsonNumbers(value[index], `${label}[${index}]`);
		}
		return;
	}
	if (isPlainObject(value)) {
		for (const [key, child] of Object.entries(value)) {
			assertSafeJsonNumbers(child, `${label}.${key}`);
		}
	}
}

export function assertSlug(slug) {
	if (typeof slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
		throw new ContractError(
			`Invalid slug ${JSON.stringify(slug)}; use lowercase kebab-case`,
		);
	}
	return slug;
}

export function assertCapturedAt(value) {
	if (typeof value !== "string" || value.length === 0) {
		throw new ContractError(
			"--captured-at must be an explicit ISO 8601 timestamp",
		);
	}
	const parsed = new Date(value);
	if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
		throw new ContractError(
			"--captured-at must use canonical UTC ISO 8601 form, for example 2026-07-21T12:34:56.000Z",
		);
	}
	return value;
}

export function getRepositoryPaths(repoRoot = DEFAULT_REPO_ROOT) {
	const root = path.resolve(repoRoot);
	return {
		root,
		rawRoot: path.join(root, ".vocal-import", "raw"),
		manifestPath: path.join(root, "provenance", "vocal", "manifest.json"),
		snapshotRoot: path.join(root, "provenance", "vocal", "posts"),
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
