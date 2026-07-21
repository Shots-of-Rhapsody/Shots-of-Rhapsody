import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const PAGE_TEMPLATE_PATH = fileURLToPath(
	new URL("./fixtures/valid-page.html", import.meta.url),
);

export const SAMPLE_SLUG = "exact-article";
export const SAMPLE_CAPTURED_AT = "2026-07-21T19:20:21.000Z";

export function makePost(overrides = {}) {
	return {
		id: "post-001",
		name: "Exact & Deliberate",
		subtitle: "Curly quotes, colons: and <characters> remain exact.",
		summary: "A compact test summary.",
		slug: SAMPLE_SLUG,
		publishedAt: "2025-01-02T03:04:05.000Z",
		contentUpdatedAt: "2025-01-03T03:04:05.000Z",
		wordCount: 5,
		author: { name: "Tai Song", privateSibling: "preserved inside post" },
		vocalSite: { name: "Fiction", slug: "fiction" },
		tags: [
			{ name: "Exactness", slug: "exactness" },
			{ name: "Unicode", slug: "unicode" },
		],
		heroImage: {
			id: "https://images.example.test/original.png",
			large: "https://images.example.test/large.png",
			socialMedia: "https://images.example.test/social.png",
		},
		heroImageCaption: "Original caption & credit.",
		heroImageAltText: "A precise test image",
		mediaType: "article",
		content: {
			document: {
				object: "document",
				data: {},
				nodes: [
					{
						object: "block",
						type: "paragraph",
						data: {},
						nodes: [
							{ object: "text", text: "Hello & <world>", marks: [] },
							{
								object: "text",
								text: " boldly",
								marks: [{ type: "italic" }, { type: "bold" }],
							},
						],
					},
				],
			},
			heroImages: [],
			images: [],
			cloudinaryImages: [],
			unsplashImages: [],
			oEmbeds: [],
		},
		unknownPostField: { preserve: true },
		...overrides,
	};
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

export async function makePage(post, pageProps = {}) {
	const template = await readFile(PAGE_TEMPLATE_PATH, "utf8");
	const nextData = {
		props: {
			pageProps: {
				account: { token: "must-not-enter-snapshot" },
				...pageProps,
				post,
			},
		},
	};
	return template.replace("__NEXT_DATA_JSON__", JSON.stringify(nextData));
}

export function inventoryArticle(post, overrides = {}) {
	return {
		slug: post.slug,
		title: post.name,
		sourceUrl: `https://vocal.media/${post.vocalSite.slug}/${post.slug}`,
		communitySlug: post.vocalSite.slug,
		expectedImage: { width: 2, height: 3 },
		...overrides,
	};
}

export async function writeRawArticle(root, post, png = makePng()) {
	const rawDirectory = path.join(root, ".vocal-import", "raw", post.slug);
	await mkdir(rawDirectory, { recursive: true });
	await writeFile(path.join(rawDirectory, "page.html"), await makePage(post));
	await writeFile(path.join(rawDirectory, "hero-original.png"), png);
}

export async function makeRepository(test, options = {}) {
	const root = await mkdtemp(path.join(tmpdir(), "vocal-import-test-"));
	test.after(async () => {
		await rm(root, { recursive: true, force: true });
	});
	const post = options.post ?? makePost();
	const articles = options.articles ?? [inventoryArticle(post)];
	const inventory = {
		schemaVersion: 1,
		expectedCount: articles.length,
		expectedWordCount:
			options.expectedWordCount ??
			articles.reduce((total, article) => {
				return total + (article.slug === post.slug ? post.wordCount : 0);
			}, 0),
		articles,
	};
	const provenanceDirectory = path.join(root, "provenance", "vocal");
	await mkdir(provenanceDirectory, { recursive: true });
	await mkdir(path.join(root, "src", "content", "posts"), { recursive: true });
	await writeFile(
		path.join(provenanceDirectory, "inventory.json"),
		`${JSON.stringify(inventory, null, 2)}\n`,
	);
	if (options.writeRaw !== false) await writeRawArticle(root, post);
	return { root, post, inventory };
}
