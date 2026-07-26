import assert from "node:assert/strict";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	symlink,
	truncate,
	unlink,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import {
	MEDIUM_HERO_CAPTURE_FILE,
	MEDIUM_HERO_MAX_OUTPUT_BYTES,
	MEDIUM_HERO_MAX_RECORD_BYTES,
	MEDIUM_HERO_SANITIZATION_RECORD,
	MEDIUM_HERO_SITE_READY_FILE,
} from "../lib/contract.js";
import {
	readVerifiedMediumHero,
	sanitizeMediumHero,
	sanitizeMediumHeroBuffer,
	sanitizeMediumHeroes,
	verifySanitizedMediumHero,
} from "../lib/image-sanitizer.js";
import { sha256 } from "../lib/integrity.js";

async function sourceWebp({ red = 30, green = 90, blue = 140 } = {}) {
	return sharp({
		create: {
			width: 4,
			height: 3,
			channels: 4,
			background: { r: red, g: green, b: blue, alpha: 0.75 },
		},
	})
		.withExif({ IFD0: { Artist: "Private capture metadata" } })
		.webp({ lossless: true })
		.toBuffer();
}

const ACQUISITION_MANIFEST_SHA256 = `sha256:${"1".repeat(64)}`;
const EXPORT_SHA256 = `sha256:${"2".repeat(64)}`;
const CANDIDATE_SET_SHA256 = `sha256:${"3".repeat(64)}`;

async function bindingForSource(sourceBuffer, slug) {
	const outputBuffer = await sharp(sourceBuffer, {
		animated: true,
		failOn: "warning",
		limitInputPixels: 100_000_000,
		sequentialRead: true,
	})
		.toColourspace("srgb")
		.ensureAlpha()
		.webp({ lossless: true, effort: 6 })
		.toBuffer();
	const [sourceMetadata, outputMetadata, pixels] = await Promise.all([
		sharp(sourceBuffer).metadata(),
		sharp(outputBuffer).metadata(),
		sharp(sourceBuffer)
			.toColourspace("srgb")
			.ensureAlpha()
			.raw({ depth: "uchar" })
			.toBuffer(),
	]);
	const storyId = sha256(Buffer.from(slug)).slice(
		"sha256:".length,
		"sha256:".length + 12,
	);
	const heroImageId = `1*${storyId}@2x.jpeg`;
	const title = `Title for ${slug}`;
	const canonicalUrl = `https://medium.com/@ShotsOfRhapsody/${slug}-${storyId}`;
	const observedUrl = `https://miro.medium.com/v2/resize:fit:4800/format:webp/${heroImageId}`;
	return {
		outputBuffer,
		binding: {
			acquisitionManifestSha256: ACQUISITION_MANIFEST_SHA256,
			exportSha256: EXPORT_SHA256,
			candidateSetSha256: CANDIDATE_SET_SHA256,
			asset: {
				slug,
				title,
				storyId,
				heroImageId,
				canonicalUrl,
				observedUrl,
				capture: {
					sha256: sha256(sourceBuffer),
					mimeType: "image/webp",
					byteSize: sourceBuffer.byteLength,
					width: sourceMetadata.width,
					height: sourceMetadata.height,
				},
				siteReady: {
					sha256: sha256(outputBuffer),
					mimeType: "image/webp",
					byteSize: outputBuffer.byteLength,
					width: outputMetadata.width,
					height: outputMetadata.height,
				},
				pixels: {
					sha256: sha256(pixels),
					colourspace: "srgb",
					channels: 4,
					depth: "uchar",
				},
			},
			acquisition: {
				slug,
				storyId,
				approvedExportTitle: title,
				currentMediumTitle: title,
				canonicalUrl,
				heroImageId,
				observedUrl,
				capturedAt: "2026-07-26T08:00:00.000Z",
			},
		},
	};
}

function loadedAcquisition(bindings) {
	const assets = bindings.map((binding) => binding.asset);
	const acquisitionItems = bindings.map((binding) => binding.acquisition);
	return {
		acquisitionManifestSha256: ACQUISITION_MANIFEST_SHA256,
		assetLedger: {
			exportSha256: EXPORT_SHA256,
			candidateSetSha256: CANDIDATE_SET_SHA256,
			acquisitionManifestSha256: ACQUISITION_MANIFEST_SHA256,
			items: assets,
			itemCount: assets.length,
			bySlug: new Map(assets.map((asset) => [asset.slug, asset])),
		},
		items: acquisitionItems,
		itemCount: acquisitionItems.length,
		bySlug: new Map(acquisitionItems.map((item) => [item.slug, item])),
	};
}

function webpChunk(type, data) {
	const header = Buffer.alloc(8);
	header.write(type, 0, 4, "ascii");
	header.writeUInt32LE(data.byteLength, 4);
	return Buffer.concat([
		header,
		data,
		...(data.byteLength % 2 === 0 ? [] : [Buffer.alloc(1)]),
	]);
}

function animatedWebpMarker() {
	const vp8x = Buffer.alloc(10);
	vp8x[0] = 2;
	const body = Buffer.concat([
		Buffer.from("WEBP", "ascii"),
		webpChunk("VP8X", vp8x),
		webpChunk("ANIM", Buffer.alloc(6)),
	]);
	const riff = Buffer.alloc(8);
	riff.write("RIFF", 0, 4, "ascii");
	riff.writeUInt32LE(body.byteLength, 4);
	return Buffer.concat([riff, body]);
}

async function rawHeroPath(repoRoot, slug) {
	const directory = path.join(
		repoRoot,
		".medium-import",
		"raw",
		"assets",
		slug,
	);
	await mkdir(directory, { recursive: true });
	return path.join(directory, MEDIUM_HERO_CAPTURE_FILE);
}

function siteReadyPath(repoRoot, slug, fileName) {
	return path.join(
		repoRoot,
		".medium-import",
		"site-ready",
		"assets",
		slug,
		fileName,
	);
}

test("sanitization strips metadata while preserving dimensions and decoded pixels", async () => {
	const repoRoot = path.join(os.tmpdir(), "medium-image-buffer-contract");
	const sourceBuffer = await sourceWebp();
	const { binding } = await bindingForSource(sourceBuffer, "exact-essay");
	const { outputBuffer, record } = await sanitizeMediumHeroBuffer({
		repoRoot,
		slug: "exact-essay",
		sourceBuffer,
		binding,
	});

	assert.notEqual(sha256(outputBuffer), sha256(sourceBuffer));
	assert.equal(
		record.capture.kind,
		"highest-observed-medium-responsive-derivative",
	);
	assert.equal(record.capture.originalUploadClaimed, false);
	assert.equal(
		record.identity.acquisitionManifestSha256,
		ACQUISITION_MANIFEST_SHA256,
	);
	assert.equal(record.identity.storyId, binding.asset.storyId);
	assert.equal(record.identity.heroImageId, binding.asset.heroImageId);
	assert.equal(record.capture.width, 4);
	assert.equal(record.capture.height, 3);
	assert.ok(record.capture.embeddedMetadata.includes("container:EXIF"));
	assert.ok(record.capture.embeddedMetadata.includes("sharp:exif"));
	assert.deepEqual(record.output.containerChunks, ["VP8L"]);
	assert.deepEqual(record.output.embeddedMetadata, []);
	assert.equal(record.output.width, record.capture.width);
	assert.equal(record.output.height, record.capture.height);
	assert.equal(record.pixels.identical, true);

	const outputMetadata = await sharp(outputBuffer).metadata();
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
	]) {
		assert.equal(outputMetadata[field], undefined, `${field} was retained`);
	}
});

test("verification rejects a pixel-changing output", async () => {
	const sourceBuffer = await sourceWebp();
	const { binding } = await bindingForSource(sourceBuffer, "exact-essay");
	const { outputBuffer: changedOutput, binding: changedBinding } =
		await bindingForSource(await sourceWebp({ red: 220 }), "changed-essay");
	const pixelChangingBinding = {
		...binding,
		asset: { ...binding.asset, siteReady: changedBinding.asset.siteReady },
	};
	await assert.rejects(
		verifySanitizedMediumHero({
			repoRoot: path.join(os.tmpdir(), "medium-image-pixel-contract"),
			slug: "exact-essay",
			sourceBuffer,
			outputBuffer: changedOutput,
			binding: pixelChangingBinding,
		}),
		/decoded pixels differ/u,
	);
});

test("sanitization rejects animation and malformed WebP input", async () => {
	const { binding } = await bindingForSource(await sourceWebp(), "exact-essay");
	await assert.rejects(
		sanitizeMediumHeroBuffer({
			repoRoot: path.join(os.tmpdir(), "medium-image-animation-contract"),
			slug: "exact-essay",
			sourceBuffer: animatedWebpMarker(),
			binding,
		}),
		/must not be animated/u,
	);
	await assert.rejects(
		sanitizeMediumHeroBuffer({
			repoRoot: path.join(os.tmpdir(), "medium-image-malformed-contract"),
			slug: "exact-essay",
			sourceBuffer: Buffer.from("not a complete image"),
			binding,
		}),
		/not a complete WebP RIFF file/u,
	);
});

test("file sanitization is no-overwrite and leaves raw evidence unchanged", async (t) => {
	const repoRoot = await mkdtemp(path.join(os.tmpdir(), "medium-image-files-"));
	t.after(() => rm(repoRoot, { recursive: true, force: true }));
	const slug = "exact-essay";
	const sourceBuffer = await sourceWebp();
	const { binding } = await bindingForSource(sourceBuffer, slug);
	const loaded = loadedAcquisition([binding]);
	const sourcePath = await rawHeroPath(repoRoot, slug);
	await writeFile(sourcePath, sourceBuffer);

	const written = await sanitizeMediumHero({
		repoRoot,
		slug,
		write: true,
		loadedAcquisition: loaded,
	});
	const outputPath = siteReadyPath(repoRoot, slug, MEDIUM_HERO_SITE_READY_FILE);
	const recordPath = siteReadyPath(
		repoRoot,
		slug,
		MEDIUM_HERO_SANITIZATION_RECORD,
	);
	assert.equal(sha256(await readFile(sourcePath)), sha256(sourceBuffer));
	assert.equal(
		sha256(await readFile(outputPath)),
		written.record.output.sha256,
	);
	assert.deepEqual(
		JSON.parse(await readFile(recordPath, "utf8")),
		written.record,
	);
	const verified = await readVerifiedMediumHero({
		repoRoot,
		slug,
		loadedAcquisition: loaded,
	});
	assert.equal(verified.record.output.sha256, written.record.output.sha256);
	await assert.rejects(
		sanitizeMediumHero({
			repoRoot,
			slug,
			write: true,
			loadedAcquisition: loaded,
		}),
		/already exists/u,
	);
	await assert.rejects(stat(path.join(repoRoot, "src")), { code: "ENOENT" });
	await assert.rejects(stat(path.join(repoRoot, "dist")), { code: "ENOENT" });
});

test("batch mode processes only its explicit slug allowlist and writes nothing on failure", async (t) => {
	const repoRoot = await mkdtemp(path.join(os.tmpdir(), "medium-image-batch-"));
	t.after(() => rm(repoRoot, { recursive: true, force: true }));
	const includedSlug = "included-essay";
	const malformedSlug = "malformed-essay";
	const unlistedSlug = "unlisted-essay";
	const includedSource = await sourceWebp();
	const { binding: includedBinding } = await bindingForSource(
		includedSource,
		includedSlug,
	);
	await writeFile(await rawHeroPath(repoRoot, includedSlug), includedSource);
	const malformedBytes = Buffer.from("malformed");
	await writeFile(await rawHeroPath(repoRoot, malformedSlug), malformedBytes);
	await writeFile(
		await rawHeroPath(repoRoot, unlistedSlug),
		await sourceWebp(),
	);
	const malformedBinding = {
		...includedBinding,
		asset: {
			...includedBinding.asset,
			slug: malformedSlug,
			capture: {
				...includedBinding.asset.capture,
				sha256: sha256(malformedBytes),
				byteSize: malformedBytes.byteLength,
			},
		},
		acquisition: {
			...includedBinding.acquisition,
			slug: malformedSlug,
		},
	};
	const loaded = loadedAcquisition([includedBinding, malformedBinding]);

	await assert.rejects(
		sanitizeMediumHeroes({
			repoRoot,
			slugs: [includedSlug, malformedSlug],
			write: true,
			loadedAcquisition: loaded,
		}),
		/not a complete WebP RIFF file/u,
	);
	for (const slug of [includedSlug, malformedSlug, unlistedSlug]) {
		await assert.rejects(
			stat(siteReadyPath(repoRoot, slug, MEDIUM_HERO_SITE_READY_FILE)),
			{ code: "ENOENT" },
		);
	}
	await assert.rejects(
		sanitizeMediumHeroes({
			repoRoot,
			slugs: [includedSlug, includedSlug],
			loadedAcquisition: loaded,
		}),
		/contains a duplicate/u,
	);
});

test("single and batch modes reject hero captures swapped between approved slugs", async (t) => {
	const repoRoot = await mkdtemp(path.join(os.tmpdir(), "medium-image-swap-"));
	t.after(() => rm(repoRoot, { recursive: true, force: true }));
	const firstSlug = "first-essay";
	const secondSlug = "second-essay";
	const firstSource = await sourceWebp({ red: 15, green: 25, blue: 35 });
	const secondSource = await sourceWebp({ red: 215, green: 125, blue: 45 });
	const { binding: firstBinding } = await bindingForSource(
		firstSource,
		firstSlug,
	);
	const { binding: secondBinding } = await bindingForSource(
		secondSource,
		secondSlug,
	);
	const loaded = loadedAcquisition([firstBinding, secondBinding]);
	await writeFile(await rawHeroPath(repoRoot, firstSlug), secondSource);
	await writeFile(await rawHeroPath(repoRoot, secondSlug), firstSource);

	await assert.rejects(
		sanitizeMediumHero({
			repoRoot,
			slug: firstSlug,
			loadedAcquisition: loaded,
		}),
		/size differs .* before reading|capture differs/u,
	);
	await assert.rejects(
		sanitizeMediumHeroes({
			repoRoot,
			slugs: [firstSlug, secondSlug],
			write: true,
			loadedAcquisition: loaded,
		}),
		/size differs .* before reading|capture differs/u,
	);
	for (const slug of [firstSlug, secondSlug]) {
		await assert.rejects(
			stat(siteReadyPath(repoRoot, slug, MEDIUM_HERO_SITE_READY_FILE)),
			{ code: "ENOENT" },
		);
	}
});

test("pre-read size checks and no-replace preflight leave targets untouched", async (t) => {
	const repoRoot = await mkdtemp(
		path.join(os.tmpdir(), "medium-image-limits-"),
	);
	t.after(() => rm(repoRoot, { recursive: true, force: true }));
	const slug = "bounded-essay";
	const sourceBuffer = await sourceWebp();
	const { binding } = await bindingForSource(sourceBuffer, slug);
	const loaded = loadedAcquisition([binding]);
	const sourcePath = await rawHeroPath(repoRoot, slug);
	await writeFile(sourcePath, Buffer.concat([sourceBuffer, Buffer.from([0])]));
	await assert.rejects(
		sanitizeMediumHero({
			repoRoot,
			slug,
			loadedAcquisition: loaded,
		}),
		/size differs .* before reading/u,
	);

	await writeFile(sourcePath, sourceBuffer);
	const recordPath = siteReadyPath(
		repoRoot,
		slug,
		MEDIUM_HERO_SANITIZATION_RECORD,
	);
	await mkdir(path.dirname(recordPath), { recursive: true });
	const sentinel = Buffer.from("do not replace");
	await writeFile(recordPath, sentinel);
	await assert.rejects(
		sanitizeMediumHero({
			repoRoot,
			slug,
			write: true,
			loadedAcquisition: loaded,
		}),
		/already exists/u,
	);
	assert.deepEqual(await readFile(recordPath), sentinel);
	await assert.rejects(
		stat(siteReadyPath(repoRoot, slug, MEDIUM_HERO_SITE_READY_FILE)),
		{ code: "ENOENT" },
	);

	await unlink(recordPath);
	const outputPath = siteReadyPath(repoRoot, slug, MEDIUM_HERO_SITE_READY_FILE);
	await writeFile(outputPath, sentinel);
	await assert.rejects(
		sanitizeMediumHero({
			repoRoot,
			slug,
			write: true,
			loadedAcquisition: loaded,
		}),
		/already exists/u,
	);
	assert.deepEqual(await readFile(outputPath), sentinel);
	await assert.rejects(stat(recordPath), { code: "ENOENT" });
});

test("record reads enforce their dedicated lstat cap", async (t) => {
	const repoRoot = await mkdtemp(
		path.join(os.tmpdir(), "medium-record-limit-"),
	);
	t.after(() => rm(repoRoot, { recursive: true, force: true }));
	const slug = "record-limit-essay";
	const sourceBuffer = await sourceWebp();
	const { binding } = await bindingForSource(sourceBuffer, slug);
	const loaded = loadedAcquisition([binding]);
	await writeFile(await rawHeroPath(repoRoot, slug), sourceBuffer);
	await sanitizeMediumHero({
		repoRoot,
		slug,
		write: true,
		loadedAcquisition: loaded,
	});
	await writeFile(
		siteReadyPath(repoRoot, slug, MEDIUM_HERO_SANITIZATION_RECORD),
		Buffer.alloc(MEDIUM_HERO_MAX_RECORD_BYTES + 1),
	);
	await assert.rejects(
		readVerifiedMediumHero({
			repoRoot,
			slug,
			loadedAcquisition: loaded,
		}),
		/size must be between .* before reading/u,
	);
});

test("site-ready image reads enforce their pre-read lstat cap", async (t) => {
	const repoRoot = await mkdtemp(
		path.join(os.tmpdir(), "medium-output-limit-"),
	);
	t.after(() => rm(repoRoot, { recursive: true, force: true }));
	const slug = "output-limit-essay";
	const sourceBuffer = await sourceWebp();
	const { binding } = await bindingForSource(sourceBuffer, slug);
	const loaded = loadedAcquisition([binding]);
	await writeFile(await rawHeroPath(repoRoot, slug), sourceBuffer);
	await sanitizeMediumHero({
		repoRoot,
		slug,
		write: true,
		loadedAcquisition: loaded,
	});
	await truncate(
		siteReadyPath(repoRoot, slug, MEDIUM_HERO_SITE_READY_FILE),
		MEDIUM_HERO_MAX_OUTPUT_BYTES + 1,
	);
	await assert.rejects(
		readVerifiedMediumHero({
			repoRoot,
			slug,
			loadedAcquisition: loaded,
		}),
		/size must be between .* before reading/u,
	);
});

test("site-ready directory links are rejected without writing outside the ignored root", async (t) => {
	const repoRoot = await mkdtemp(path.join(os.tmpdir(), "medium-link-root-"));
	const outside = await mkdtemp(path.join(os.tmpdir(), "medium-link-outside-"));
	t.after(async () => {
		await rm(repoRoot, { recursive: true, force: true });
		await rm(outside, { recursive: true, force: true });
	});
	const slug = "linked-essay";
	const sourceBuffer = await sourceWebp();
	const { binding } = await bindingForSource(sourceBuffer, slug);
	const loaded = loadedAcquisition([binding]);
	await writeFile(await rawHeroPath(repoRoot, slug), sourceBuffer);
	const importRoot = path.join(repoRoot, ".medium-import");
	try {
		await symlink(
			outside,
			path.join(importRoot, "site-ready"),
			process.platform === "win32" ? "junction" : "dir",
		);
	} catch (error) {
		if (error?.code === "EPERM") {
			t.skip("Creating a directory link is not permitted on this host");
			return;
		}
		throw error;
	}
	await assert.rejects(
		sanitizeMediumHero({
			repoRoot,
			slug,
			write: true,
			loadedAcquisition: loaded,
		}),
		/physical directory, not a link/u,
	);
	assert.deepEqual(await readdir(outside), []);
});
