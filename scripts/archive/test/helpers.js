import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const FIXTURE_PATH = fileURLToPath(
	new URL("./fixtures/proton-fragment.html", import.meta.url),
);

export const SAMPLE_SLUG = "exact-article";
export const SAMPLE_CAPTURED_AT = "2026-07-21T19:20:21.000Z";
export const SAMPLE_SUBTITLE = "An exact subtitle — “smart” & deliberate";
export const SAMPLE_CAPTION = "Original caption & credit.";

export async function readFixture() {
	return readFile(FIXTURE_PATH, "utf8");
}

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
	let crc = value;
	for (let bit = 0; bit < 8; bit += 1) {
		crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
	}
	return crc >>> 0;
});

function pngCrc32(buffer) {
	let crc = 0xffffffff;
	for (const byte of buffer) {
		crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function makePngChunk(type, data) {
	const typeBuffer = Buffer.from(type, "ascii");
	const chunk = Buffer.alloc(12 + data.length);
	chunk.writeUInt32BE(data.length, 0);
	typeBuffer.copy(chunk, 4);
	data.copy(chunk, 8);
	chunk.writeUInt32BE(
		pngCrc32(Buffer.concat([typeBuffer, data])),
		8 + data.length,
	);
	return chunk;
}

export function makePng(width = 2, height = 3) {
	const signature = Buffer.from([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
	]);
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	const scanlines = Buffer.alloc(height * (1 + width * 4));
	return Buffer.concat([
		signature,
		makePngChunk("IHDR", ihdr),
		makePngChunk("IDAT", deflateSync(scanlines)),
		makePngChunk("IEND", Buffer.alloc(0)),
	]);
}

export function inventoryArticle(overrides = {}) {
	const slug = overrides.slug ?? SAMPLE_SLUG;
	return {
		slug,
		title: overrides.title ?? "Exact Article",
		subtitle: overrides.subtitle ?? SAMPLE_SUBTITLE,
		summary: overrides.summary ?? "A source-confirmed summary.",
		description: overrides.description ?? SAMPLE_SUBTITLE,
		publishedAt: overrides.publishedAt ?? "2025-01-02T03:04:05.000Z",
		communityName: overrides.communityName ?? "Fiction",
		communitySlug: overrides.communitySlug ?? "fiction",
		tags: overrides.tags ?? [],
		publication: overrides.publication ?? {
			platform: "Vocal",
			url: `https://vocal.media/fiction/${slug}`,
		},
		expectedImage: overrides.expectedImage ?? { width: 2, height: 3 },
		legacyPaths: overrides.legacyPaths ?? [],
	};
}

export async function writeRawArticle(
	root,
	article,
	{ html, png = makePng() } = {},
) {
	const rawDirectory = path.join(root, ".proton-import", "raw", article.slug);
	await mkdir(rawDirectory, { recursive: true });
	await writeFile(
		path.join(rawDirectory, "page.html"),
		html ?? (await readFixture()),
	);
	await writeFile(path.join(rawDirectory, "hero-original.png"), png);
}

export async function makeRepository(testContext, options = {}) {
	const root = await mkdtemp(path.join(tmpdir(), "archive-import-test-"));
	testContext.after(async () => {
		await rm(root, { recursive: true, force: true });
	});
	const articles = options.articles ?? [inventoryArticle()];
	const inventory = {
		schemaVersion: 1,
		expectedCount: articles.length,
		articles,
	};
	await mkdir(path.join(root, "provenance", "tai-song"), {
		recursive: true,
	});
	await mkdir(path.join(root, "src", "content", "posts"), {
		recursive: true,
	});
	await writeFile(
		path.join(root, "provenance", "tai-song", "inventory.json"),
		`${JSON.stringify(inventory, null, 2)}\n`,
	);
	if (options.writeRaw !== false) {
		await writeRawArticle(root, articles[0], {
			html: options.html,
			png: options.png,
		});
	}
	return { root, articles, inventory };
}
