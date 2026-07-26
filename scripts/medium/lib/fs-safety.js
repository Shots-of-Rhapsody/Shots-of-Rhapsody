import { lstat, mkdir, open, realpath } from "node:fs/promises";
import path from "node:path";
import { MediumContractError } from "./contract.js";

function assertPositiveLimit(value, label) {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new MediumContractError(`${label} must be a positive safe integer`);
	}
	return value;
}

function relativeInside(root, target, label, { allowRoot = false } = {}) {
	const relative = path.relative(path.resolve(root), path.resolve(target));
	if (
		(!allowRoot && relative === "") ||
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	) {
		throw new MediumContractError(`${label} escapes its fixed ignored root`);
	}
	return relative;
}

function assertPhysicalDirectoryStats(stats, label) {
	if (!stats.isDirectory() || stats.isSymbolicLink()) {
		throw new MediumContractError(
			`${label} must be a physical directory, not a link`,
		);
	}
}

async function physicalRoot(root, label) {
	let stats;
	let resolved;
	try {
		[stats, resolved] = await Promise.all([lstat(root), realpath(root)]);
	} catch (error) {
		if (error?.code === "ENOENT") {
			throw new MediumContractError(`${label} is missing: ${root}`);
		}
		throw error;
	}
	assertPhysicalDirectoryStats(stats, label);
	return { lexical: path.resolve(root), real: resolved };
}

async function assertPhysicalDirectoryChain(root, directory, label) {
	const rootInfo = await physicalRoot(root, `${label} root`);
	const relative = relativeInside(rootInfo.lexical, directory, label, {
		allowRoot: true,
	});
	let cursor = rootInfo.lexical;
	if (relative !== "") {
		for (const segment of relative.split(path.sep)) {
			cursor = path.join(cursor, segment);
			let stats;
			try {
				stats = await lstat(cursor);
			} catch (error) {
				if (error?.code === "ENOENT") {
					throw new MediumContractError(
						`${label} directory is missing: ${cursor}`,
					);
				}
				throw error;
			}
			assertPhysicalDirectoryStats(stats, `${label} directory`);
		}
	}
	const resolved = await realpath(cursor);
	relativeInside(rootInfo.real, resolved, label, { allowRoot: true });
	return { root: rootInfo, directory: cursor, real: resolved };
}

function sameFile(left, right) {
	return left.dev === right.dev && left.ino === right.ino;
}

export async function readBoundedRegularFileInside({
	root,
	filePath,
	label,
	maxBytes,
	expectedBytes,
} = {}) {
	const limit = assertPositiveLimit(maxBytes, `${label} size limit`);
	if (
		expectedBytes !== undefined &&
		(!Number.isSafeInteger(expectedBytes) ||
			expectedBytes < 1 ||
			expectedBytes > limit)
	) {
		throw new MediumContractError(
			`${label} expected size must be within its configured limit`,
		);
	}
	const absolutePath = path.resolve(filePath);
	const chain = await assertPhysicalDirectoryChain(
		root,
		path.dirname(absolutePath),
		label,
	);
	relativeInside(chain.root.lexical, absolutePath, label);
	let lexicalStats;
	let resolvedPath;
	try {
		[lexicalStats, resolvedPath] = await Promise.all([
			lstat(absolutePath, { bigint: true }),
			realpath(absolutePath),
		]);
	} catch (error) {
		if (error?.code === "ENOENT") {
			throw new MediumContractError(`${label} is missing: ${absolutePath}`);
		}
		throw error;
	}
	if (!lexicalStats.isFile() || lexicalStats.isSymbolicLink()) {
		throw new MediumContractError(
			`${label} must be a regular file, not a link`,
		);
	}
	relativeInside(chain.root.real, resolvedPath, label);
	const declaredSize = Number(lexicalStats.size);
	if (
		!Number.isSafeInteger(declaredSize) ||
		declaredSize < 1 ||
		declaredSize > limit
	) {
		throw new MediumContractError(
			`${label} size must be between 1 and ${limit} bytes before reading`,
		);
	}
	if (expectedBytes !== undefined && declaredSize !== expectedBytes) {
		throw new MediumContractError(
			`${label} size differs from its acquisition evidence before reading`,
		);
	}

	let handle;
	try {
		handle = await open(absolutePath, "r");
		const openedStats = await handle.stat({ bigint: true });
		if (!openedStats.isFile() || !sameFile(lexicalStats, openedStats)) {
			throw new MediumContractError(
				`${label} changed identity while it was being opened`,
			);
		}
		const openedSize = Number(openedStats.size);
		if (openedSize !== declaredSize || openedSize > limit) {
			throw new MediumContractError(
				`${label} changed size before it could be read safely`,
			);
		}
		const buffer = await handle.readFile();
		const finalStats = await handle.stat({ bigint: true });
		if (
			!sameFile(openedStats, finalStats) ||
			Number(finalStats.size) !== declaredSize ||
			buffer.byteLength !== declaredSize
		) {
			throw new MediumContractError(`${label} changed while it was being read`);
		}
		return buffer;
	} finally {
		await handle?.close().catch(() => {});
	}
}

export async function ensureFixedPhysicalDirectory({
	root,
	segments,
	label,
} = {}) {
	if (!Array.isArray(segments) || segments.length === 0) {
		throw new MediumContractError(`${label} requires fixed path components`);
	}
	const rootInfo = await physicalRoot(root, `${label} root`);
	let cursor = rootInfo.lexical;
	for (const [index, segment] of segments.entries()) {
		if (
			typeof segment !== "string" ||
			segment.length === 0 ||
			segment === "." ||
			segment === ".." ||
			path.basename(segment) !== segment ||
			segment.includes("/") ||
			segment.includes("\\")
		) {
			throw new MediumContractError(
				`${label} component ${index} is not a safe fixed directory name`,
			);
		}
		cursor = path.join(cursor, segment);
		try {
			await mkdir(cursor);
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
		}
		const stats = await lstat(cursor);
		assertPhysicalDirectoryStats(stats, `${label} component ${segment}`);
		const resolved = await realpath(cursor);
		relativeInside(rootInfo.real, resolved, label);
	}
	return cursor;
}

export function filesShareIdentity(left, right) {
	return sameFile(left, right);
}
