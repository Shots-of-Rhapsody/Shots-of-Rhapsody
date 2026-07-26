import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import {
	embeddedRasterContainerMetadata,
	embeddedRasterMetadata,
	validAvifPixelInformation,
	verifyBuiltImages,
} from "../../verify-images.mjs";

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function appendWebpChunk(bytes, type, payload) {
	const header = Buffer.alloc(8);
	header.write(type, 0, 4, "ascii");
	header.writeUInt32LE(payload.byteLength, 4);
	const result = Buffer.concat([
		bytes,
		header,
		payload,
		...(payload.byteLength % 2 === 0 ? [] : [Buffer.alloc(1)]),
	]);
	result.writeUInt32LE(result.byteLength - 8, 4);
	return result;
}

function insertJpegApp15(bytes, payload) {
	const segment = Buffer.alloc(payload.byteLength + 4);
	segment[0] = 0xff;
	segment[1] = 0xef;
	segment.writeUInt16BE(payload.byteLength + 2, 2);
	payload.copy(segment, 4);
	return Buffer.concat([bytes.subarray(0, 2), segment, bytes.subarray(2)]);
}

const TEST_CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
	let crc = value;
	for (let bit = 0; bit < 8; bit += 1)
		crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
	return crc >>> 0;
});

function pngCrc32(bytes) {
	let crc = 0xffffffff;
	for (const byte of bytes)
		crc = TEST_CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, payload) {
	const typeBytes = Buffer.from(type, "ascii");
	const result = Buffer.alloc(payload.byteLength + 12);
	result.writeUInt32BE(payload.byteLength, 0);
	typeBytes.copy(result, 4);
	payload.copy(result, 8);
	result.writeUInt32BE(
		pngCrc32(Buffer.concat([typeBytes, payload])),
		8 + payload.byteLength,
	);
	return result;
}

function pngChunks(bytes) {
	const chunks = [];
	let offset = 8;
	while (offset < bytes.byteLength) {
		const byteLength = bytes.readUInt32BE(offset);
		const end = offset + byteLength + 12;
		chunks.push({
			type: bytes.toString("ascii", offset + 4, offset + 8),
			bytes: bytes.subarray(offset, end),
		});
		offset = end;
	}
	return chunks;
}

function appendAvifUuidBox(bytes, payload) {
	const userType = Buffer.alloc(16, 0x41);
	const box = Buffer.alloc(8 + userType.byteLength + payload.byteLength);
	box.writeUInt32BE(box.byteLength, 0);
	box.write("uuid", 4, 4, "ascii");
	userType.copy(box, 8);
	payload.copy(box, 24);
	return Buffer.concat([bytes, box]);
}

function pictureMarkup({ priority = false } = {}) {
	return `<picture><source type="image/avif" srcset="/_astro/hero.avif 320w" sizes="100vw"><img src="/_astro/hero.webp" srcset="/_astro/hero.webp 320w" sizes="100vw" width="2048" height="2048" loading="${priority ? "eager" : "lazy"}"${priority ? ' fetchpriority="high"' : ""} alt=""></picture>`;
}

async function createFixture() {
	const root = await mkdtemp(path.join(os.tmpdir(), "shots-images-"));
	const dist = path.join(root, "dist");
	const provenance = path.join(root, "provenance", "tai-song");
	const mediumProvenance = path.join(root, "provenance", "medium");
	const firstPartyProvenance = path.join(root, "provenance", "first-party");
	await mkdir(path.join(dist, "_astro"), { recursive: true });
	await mkdir(path.join(dist, "social"), { recursive: true });
	await mkdir(provenance, { recursive: true });
	await mkdir(mediumProvenance, { recursive: true });
	await mkdir(firstPartyProvenance, { recursive: true });

	const originalBytes = Buffer.from("archival-original-fixture");
	const slugs = Array.from(
		{ length: 11 },
		(_, index) => `article-${index + 1}`,
	);
	const manifest = {
		articles: slugs.map((slug, index) => ({
			slug,
			image: {
				sha256:
					index === 0
						? `sha256:${sha256(originalBytes)}`
						: `sha256:${String(index).padStart(64, "0")}`,
				width: 2048,
				height: 2048,
			},
		})),
	};
	await writeFile(
		path.join(provenance, "manifest.json"),
		JSON.stringify(manifest),
	);
	await writeFile(
		path.join(mediumProvenance, "manifest.json"),
		JSON.stringify({
			schemaVersion: 1,
			state: "awaiting-export",
			articles: [],
		}),
	);
	await writeFile(
		path.join(firstPartyProvenance, "manifest.json"),
		JSON.stringify({ schemaVersion: 1, state: "active", articles: [] }),
	);
	await writeFile(
		path.join(root, "provenance", "publication-catalog.json"),
		JSON.stringify({
			schemaVersion: 1,
			entries: slugs.map((slug) => ({ slug, source: "tai-song" })),
		}),
	);

	const responsiveInput = randomBytes(320 * 320 * 3);
	const responsiveAvif = await sharp(responsiveInput, {
		raw: { width: 320, height: 320, channels: 3 },
	})
		.avif({ quality: 20 })
		.toBuffer();
	const responsiveWebp = await sharp(responsiveInput, {
		raw: { width: 320, height: 320, channels: 3 },
	})
		.webp({ quality: 20 })
		.toBuffer();
	await writeFile(path.join(dist, "_astro", "hero.avif"), responsiveAvif);
	await writeFile(path.join(dist, "_astro", "hero.webp"), responsiveWebp);

	const socialJpeg = await sharp({
		create: {
			width: 1200,
			height: 1200,
			channels: 3,
			background: "#efe8d5",
		},
	})
		.jpeg({ quality: 40, mozjpeg: true })
		.toBuffer();
	const siteSocialJpeg = await sharp({
		create: {
			width: 1200,
			height: 630,
			channels: 3,
			background: "#efe8d5",
		},
	})
		.jpeg({ quality: 40, mozjpeg: true })
		.toBuffer();
	await writeFile(path.join(dist, "social", "site.jpg"), siteSocialJpeg);
	for (const slug of slugs) {
		await writeFile(path.join(dist, "social", `${slug}.jpg`), socialJpeg);
		const postDirectory = path.join(dist, "posts", slug);
		await mkdir(postDirectory, { recursive: true });
		await writeFile(
			path.join(postDirectory, "index.html"),
			`<figure data-archive-hero><div data-image-variant="hero">${pictureMarkup()}</div></figure><meta property="og:image" content="/social/${slug}.jpg">`,
		);
	}
	await writeFile(path.join(dist, "mark.svg"), "<svg></svg>");
	await mkdir(path.join(dist, "pagefind"), { recursive: true });
	await writeFile(
		path.join(dist, "pagefind", "pagefind.js"),
		randomBytes(32 * 1024),
	);
	await writeFile(
		path.join(dist, "index.html"),
		`<!doctype html><html><head><link rel="icon" href="/mark.svg"><meta property="og:image" content="/social/site.jpg"><script>window.__fixture=true</script></head><body><article data-editorial-slug="${slugs[0]}">${pictureMarkup({ priority: true })}</article></body></html>`,
	);

	return { root, dist, originalBytes, slugs };
}

test("accepts an allowlisted responsive publication artifact", async (t) => {
	const fixture = await createFixture();
	t.after(() =>
		rm(fixture.root, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 50,
		}),
	);
	const stats = await verifyBuiltImages({
		dist: fixture.dist,
		repoRoot: fixture.root,
	});
	assert.equal(stats.imageCount, 15);
	assert.ok(stats.initialJavaScriptGzipBytes > 0);
	assert.ok(stats.initialJavaScriptGzipBytes < 1024);
	assert.ok(stats.homepageInitialImageBytes > 0);
});

test("rejects embedded metadata in a referenced raster derivative", async (t) => {
	const fixture = await createFixture();
	t.after(() =>
		rm(fixture.root, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 50,
		}),
	);
	const metadataBearingWebp = await sharp({
		create: {
			width: 320,
			height: 320,
			channels: 3,
			background: "#efe8d5",
		},
	})
		.webp({ quality: 20 })
		.withExif({ IFD0: { Artist: "private fixture author" } })
		.withXmp(
			'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" /></x:xmpmeta>',
		)
		.toBuffer();
	await writeFile(
		path.join(fixture.dist, "_astro", "hero.webp"),
		metadataBearingWebp,
	);
	await assert.rejects(
		verifyBuiltImages({ dist: fixture.dist, repoRoot: fixture.root }),
		/built raster image contains embedded metadata: _astro\/hero\.webp \(EXIF, XMP\)/u,
	);
});

test("rejects an arbitrary hidden WebP container payload", async (t) => {
	const fixture = await createFixture();
	t.after(() =>
		rm(fixture.root, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 50,
		}),
	);
	const webpPath = path.join(fixture.dist, "_astro", "hero.webp");
	const hiddenPayload = appendWebpChunk(
		await readFile(webpPath),
		"PRIV",
		Buffer.from("private fixture note", "utf8"),
	);
	assert.equal((await sharp(hiddenPayload).metadata()).format, "webp");
	await writeFile(webpPath, hiddenPayload);
	await assert.rejects(
		verifyBuiltImages({ dist: fixture.dist, repoRoot: fixture.root }),
		/built raster container contains unexpected payload: _astro\/hero\.webp \(WebP chunk PRIV/u,
	);
});

test("rejects unknown payload containers across public raster formats", async () => {
	const input = {
		create: {
			width: 8,
			height: 8,
			channels: 3,
			background: "#efe8d5",
		},
	};
	const cleanWebp = await sharp(input).webp({ quality: 40 }).toBuffer();
	const cleanJpeg = await sharp(input)
		.jpeg({ quality: 40, mozjpeg: true })
		.toBuffer();
	const encodedPng = await sharp(input).png().toBuffer();
	const cleanPng = Buffer.concat([
		encodedPng.subarray(0, 8),
		...pngChunks(encodedPng)
			.filter((chunk) => chunk.type !== "pHYs")
			.map((chunk) => chunk.bytes),
	]);
	const cleanAvif = await sharp(input).avif({ quality: 40 }).toBuffer();
	for (const bytes of [cleanWebp, cleanJpeg, cleanPng, cleanAvif]) {
		const metadata = await sharp(bytes).metadata();
		assert.deepEqual(
			embeddedRasterContainerMetadata(bytes, metadata),
			[],
			metadata.format,
		);
	}

	const payload = Buffer.from("private fixture note", "utf8");
	const pngParts = pngChunks(cleanPng);
	const hiddenPng = Buffer.concat([
		cleanPng.subarray(0, 8),
		pngParts[0].bytes,
		pngChunk("prIv", payload),
		...pngParts.slice(1).map((chunk) => chunk.bytes),
	]);
	const cases = [
		{
			bytes: appendWebpChunk(cleanWebp, "PRIV", payload),
			expected: /WebP chunk PRIV/u,
		},
		{
			bytes: insertJpegApp15(cleanJpeg, payload),
			expected: /JPEG segment APP15/u,
		},
		{ bytes: hiddenPng, expected: /PNG chunk prIv/u },
		{
			bytes: Buffer.concat([
				cleanPng.subarray(0, 8),
				pngParts[0].bytes,
				pngChunk("pHYs", Buffer.from("00000b1300000b1301", "hex")),
				...pngParts.slice(1).map((chunk) => chunk.bytes),
			]),
			expected: /PNG chunk pHYs/u,
		},
		{
			bytes: appendAvifUuidBox(cleanAvif, payload),
			expected: /AVIF top-level box uuid/u,
		},
	];
	for (const { bytes, expected } of cases) {
		const metadata = await sharp(bytes).metadata();
		assert.match(
			embeddedRasterContainerMetadata(bytes, metadata).join(", "),
			expected,
			metadata.format,
		);
	}
});

test("accepts only exact 8-bit AVIF pixel-information layouts", () => {
	assert.equal(
		validAvifPixelInformation(Buffer.from("000000000108", "hex")),
		true,
	);
	assert.equal(
		validAvifPixelInformation(Buffer.from("0000000003080808", "hex")),
		true,
	);
	for (const invalid of [
		Buffer.from("00000000020808", "hex"),
		Buffer.from("000000000308080810", "hex"),
		Buffer.from("00000000010a", "hex"),
		Buffer.from("000000010108", "hex"),
	]) {
		assert.equal(validAvifPixelInformation(invalid), false);
	}
});

test("detects embedded metadata in every supported raster output format", async () => {
	for (const format of ["avif", "jpeg", "png", "webp"]) {
		const bytes = await sharp({
			create: {
				width: 2,
				height: 2,
				channels: 3,
				background: "#efe8d5",
			},
		})
			[format]()
			.withExif({ IFD0: { Artist: "private fixture author" } })
			.withXmp(
				'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" /></x:xmpmeta>',
			)
			.toBuffer();
		assert.deepEqual(
			embeddedRasterMetadata(await sharp(bytes).metadata()),
			["EXIF", "XMP"],
			format,
		);
	}
});

test("rejects embedded metadata in a public SVG", async (t) => {
	const fixture = await createFixture();
	t.after(() =>
		rm(fixture.root, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 50,
		}),
	);
	await writeFile(
		path.join(fixture.dist, "mark.svg"),
		'<svg xmlns="http://www.w3.org/2000/svg"><metadata>private fixture note</metadata></svg>',
	);
	await assert.rejects(
		verifyBuiltImages({ dist: fixture.dist, repoRoot: fixture.root }),
		/built SVG contains embedded metadata: mark\.svg \(SVG metadata\)/u,
	);
});

test("rejects a leaked archival original by its manifest hash", async (t) => {
	const fixture = await createFixture();
	t.after(() =>
		rm(fixture.root, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 50,
		}),
	);
	await writeFile(
		path.join(fixture.dist, "_astro", "original.png"),
		fixture.originalBytes,
	);
	await assert.rejects(
		verifyBuiltImages({ dist: fixture.dist, repoRoot: fixture.root }),
		/archival original image leaked into dist/u,
	);
});

test("rejects an unreferenced responsive or draft asset", async (t) => {
	const fixture = await createFixture();
	t.after(() =>
		rm(fixture.root, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 50,
		}),
	);
	const orphan = await sharp({
		create: {
			width: 320,
			height: 320,
			channels: 3,
			background: "#111111",
		},
	})
		.webp()
		.toBuffer();
	await writeFile(path.join(fixture.dist, "_astro", "draft.webp"), orphan);
	await assert.rejects(
		verifyBuiltImages({ dist: fixture.dist, repoRoot: fixture.root }),
		/built image is not referenced by any output/u,
	);
});

test("rejects a referenced derivative outside manifest-bound heroes and cards", async (t) => {
	const fixture = await createFixture();
	t.after(() =>
		rm(fixture.root, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 50,
		}),
	);
	const draft = await sharp({
		create: {
			width: 320,
			height: 320,
			channels: 3,
			background: "#111111",
		},
	})
		.webp()
		.toBuffer();
	await writeFile(path.join(fixture.dist, "_astro", "draft.webp"), draft);
	const homepagePath = path.join(fixture.dist, "index.html");
	const homepage = await readFile(homepagePath, "utf8");
	await writeFile(
		homepagePath,
		homepage.replace(
			"</body>",
			'<img src="/_astro/draft.webp" loading="lazy" alt=""></body>',
		),
	);
	await assert.rejects(
		verifyBuiltImages({ dist: fixture.dist, repoRoot: fixture.root }),
		/not bound to a manifest article source/u,
	);
});

test("requires exactly one eager high-priority homepage image", async (t) => {
	const fixture = await createFixture();
	t.after(() =>
		rm(fixture.root, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 50,
		}),
	);
	const homepagePath = path.join(fixture.dist, "index.html");
	const homepage = await readFile(homepagePath, "utf8");
	await writeFile(
		homepagePath,
		homepage.replace("</body>", `${pictureMarkup({ priority: true })}</body>`),
	);
	await assert.rejects(
		verifyBuiltImages({ dist: fixture.dist, repoRoot: fixture.root }),
		/exactly one initially loaded eager\/high-priority image/u,
	);
});

test("enforces derivative and total artifact budgets", async (t) => {
	const fixture = await createFixture();
	t.after(() =>
		rm(fixture.root, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 50,
		}),
	);
	await assert.rejects(
		verifyBuiltImages({
			dist: fixture.dist,
			repoRoot: fixture.root,
			limits: {
				cardBytes: 1,
				socialBytes: 1,
				distBytes: 1,
				initialJavaScriptGzipBytes: 1,
				homepageDesktopImageBytes: 1,
				homepageMobileImageBytes: 1,
			},
		}),
		/budget|exceeds/u,
	);
});
