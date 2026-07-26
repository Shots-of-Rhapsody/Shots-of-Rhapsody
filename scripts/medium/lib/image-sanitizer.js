import { randomUUID } from "node:crypto";
import { link, lstat, open, unlink } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { loadMediumHeroAcquisition, mediumHeroBinding } from "./acquisition.js";
import {
	assertPlainObject,
	assertSha256,
	assertSlug,
	getMediumArticlePaths,
	getMediumPaths,
	MEDIUM_HERO_CAPTURE_FILE,
	MEDIUM_HERO_MAX_OUTPUT_BYTES,
	MEDIUM_HERO_MAX_RECORD_BYTES,
	MEDIUM_HERO_MAX_SOURCE_BYTES,
	MEDIUM_HERO_SANITIZATION_RECORD,
	MEDIUM_HERO_SITE_READY_FILE,
	MediumContractError,
	serializeJson,
	toRepositoryPath,
} from "./contract.js";
import {
	ensureFixedPhysicalDirectory,
	filesShareIdentity,
	readBoundedRegularFileInside,
} from "./fs-safety.js";
import { sha256 } from "./integrity.js";

const MAX_INPUT_PIXELS = 100_000_000;
const SHARP_OPTIONS = Object.freeze({
	animated: true,
	failOn: "warning",
	limitInputPixels: MAX_INPUT_PIXELS,
	sequentialRead: true,
});

function parseWebpChunks(buffer, label) {
	if (
		!Buffer.isBuffer(buffer) ||
		buffer.byteLength < 20 ||
		buffer.toString("ascii", 0, 4) !== "RIFF" ||
		buffer.toString("ascii", 8, 12) !== "WEBP" ||
		buffer.readUInt32LE(4) !== buffer.byteLength - 8
	) {
		throw new MediumContractError(`${label} is not a complete WebP RIFF file`);
	}
	const chunks = [];
	let offset = 12;
	while (offset < buffer.byteLength) {
		if (offset > buffer.byteLength - 8) {
			throw new MediumContractError(
				`${label} has a truncated WebP chunk header`,
			);
		}
		const type = buffer.toString("ascii", offset, offset + 4);
		const byteLength = buffer.readUInt32LE(offset + 4);
		const dataStart = offset + 8;
		const dataEnd = dataStart + byteLength;
		const paddedEnd = dataEnd + (byteLength % 2);
		if (dataEnd < dataStart || paddedEnd > buffer.byteLength) {
			throw new MediumContractError(
				`${label} has a truncated WebP ${type} chunk`,
			);
		}
		chunks.push({
			type,
			byteLength,
			data: buffer.subarray(dataStart, dataEnd),
		});
		offset = paddedEnd;
	}
	if (chunks.length === 0 || offset !== buffer.byteLength) {
		throw new MediumContractError(`${label} has an invalid WebP chunk table`);
	}
	return chunks;
}

function hasAnimation(chunks, metadata) {
	const extended = chunks.find((chunk) => chunk.type === "VP8X");
	return (
		chunks.some((chunk) => chunk.type === "ANIM" || chunk.type === "ANMF") ||
		(Boolean(extended) &&
			extended.byteLength > 0 &&
			(extended.data[0] & 2) !== 0) ||
		(metadata.pages ?? 1) > 1 ||
		(metadata.delay?.length ?? 0) > 0 ||
		metadata.loop !== undefined
	);
}

function detectedMetadata(chunks, metadata) {
	const detected = new Set();
	for (const chunk of chunks) {
		if (
			chunk.type !== "VP8 " &&
			chunk.type !== "VP8L" &&
			chunk.type !== "VP8X"
		) {
			detected.add(`container:${chunk.type.trim()}`);
		}
	}
	for (const field of [
		"exif",
		"icc",
		"iptc",
		"xmp",
		"xmpAsString",
		"tifftagPhotoshop",
		"comments",
		"gainMap",
		"orientation",
		"resolutionUnit",
	]) {
		const value = metadata[field];
		if (
			value !== undefined &&
			value !== null &&
			(!Array.isArray(value) || value.length > 0)
		) {
			detected.add(`sharp:${field}`);
		}
	}
	if (metadata.hasProfile) detected.add("sharp:hasProfile");
	return [...detected].sort();
}

async function sharpMetadata(buffer, label) {
	try {
		return await sharp(buffer, SHARP_OPTIONS).metadata();
	} catch (error) {
		throw new MediumContractError(`${label} cannot be decoded safely`, {
			cause: error,
		});
	}
}

async function decodedPixels(buffer, label) {
	try {
		return await sharp(buffer, SHARP_OPTIONS)
			.toColourspace("srgb")
			.ensureAlpha()
			.raw({ depth: "uchar" })
			.toBuffer({ resolveWithObject: true });
	} catch (error) {
		throw new MediumContractError(`${label} pixel decoding failed`, {
			cause: error,
		});
	}
}

async function inspectSource(buffer, label) {
	if (!Buffer.isBuffer(buffer)) {
		throw new MediumContractError(`${label} must be a byte buffer`);
	}
	if (buffer.byteLength > MEDIUM_HERO_MAX_SOURCE_BYTES) {
		throw new MediumContractError(
			`${label} exceeds the ${MEDIUM_HERO_MAX_SOURCE_BYTES}-byte safety limit`,
		);
	}
	const chunks = parseWebpChunks(buffer, label);
	if (hasAnimation(chunks, {})) {
		throw new MediumContractError(`${label} must not be animated`);
	}
	const metadata = await sharpMetadata(buffer, label);
	if (
		metadata.format !== "webp" ||
		metadata.mediaType !== "image/webp" ||
		!Number.isSafeInteger(metadata.width) ||
		metadata.width < 1 ||
		!Number.isSafeInteger(metadata.height) ||
		metadata.height < 1 ||
		metadata.depth !== "uchar"
	) {
		throw new MediumContractError(
			`${label} must be a static 8-bit WebP with valid dimensions`,
		);
	}
	if (hasAnimation(chunks, metadata)) {
		throw new MediumContractError(`${label} must not be animated`);
	}
	if (metadata.orientation !== undefined && metadata.orientation !== 1) {
		throw new MediumContractError(
			`${label} uses a nontrivial orientation that cannot be stripped while preserving dimensions and pixels`,
		);
	}
	return {
		chunks,
		metadata,
		embeddedMetadata: detectedMetadata(chunks, metadata),
	};
}

async function inspectSiteReady(buffer, label) {
	if (buffer.byteLength > MEDIUM_HERO_MAX_OUTPUT_BYTES) {
		throw new MediumContractError(
			`${label} exceeds the ${MEDIUM_HERO_MAX_OUTPUT_BYTES}-byte safety limit`,
		);
	}
	const chunks = parseWebpChunks(buffer, label);
	if (chunks.length !== 1 || chunks[0].type !== "VP8L") {
		throw new MediumContractError(
			`${label} must contain only one lossless VP8L image chunk and no metadata or auxiliary chunks`,
		);
	}
	const metadata = await sharpMetadata(buffer, label);
	if (
		metadata.format !== "webp" ||
		metadata.mediaType !== "image/webp" ||
		metadata.hasProfile ||
		metadata.exif !== undefined ||
		metadata.icc !== undefined ||
		metadata.iptc !== undefined ||
		metadata.xmp !== undefined ||
		metadata.xmpAsString !== undefined ||
		metadata.tifftagPhotoshop !== undefined ||
		(metadata.comments?.length ?? 0) > 0 ||
		metadata.gainMap !== undefined ||
		metadata.orientation !== undefined ||
		hasAnimation(chunks, metadata)
	) {
		throw new MediumContractError(
			`${label} contains metadata, an auxiliary payload, or animation`,
		);
	}
	return { chunks, metadata };
}

function imagePathRecord(repoRoot, absolutePath) {
	return toRepositoryPath(repoRoot, absolutePath);
}

function assertMediumHeroBinding(value, slug) {
	const binding = assertPlainObject(value, "Medium hero acquisition binding");
	const asset = assertPlainObject(
		binding.asset,
		"Medium hero acquisition binding asset",
	);
	const acquisition = assertPlainObject(
		binding.acquisition,
		"Medium hero acquisition binding item",
	);
	for (const [field, expected] of [
		["slug", slug],
		["storyId", asset.storyId],
		["heroImageId", asset.heroImageId],
		["canonicalUrl", asset.canonicalUrl],
		["observedUrl", asset.observedUrl],
	]) {
		if (asset[field] !== expected || acquisition[field] !== expected) {
			throw new MediumContractError(
				`Medium hero acquisition binding ${field} is inconsistent`,
			);
		}
	}
	if (acquisition.approvedExportTitle !== asset.title) {
		throw new MediumContractError(
			"Medium hero acquisition title differs from its durable asset binding",
		);
	}
	return {
		acquisitionManifestSha256: assertSha256(
			binding.acquisitionManifestSha256,
			"Medium hero acquisition manifest SHA-256",
		),
		exportSha256: assertSha256(
			binding.exportSha256,
			"Medium hero export SHA-256",
		),
		candidateSetSha256: assertSha256(
			binding.candidateSetSha256,
			"Medium hero candidate-set SHA-256",
		),
		asset,
		acquisition,
	};
}

export async function verifySanitizedMediumHero({
	repoRoot,
	slug: slugValue,
	sourceBuffer,
	outputBuffer,
	binding: bindingValue,
} = {}) {
	const slug = assertSlug(slugValue);
	const binding = assertMediumHeroBinding(bindingValue, slug);
	if (!Buffer.isBuffer(sourceBuffer) || !Buffer.isBuffer(outputBuffer)) {
		throw new MediumContractError(
			"Medium hero source and site-ready output must be byte buffers",
		);
	}
	const paths = getMediumArticlePaths(repoRoot, { slug });
	const sourcePath = path.join(paths.rawAssetRoot, MEDIUM_HERO_CAPTURE_FILE);
	const outputPath = path.join(
		paths.siteReadyAssetRoot,
		MEDIUM_HERO_SITE_READY_FILE,
	);
	const source = await inspectSource(sourceBuffer, "Medium hero capture");
	const output = await inspectSiteReady(outputBuffer, "Site-ready Medium hero");
	const sourceSha256 = sha256(sourceBuffer);
	if (
		sourceSha256 !== binding.asset.capture.sha256 ||
		sourceBuffer.byteLength !== binding.asset.capture.byteSize ||
		source.metadata.width !== binding.asset.capture.width ||
		source.metadata.height !== binding.asset.capture.height
	) {
		throw new MediumContractError(
			"Medium hero capture differs from its acquisition identity and byte evidence",
		);
	}
	const outputSha256 = sha256(outputBuffer);
	if (
		outputSha256 !== binding.asset.siteReady.sha256 ||
		outputBuffer.byteLength !== binding.asset.siteReady.byteSize ||
		output.metadata.width !== binding.asset.siteReady.width ||
		output.metadata.height !== binding.asset.siteReady.height
	) {
		throw new MediumContractError(
			"Site-ready Medium hero differs from its durable asset evidence",
		);
	}
	if (
		source.metadata.width !== output.metadata.width ||
		source.metadata.height !== output.metadata.height
	) {
		throw new MediumContractError(
			"Site-ready Medium hero dimensions differ from the captured source",
		);
	}
	const [sourcePixels, outputPixels] = await Promise.all([
		decodedPixels(sourceBuffer, "Medium hero capture"),
		decodedPixels(outputBuffer, "Site-ready Medium hero"),
	]);
	if (
		sourcePixels.info.width !== outputPixels.info.width ||
		sourcePixels.info.height !== outputPixels.info.height ||
		sourcePixels.info.channels !== 4 ||
		outputPixels.info.channels !== 4 ||
		!sourcePixels.data.equals(outputPixels.data)
	) {
		throw new MediumContractError(
			"Site-ready Medium hero decoded pixels differ from the captured source",
		);
	}
	const pixelSha256 = sha256(sourcePixels.data);
	if (pixelSha256 !== binding.asset.pixels.sha256) {
		throw new MediumContractError(
			"Medium hero decoded pixels differ from their durable pixel evidence",
		);
	}
	return {
		schemaVersion: 1,
		state: "site-ready-image",
		slug,
		identity: {
			acquisitionManifestSha256: binding.acquisitionManifestSha256,
			exportSha256: binding.exportSha256,
			candidateSetSha256: binding.candidateSetSha256,
			title: binding.asset.title,
			currentMediumTitle: binding.acquisition.currentMediumTitle,
			storyId: binding.asset.storyId,
			heroImageId: binding.asset.heroImageId,
			canonicalUrl: binding.asset.canonicalUrl,
			observedUrl: binding.asset.observedUrl,
			capturedAt: binding.acquisition.capturedAt,
		},
		capture: {
			path: imagePathRecord(repoRoot, sourcePath),
			kind: "highest-observed-medium-responsive-derivative",
			originalUploadClaimed: false,
			sha256: sourceSha256,
			mimeType: "image/webp",
			byteSize: sourceBuffer.byteLength,
			width: source.metadata.width,
			height: source.metadata.height,
			embeddedMetadata: source.embeddedMetadata,
		},
		output: {
			path: imagePathRecord(repoRoot, outputPath),
			sha256: outputSha256,
			mimeType: "image/webp",
			byteSize: outputBuffer.byteLength,
			width: output.metadata.width,
			height: output.metadata.height,
			containerChunks: output.chunks.map((chunk) => chunk.type),
			embeddedMetadata: [],
		},
		pixels: {
			colourspace: "srgb",
			channels: 4,
			depth: "uchar",
			sha256: pixelSha256,
			identical: true,
		},
		tool: {
			name: "sharp",
			version: sharp.versions.sharp,
			libvipsVersion: sharp.versions.vips,
		},
	};
}

export async function sanitizeMediumHeroBuffer({
	repoRoot,
	slug,
	sourceBuffer,
	binding,
} = {}) {
	await inspectSource(sourceBuffer, "Medium hero capture");
	let outputBuffer;
	try {
		outputBuffer = await sharp(sourceBuffer, SHARP_OPTIONS)
			.toColourspace("srgb")
			.ensureAlpha()
			.webp({ lossless: true, effort: 6 })
			.toBuffer();
	} catch (error) {
		throw new MediumContractError("Medium hero sanitization failed", {
			cause: error,
		});
	}
	const record = await verifySanitizedMediumHero({
		repoRoot,
		slug,
		sourceBuffer,
		outputBuffer,
		binding,
	});
	return { outputBuffer, record };
}

async function assertMissing(filePath, label) {
	try {
		await lstat(filePath);
		throw new MediumContractError(
			`${label} already exists; remove it explicitly before generating a replacement`,
		);
	} catch (error) {
		if (error?.code === "ENOENT") return;
		throw error;
	}
}

async function writeSanitizationBatch(repoRoot, results) {
	const mediumPaths = getMediumPaths(repoRoot);
	const operations = [];
	for (const result of results) {
		const slug = assertSlug(result.record.slug);
		const directory = await ensureFixedPhysicalDirectory({
			root: mediumPaths.importRoot,
			segments: ["site-ready", "assets", slug],
			label: `Medium site-ready directory for ${slug}`,
		});
		const expectedOutputPath = path.join(
			directory,
			MEDIUM_HERO_SITE_READY_FILE,
		);
		const expectedRecordPath = path.join(
			directory,
			MEDIUM_HERO_SANITIZATION_RECORD,
		);
		if (
			path.resolve(result.absoluteOutputPath) !==
				path.resolve(expectedOutputPath) ||
			path.resolve(result.absoluteRecordPath) !==
				path.resolve(expectedRecordPath)
		) {
			throw new MediumContractError(
				`Medium hero sanitization target differs from its fixed path for ${slug}`,
			);
		}
		operations.push(
			{
				path: expectedOutputPath,
				contents: result.outputBuffer,
				label: `Site-ready Medium hero for ${slug}`,
			},
			{
				path: expectedRecordPath,
				contents: Buffer.from(serializeJson(result.record), "utf8"),
				label: `Medium hero sanitization record for ${slug}`,
			},
		);
	}
	const targets = operations.map((operation) => path.resolve(operation.path));
	if (new Set(targets).size !== targets.length) {
		throw new MediumContractError(
			"Medium hero sanitization batch repeats an output path",
		);
	}
	for (const operation of operations) {
		await assertMissing(operation.path, operation.label);
	}
	const prepared = [];
	try {
		for (const operation of operations) {
			const temporaryPath = path.join(
				path.dirname(operation.path),
				`.medium-sanitize-${randomUUID()}.tmp`,
			);
			const preparedOperation = {
				...operation,
				temporaryPath,
				installed: false,
			};
			prepared.push(preparedOperation);
			let handle;
			try {
				handle = await open(temporaryPath, "wx", 0o600);
				await handle.writeFile(operation.contents);
				await handle.sync();
			} finally {
				await handle?.close().catch(() => {});
			}
			const temporaryStats = await lstat(temporaryPath, { bigint: true });
			if (
				!temporaryStats.isFile() ||
				temporaryStats.isSymbolicLink() ||
				Number(temporaryStats.size) !== operation.contents.byteLength
			) {
				throw new MediumContractError(
					`${operation.label} temporary file is not the expected regular file`,
				);
			}
		}
		for (const operation of prepared) {
			try {
				await link(operation.temporaryPath, operation.path);
			} catch (error) {
				if (error?.code === "EEXIST") {
					throw new MediumContractError(
						`${operation.label} appeared during installation; no existing target was replaced`,
						{ cause: error },
					);
				}
				throw error;
			}
			operation.installed = true;
		}
	} catch (error) {
		const cleanupFailures = [];
		for (const operation of [...prepared].reverse()) {
			if (operation.installed) {
				try {
					const [temporaryStats, installedStats] = await Promise.all([
						lstat(operation.temporaryPath, { bigint: true }),
						lstat(operation.path, { bigint: true }),
					]);
					if (!filesShareIdentity(temporaryStats, installedStats)) {
						cleanupFailures.push(operation.path);
					} else {
						await unlink(operation.path);
					}
				} catch (cleanupError) {
					if (cleanupError?.code !== "ENOENT") {
						cleanupFailures.push(operation.path);
					}
				}
			}
			try {
				await unlink(operation.temporaryPath);
			} catch (cleanupError) {
				if (cleanupError?.code !== "ENOENT") {
					cleanupFailures.push(operation.temporaryPath);
				}
			}
		}
		if (cleanupFailures.length > 0) {
			throw new MediumContractError(
				"Medium hero sanitization failed and identity-safe rollback could not remove every file; inspect the fixed ignored site-ready root",
				{ cause: error },
			);
		}
		throw error;
	}
	const cleanupFailures = [];
	for (const operation of prepared) {
		try {
			await unlink(operation.temporaryPath);
		} catch (error) {
			if (error?.code !== "ENOENT")
				cleanupFailures.push(operation.temporaryPath);
		}
	}
	if (cleanupFailures.length > 0) {
		throw new MediumContractError(
			"Medium hero outputs were installed without replacement, but one or more ignored temporary links require manual cleanup",
		);
	}
}

export async function sanitizeMediumHero({
	repoRoot,
	slug: slugValue,
	write = false,
	loadedAcquisition,
} = {}) {
	const slug = assertSlug(slugValue);
	const acquisition =
		loadedAcquisition ?? (await loadMediumHeroAcquisition(repoRoot));
	const binding = mediumHeroBinding(acquisition, slug);
	const paths = getMediumArticlePaths(repoRoot, { slug });
	const sourcePath = path.join(paths.rawAssetRoot, MEDIUM_HERO_CAPTURE_FILE);
	const outputPath = path.join(
		paths.siteReadyAssetRoot,
		MEDIUM_HERO_SITE_READY_FILE,
	);
	const recordPath = path.join(
		paths.siteReadyAssetRoot,
		MEDIUM_HERO_SANITIZATION_RECORD,
	);
	const sourceBuffer = await readBoundedRegularFileInside({
		root: getMediumPaths(repoRoot).rawRoot,
		filePath: sourcePath,
		label: `Medium hero capture for ${slug}`,
		maxBytes: MEDIUM_HERO_MAX_SOURCE_BYTES,
		expectedBytes: binding.asset.capture.byteSize,
	});
	const { outputBuffer, record } = await sanitizeMediumHeroBuffer({
		repoRoot,
		slug,
		sourceBuffer,
		binding,
	});
	if (write) {
		await writeSanitizationBatch(repoRoot, [
			{
				absoluteOutputPath: outputPath,
				absoluteRecordPath: recordPath,
				outputBuffer,
				record,
			},
		]);
	}
	return {
		mode: write ? "write" : "dry-run",
		outputPath: imagePathRecord(repoRoot, outputPath),
		recordPath: imagePathRecord(repoRoot, recordPath),
		outputBuffer,
		record,
	};
}

export async function sanitizeMediumHeroes({
	repoRoot,
	slugs,
	write = false,
	loadedAcquisition: acquisitionValue,
} = {}) {
	if (!Array.isArray(slugs) || slugs.length === 0) {
		throw new MediumContractError(
			"Medium hero sanitization requires at least one approved slug",
		);
	}
	const approvedSlugs = slugs.map((slug, index) =>
		assertSlug(slug, `slugs[${index}]`),
	);
	if (new Set(approvedSlugs).size !== approvedSlugs.length) {
		throw new MediumContractError(
			"Medium hero sanitization slug list contains a duplicate",
		);
	}
	const loadedAcquisition =
		acquisitionValue ?? (await loadMediumHeroAcquisition(repoRoot));
	const results = [];
	for (const slug of approvedSlugs) {
		const result = await sanitizeMediumHero({
			repoRoot,
			slug,
			write: false,
			loadedAcquisition,
		});
		const paths = getMediumArticlePaths(repoRoot, { slug });
		results.push({
			...result,
			absoluteOutputPath: path.join(
				paths.siteReadyAssetRoot,
				MEDIUM_HERO_SITE_READY_FILE,
			),
			absoluteRecordPath: path.join(
				paths.siteReadyAssetRoot,
				MEDIUM_HERO_SANITIZATION_RECORD,
			),
		});
	}
	if (write) await writeSanitizationBatch(repoRoot, results);
	return {
		mode: write ? "write" : "dry-run",
		results: results.map(
			({
				absoluteOutputPath: _output,
				absoluteRecordPath: _record,
				...result
			}) => ({ ...result, mode: write ? "write" : "dry-run" }),
		),
	};
}

export async function readVerifiedMediumHero({
	repoRoot,
	slug: slugValue,
	loadedAcquisition,
} = {}) {
	const slug = assertSlug(slugValue);
	const acquisition =
		loadedAcquisition ?? (await loadMediumHeroAcquisition(repoRoot));
	const binding = mediumHeroBinding(acquisition, slug);
	const paths = getMediumArticlePaths(repoRoot, { slug });
	const sourcePath = path.join(paths.rawAssetRoot, MEDIUM_HERO_CAPTURE_FILE);
	const outputPath = path.join(
		paths.siteReadyAssetRoot,
		MEDIUM_HERO_SITE_READY_FILE,
	);
	const recordPath = path.join(
		paths.siteReadyAssetRoot,
		MEDIUM_HERO_SANITIZATION_RECORD,
	);
	const [sourceBuffer, outputBuffer, recordBuffer] = await Promise.all([
		readBoundedRegularFileInside({
			root: getMediumPaths(repoRoot).rawRoot,
			filePath: sourcePath,
			label: `Medium hero capture for ${slug}`,
			maxBytes: MEDIUM_HERO_MAX_SOURCE_BYTES,
			expectedBytes: binding.asset.capture.byteSize,
		}),
		readBoundedRegularFileInside({
			root: getMediumPaths(repoRoot).siteReadyRoot,
			filePath: outputPath,
			label: `Site-ready Medium hero for ${slug}`,
			maxBytes: MEDIUM_HERO_MAX_OUTPUT_BYTES,
			expectedBytes: binding.asset.siteReady.byteSize,
		}),
		readBoundedRegularFileInside({
			root: getMediumPaths(repoRoot).siteReadyRoot,
			filePath: recordPath,
			label: `Medium hero sanitization record for ${slug}`,
			maxBytes: MEDIUM_HERO_MAX_RECORD_BYTES,
		}),
	]);
	const record = await verifySanitizedMediumHero({
		repoRoot,
		slug,
		sourceBuffer,
		outputBuffer,
		binding,
	});
	if (!recordBuffer.equals(Buffer.from(serializeJson(record), "utf8"))) {
		throw new MediumContractError(
			"Medium hero sanitization record differs from the current source and site-ready bytes",
		);
	}
	return { sourceBuffer, outputBuffer, record };
}
