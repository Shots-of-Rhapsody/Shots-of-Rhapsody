import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDraft } from "../../content/new.js";
import {
	extractCandidateMetadata,
	extractMediumStoryHtml,
} from "../lib/html.js";
import {
	mediumCandidateSetSha256,
	validateMediumInventory,
	validateMediumManifest,
	validateMediumSnapshot,
} from "../lib/model.js";
import {
	createUnreviewedInventoryCandidates,
	verifyFirstPartyMarkdown,
} from "../lib/pipeline.js";
import { bodyTextSha256, renderMediumBodyHtml } from "../lib/render.js";

const AWAITING_INVENTORY = {
	schemaVersion: 1,
	state: "awaiting-export",
	authority: { platform: "Medium", captureFormat: "account-export-zip" },
	author: {
		name: "Tai Song",
		profileUrl: "https://medium.com/@ShotsOfRhapsody",
	},
	export: null,
	candidateCount: 0,
	candidateSetSha256: null,
	candidates: [],
	expectedCount: 0,
	articles: [],
};

test("awaiting-export inventory is valid but cannot contain candidates", () => {
	assert.equal(
		validateMediumInventory(AWAITING_INVENTORY).state,
		"awaiting-export",
	);
	assert.throws(
		() =>
			validateMediumInventory({
				...AWAITING_INVENTORY,
				expectedCount: 1,
			}),
		/awaiting-export inventory/u,
	);
});

function reviewedInventory(candidate) {
	const digest = `sha256:${"a".repeat(64)}`;
	return {
		schemaVersion: 1,
		state: "reviewed",
		authority: { platform: "Medium", captureFormat: "account-export-zip" },
		author: {
			name: "Tai Song",
			profileUrl: "https://medium.com/@ShotsOfRhapsody",
		},
		export: {
			fileName: "medium-export.zip",
			sha256: digest,
			capturedAt: "2026-07-25T12:00:00.000Z",
		},
		candidateCount: 1,
		candidateSetSha256: mediumCandidateSetSha256([candidate]),
		candidates: [candidate],
		expectedCount: 1,
		articles: [
			{
				slug: "essay",
				title: "Essay",
				subtitle: "",
				summary: "A reviewed summary.",
				description: "A reviewed description.",
				publishedAt: "2026-07-25T12:00:00.000Z",
				canonicalUrl: "https://medium.com/@ShotsOfRhapsody/essay-123",
				sourcePath: "posts/essay.html",
				sourceSha256: digest,
				category: "Nonfiction",
				tags: [],
				classification: {
					visibility: "public",
					authorship: "original",
					format: "standalone",
				},
				assets: [
					{
						id: "hero",
						role: "hero",
						sourceUrl: "https://cdn.example/hero.webp",
						rawFile: "hero-medium.webp",
						siteReadyFile: "hero-sanitized.webp",
						outputFile: "hero.webp",
						sha256: digest,
						acquisitionManifestSha256: digest,
						captureSha256: digest,
						pixelSha256: digest,
						mimeType: "image/webp",
						width: 1200,
						height: 1200,
						byteSize: 123,
						alt: "Hero",
						caption: "",
					},
				],
			},
		],
	};
}

test("reviewed inventory resolves every classification and includes every eligible work", () => {
	const candidate = {
		suggestedSlug: "essay",
		title: "Essay",
		descriptionCandidate: "A reviewed description.",
		publishedAtCandidate: "2026-07-25T12:00:00.000Z",
		canonicalUrlCandidate: "https://medium.com/@ShotsOfRhapsody/essay-123",
		sourcePath: "posts/essay.html",
		sourceSha256: `sha256:${"a".repeat(64)}`,
		include: true,
		exclusionReason: "",
		classification: {
			visibility: "public",
			authorship: "original",
			format: "standalone",
		},
	};
	assert.equal(
		validateMediumInventory(reviewedInventory(candidate)).state,
		"reviewed",
	);
	const missingSanitizedHero = reviewedInventory(candidate);
	delete missingSanitizedHero.articles[0].assets[0].siteReadyFile;
	assert.throws(
		() => validateMediumInventory(missingSanitizedHero),
		/must bind hero-medium\.webp to the separately sanitized hero-sanitized\.webp/u,
	);
	assert.throws(
		() =>
			validateMediumInventory(
				reviewedInventory({
					...candidate,
					include: false,
					exclusionReason: "Omitted despite eligibility.",
				}),
			),
		/include must exactly match/u,
	);
	assert.throws(
		() =>
			validateMediumInventory(
				reviewedInventory({
					...candidate,
					include: false,
					exclusionReason: "Review pending.",
					classification: {
						...candidate.classification,
						visibility: "unknown",
					},
				}),
			),
		/unresolved reviewed classification/u,
	);
	assert.throws(
		() =>
			validateMediumInventory(
				reviewedInventory({
					...candidate,
					publishedAtCandidate: "2026-07-25T12:00:00Z",
				}),
			),
		/canonical UTC/u,
	);
});

test("candidate metadata rejects conflicting title sources", () => {
	assert.throws(
		() =>
			extractCandidateMetadata(
				"<!doctype html><html><head><title>One</title></head><body><h1>Two</h1></body></html>",
				"posts/story.html",
			),
		/title metadata conflicts/u,
	);
});

test("story converter preserves safe structure and rejects active markup", () => {
	const expected = {
		slug: "exact-story",
		title: "Exact Story",
		subtitle: "A subtitle",
	};
	const document = extractMediumStoryHtml(
		`<!doctype html><html><body><article><h1>Exact Story</h1><h2>A subtitle</h2><figure><img src="https://cdn.example/hero.png" alt="Hero"><figcaption>Caption</figcaption></figure><p>Plain <strong>bold</strong>, <em>italic</em>, <a href="https://example.com/path">linked</a> &amp; Unicode — text.<br>Next line.</p><blockquote><p>A quote.</p></blockquote><ol start="2"><li>Second item</li></ol></article></body></html>`,
		expected,
	);
	assert.equal(document.blocks.length, 4);
	assert.equal(document.blocks[1].children[1].marks[0], "bold");
	assert.equal(document.blocks[1].children[5].href, "https://example.com/path");
	assert.throws(
		() =>
			extractMediumStoryHtml(
				"<!doctype html><html><body><h1>Exact Story</h1><h2>A subtitle</h2><script>alert(1)</script></body></html>",
				expected,
			),
		/unsupported block/u,
	);
});

function officialStoryExport({
	title = "Exported Page Title",
	subtitle = "Exported subtitle",
	body = '<p name="1a2b" id="1a2b" class="graf graf--p graf-after--p">Exact body.</p>',
	canonical = "https://medium.com/@ShotsOfRhapsody/exported-page-title-123",
} = {}) {
	const subtitleSection =
		subtitle === null
			? ""
			: `<section data-field="subtitle" class="p-summary">${subtitle}</section>`;
	return `<!doctype html><html><head><title>${title}</title><style>p { color: black; }</style></head><body><article class="h-entry"><header><h1 class="p-name">${title}</h1></header>${subtitleSection}<section data-field="body" class="e-content"><section name="c0de" class="section section--body section--first section--last"><div class="section-divider"><hr class="section-divider"></div><div class="section-content"><div class="section-inner sectionLayout--insetColumn">${body}</div></div></section></section><footer><p>By <a href="https://medium.com/@ShotsOfRhapsody" class="p-author h-card">Tai Song</a> on <a href="https://medium.com/p/123"><time class="dt-published" datetime="2025-04-01T12:00:00.000Z">April 1, 2025</time></a>.</p><p><a href="${canonical}" class="p-canonical">Canonical link</a></p><p><a href="https://medium.com">Exported from Medium</a></p></footer></article></body></html>`;
}

test("official export preserves page title, body headings, structure, links, and Unicode", () => {
	const href =
		"https://example.com/research?utm_source=source.example&section=one";
	const html = officialStoryExport({
		body: [
			'<h2 name="100a" id="100a" class="graf graf--h2 graf--leading graf--title">A Distinct Body Heading</h2>',
			'<h4 name="100b" id="100b" class="graf graf--h4 graf-after--h2 graf--subtitle">A body subheading</h4>',
			`<p name="100c" id="100c" class="graf graf--p graf-after--h4">Plain&nbsp;<strong class="markup--strong markup--p-strong">bold</strong> and <em class="markup--em markup--p-em">italic</em> — text.<br>Next <a href="${href.replace("&", "&amp;")}" data-href="${href.replace("&", "&amp;")}" class="markup--anchor markup--p-anchor" rel="noopener ugc nofollow noopener" target="_blank">linked</a>.</p>`,
			'<figure name="100d" id="100d" class="graf graf--figure graf-after--p"><img class="graf-image" data-image-id="1*hero@2x.jpeg" data-width="1536" data-height="1024" data-is-featured="true" src="https://cdn.example/hero.jpeg"></figure>',
			'<h3 name="100e" id="100e" class="graf graf--h3 graf-after--figure">Later heading</h3>',
			'<ul class="postList"><li name="100f" id="100f" class="graf graf--li graf-after--p"><strong class="markup--strong markup--li-strong">Bullet</strong></li></ul>',
			'<ol class="postList"><li name="101a" id="101a" class="graf graf--li graf-after--li">Numbered</li></ol>',
		].join(""),
	});
	const metadata = extractCandidateMetadata(html, "posts/official.html");
	assert.equal(metadata.title, "Exported Page Title");
	assert.equal(metadata.descriptionCandidate, "Exported subtitle");
	assert.equal(
		metadata.canonicalUrlCandidate,
		"https://medium.com/@ShotsOfRhapsody/exported-page-title-123",
	);
	const document = extractMediumStoryHtml(html, {
		slug: "exported-page-title",
		title: "Exported Page Title",
		subtitle: "Exported subtitle",
	});
	assert.deepEqual(
		document.blocks
			.filter((block) => block.type === "heading")
			.map((block) => [block.level, block.children[0].text]),
		[
			[2, "A Distinct Body Heading"],
			[4, "A body subheading"],
			[3, "Later heading"],
		],
	);
	assert.equal(document.blocks[2].children[0].text, "Plain\u00a0");
	assert.equal(document.blocks[2].children[1].marks[0], "bold");
	assert.equal(document.blocks[2].children[3].marks[0], "italic");
	assert.equal(document.blocks[2].children[5].type, "break");
	assert.equal(document.blocks[2].children[7].href, href);
	assert.equal(document.blocks[3].sourceUrl, "https://cdn.example/hero.jpeg");
	assert.equal(document.blocks[5].ordered, false);
	assert.equal(document.blocks[6].ordered, true);
});

test("official export removes only a metadata-matching presentation shell", () => {
	const body = [
		'<h2 name="100a" id="100a" class="graf graf--h2 graf--leading graf--title">Exported Page&nbsp;Title</h2>',
		'<h4 name="100b" id="100b" class="graf graf--h4 graf-after--h2 graf--subtitle">Exported subtitle</h4>',
		'<p name="100c" id="100c" class="graf graf--p graf-after--h4">First authored paragraph.</p>',
	].join("");
	const document = extractMediumStoryHtml(officialStoryExport({ body }), {
		slug: "exported-page-title",
		title: "Exported Page Title",
		subtitle: "Exported subtitle",
	});
	assert.deepEqual(document.blocks, [
		{
			type: "paragraph",
			children: [
				{ type: "text", text: "First authored paragraph.", marks: [] },
			],
		},
	]);
});

test("official export keeps a distinct authored subtitle after a duplicate title", () => {
	const body = [
		'<h2 name="100a" id="100a" class="graf graf--h2 graf--leading graf--title">Exported Page Title</h2>',
		'<h4 name="100b" id="100b" class="graf graf--h4 graf-after--h2 graf--subtitle">A distinct authored body subtitle</h4>',
		'<p name="100c" id="100c" class="graf graf--p graf-after--h4">First authored paragraph.</p>',
	].join("");
	const document = extractMediumStoryHtml(officialStoryExport({ body }), {
		slug: "exported-page-title",
		title: "Exported Page Title",
		subtitle: "Exported subtitle",
	});
	assert.equal(document.blocks[0].type, "heading");
	assert.equal(document.blocks[0].level, 4);
	assert.equal(
		document.blocks[0].children[0].text,
		"A distinct authored body subtitle",
	);
});

test("official export supports an explicitly absent subtitle", () => {
	const html = officialStoryExport({ subtitle: null });
	const metadata = extractCandidateMetadata(html, "posts/no-subtitle.html");
	assert.equal(metadata.descriptionCandidate, null);
	assert.doesNotThrow(() =>
		extractMediumStoryHtml(html, {
			slug: "exported-page-title",
			title: "Exported Page Title",
			subtitle: "",
		}),
	);
});

test("official export recovers its leading h4 subtitle when p-summary is absent", () => {
	const body = [
		'<h2 name="100a" id="100a" class="graf graf--h2 graf--leading graf--title">Exported Page&nbsp;Title</h2>',
		'<h4 name="100b" id="100b" class="graf graf--h4 graf-after--h2 graf--subtitle">Recovered subtitle</h4>',
		'<p name="100c" id="100c" class="graf graf--p graf-after--h4">First authored paragraph.</p>',
	].join("");
	const html = officialStoryExport({ subtitle: null, body });
	const metadata = extractCandidateMetadata(
		html,
		"posts/recovered-subtitle.html",
	);
	assert.equal(metadata.descriptionCandidate, "Recovered subtitle");
	const document = extractMediumStoryHtml(html, {
		slug: "exported-page-title",
		title: "Exported Page Title",
		subtitle: "Recovered subtitle",
	});
	assert.equal(document.blocks.length, 1);
	assert.equal(
		document.blocks[0].children[0].text,
		"First authored paragraph.",
	);
	assert.throws(
		() =>
			extractMediumStoryHtml(html, {
				slug: "exported-page-title",
				title: "Exported Page Title",
				subtitle: "Different subtitle",
			}),
		/missing its reviewed subtitle/u,
	);
});

test("official export envelope and generated attributes fail closed", () => {
	const expected = {
		slug: "exported-page-title",
		title: "Exported Page Title",
		subtitle: "Exported subtitle",
	};
	for (const body of [
		'<div class="unknown"><p>Wrapped.</p></div>',
		"<script>alert(1)</script>",
		'<h2 name="1a2b" id="1a2b" class="graf graf--h2 graf--leading graf--title" onclick="alert(1)">Exported Page Title</h2>',
		'<p name="1a2b" id="1a2b" class="graf graf--p graf-after--p" onclick="alert(1)">Active.</p>',
		'<p name="1a2b" id="1a2b" class="graf graf--p graf-after--p"><a href="javascript:alert(1)" data-href="javascript:alert(1)" class="markup--anchor markup--p-anchor" rel="noopener" target="_blank">Unsafe</a></p>',
	]) {
		assert.throws(
			() => extractMediumStoryHtml(officialStoryExport({ body }), expected),
			/unsupported|keys|HTTPS/u,
		);
	}
	assert.throws(
		() =>
			extractMediumStoryHtml(
				officialStoryExport().replace(
					"</header>",
					"</header><aside>Unknown sibling</aside>",
				),
				expected,
			),
		/missing its reviewed subtitle|missing its body section/u,
	);
});

test("response-like exports remain unresolved inventory candidates", () => {
	const responseLikeTitles = Array.from(
		{ length: 9 },
		(_value, index) => `A thoughtful response ${index + 1}.`,
	);
	const entries = new Map(
		responseLikeTitles.map((title, index) => [
			`posts/response-${index + 1}.html`,
			Buffer.from(officialStoryExport({ title, subtitle: null }), "utf8"),
		]),
	);
	const candidates = createUnreviewedInventoryCandidates(entries);
	assert.equal(candidates.length, 9);
	for (const [index, candidate] of candidates.entries()) {
		assert.equal(candidate.title, responseLikeTitles[index]);
		assert.equal(candidate.include, null);
		assert.equal(candidate.exclusionReason, "");
		assert.deepEqual(candidate.classification, {
			visibility: null,
			authorship: null,
			format: null,
		});
	}
});

function textToken(text) {
	return { type: "text", text, marks: [] };
}

function bodyImageAsset(overrides = {}) {
	return {
		id: "diagram-one",
		role: "body",
		sourceUrl: "https://cdn.example/diagram.png",
		rawFile: "diagram.png",
		outputFile: "diagram.png",
		sha256: `sha256:${"b".repeat(64)}`,
		mimeType: "image/png",
		width: 1200,
		height: 800,
		byteSize: 456,
		alt: 'Ink & "paper" — detail',
		caption: "Exact caption & Unicode — preserved.",
		...overrides,
	};
}

function bodyImageDocument(overrides = {}) {
	return {
		blocks: [
			{
				type: "figure",
				sourceUrl: "https://cdn.example/diagram.png",
				alt: 'Ink & "paper" — detail',
				caption: [textToken("Exact caption & Unicode — preserved.")],
				...overrides,
			},
		],
	};
}

test("Medium body images render one deterministic responsive asset family", () => {
	const document = bodyImageDocument();
	const bodyHash = bodyTextSha256(document);
	const bodyHtml = renderMediumBodyHtml(
		document,
		[bodyImageAsset()],
		"exact-story",
	);
	assert.equal(
		bodyHtml,
		[
			'<figure data-writing-asset-id="exact-story/diagram-one">',
			"<picture>",
			'<source type="image/avif" srcset="../../media/writing/exact-story/diagram-one-320.avif 320w, ../../media/writing/exact-story/diagram-one-480.avif 480w, ../../media/writing/exact-story/diagram-one-640.avif 640w, ../../media/writing/exact-story/diagram-one-960.avif 960w, ../../media/writing/exact-story/diagram-one-1200.avif 1200w" sizes="(max-width: 767px) calc(100vw - 2rem), 66ch" />',
			'<source type="image/webp" srcset="../../media/writing/exact-story/diagram-one-320.webp 320w, ../../media/writing/exact-story/diagram-one-480.webp 480w, ../../media/writing/exact-story/diagram-one-640.webp 640w, ../../media/writing/exact-story/diagram-one-960.webp 960w, ../../media/writing/exact-story/diagram-one-1200.webp 1200w" sizes="(max-width: 767px) calc(100vw - 2rem), 66ch" />',
			'<img src="../../media/writing/exact-story/diagram-one-1200.webp" srcset="../../media/writing/exact-story/diagram-one-320.webp 320w, ../../media/writing/exact-story/diagram-one-480.webp 480w, ../../media/writing/exact-story/diagram-one-640.webp 640w, ../../media/writing/exact-story/diagram-one-960.webp 960w, ../../media/writing/exact-story/diagram-one-1200.webp 1200w" sizes="(max-width: 767px) calc(100vw - 2rem), 66ch" width="1200" height="800" alt="Ink &amp; &quot;paper&quot; — detail" loading="lazy" decoding="async" aria-describedby="writing-asset-exact-story-diagram-one-caption" />',
			"</picture>",
			'<figcaption id="writing-asset-exact-story-diagram-one-caption">Exact caption &amp; Unicode — preserved.</figcaption>',
			"</figure>",
		].join("\n"),
	);
	assert.doesNotMatch(bodyHtml, /(?:src|srcset)="(?:\.\/|\/)/u);
	assert.equal(bodyTextSha256(document), bodyHash);
});

test("Medium body image rendering fails closed on ambiguous assets", () => {
	const document = bodyImageDocument();
	const asset = bodyImageAsset();
	assert.throws(
		() => renderMediumBodyHtml(document, [asset], "../escape"),
		/article slug/u,
	);
	assert.throws(
		() => renderMediumBodyHtml(document, [], "exact-story"),
		/No reviewed local asset/u,
	);
	assert.throws(
		() =>
			renderMediumBodyHtml(
				{
					blocks: [document.blocks[0], { ...document.blocks[0] }],
				},
				[asset],
				"exact-story",
			),
		/rendered more than once/u,
	);
	assert.throws(
		() =>
			renderMediumBodyHtml(
				{ blocks: [{ type: "paragraph", children: [textToken("Text")] }] },
				[asset],
				"exact-story",
			),
		/not rendered exactly once/u,
	);
	assert.throws(
		() =>
			renderMediumBodyHtml(
				bodyImageDocument({ alt: "Changed" }),
				[asset],
				"exact-story",
			),
		/alt text or caption differs/u,
	);
	assert.throws(
		() =>
			renderMediumBodyHtml(
				bodyImageDocument({
					caption: [{ type: "text", text: asset.caption, marks: ["italic"] }],
				}),
				[asset],
				"exact-story",
			),
		/exact unmarked caption text/u,
	);
	assert.throws(
		() =>
			renderMediumBodyHtml(
				document,
				[asset, { ...asset, id: "diagram-two" }],
				"exact-story",
			),
		/unique IDs and source URLs/u,
	);
	assert.throws(
		() =>
			renderMediumBodyHtml(document, [{ ...asset, width: 0 }], "exact-story"),
		/positive safe integer/u,
	);
});

test("Medium body derivatives never upscale or exceed 2048 pixels", () => {
	const smaller = renderMediumBodyHtml(
		bodyImageDocument(),
		[bodyImageAsset({ width: 240, height: 160 })],
		"small-story",
	);
	assert.match(smaller, /diagram-one-240\.avif 240w/u);
	assert.doesNotMatch(smaller, /diagram-one-320\./u);

	const larger = renderMediumBodyHtml(
		bodyImageDocument(),
		[bodyImageAsset({ width: 3000, height: 2000 })],
		"large-story",
	);
	assert.match(larger, /diagram-one-2048\.avif 2048w/u);
	assert.doesNotMatch(larger, /diagram-one-3000\.(?:avif|webp)/u);
	assert.match(larger, /width="3000" height="2000"/u);
});

test("Medium body images preserve nullable alt and empty captions", () => {
	const bodyHtml = renderMediumBodyHtml(
		bodyImageDocument({ alt: "", caption: [] }),
		[bodyImageAsset({ alt: null, caption: "" })],
		"decorative-story",
	);
	assert.match(bodyHtml, / alt="" loading="lazy" decoding="async"/u);
	assert.doesNotMatch(bodyHtml, /aria-describedby|figcaption/u);
	assert.equal(
		renderMediumBodyHtml(
			{ blocks: [{ type: "paragraph", children: [textToken("Text")] }] },
			[],
			"text-only-story",
		),
		"<p>Text</p>",
	);
});

test("Medium snapshot validation binds body image URLs to its article slug", () => {
	const digest = `sha256:${"a".repeat(64)}`;
	const hero = {
		id: "hero",
		role: "hero",
		sourceUrl: "https://cdn.example/hero.webp",
		rawFile: "hero-medium.webp",
		siteReadyFile: "hero-sanitized.webp",
		outputFile: "hero.webp",
		sha256: digest,
		acquisitionManifestSha256: digest,
		captureSha256: digest,
		pixelSha256: digest,
		mimeType: "image/webp",
		width: 1200,
		height: 1200,
		byteSize: 123,
		alt: "Hero",
		caption: "Hero caption",
	};
	const bodyAsset = bodyImageAsset();
	const inventoryArticle = {
		slug: "exact-story",
		title: "Exact Story",
		subtitle: "",
		summary: "A reviewed summary.",
		description: "A reviewed description.",
		publishedAt: "2026-07-25T12:00:00.000Z",
		canonicalUrl: "https://medium.com/@ShotsOfRhapsody/exact-story-123",
		sourcePath: "posts/exact-story.html",
		sourceSha256: digest,
		category: "Nonfiction",
		tags: [],
		assets: [hero, bodyAsset],
	};
	const bodyDocument = bodyImageDocument();
	const snapshot = {
		schemaVersion: 1,
		slug: inventoryArticle.slug,
		title: inventoryArticle.title,
		subtitle: inventoryArticle.subtitle,
		summary: inventoryArticle.summary,
		description: inventoryArticle.description,
		author: "Tai Song",
		published: inventoryArticle.publishedAt,
		category: inventoryArticle.category,
		tags: [],
		imageAlt: hero.alt,
		imageCaption: hero.caption,
		provenance: {
			authority: "Medium account export",
			captureFormat: "account-export-html",
			capturedAt: "2026-07-25T12:00:00.000Z",
			sourcePath: inventoryArticle.sourcePath,
			sourceSha256: digest,
			canonicalUrl: inventoryArticle.canonicalUrl,
		},
		hero: {
			id: hero.id,
			outputFile: hero.outputFile,
			sha256: hero.sha256,
			acquisitionManifestSha256: hero.acquisitionManifestSha256,
			captureSha256: hero.captureSha256,
			pixelSha256: hero.pixelSha256,
			mimeType: hero.mimeType,
			width: hero.width,
			height: hero.height,
			byteSize: hero.byteSize,
		},
		assets: inventoryArticle.assets,
		bodyDocument,
		bodyHtml: renderMediumBodyHtml(
			bodyDocument,
			[bodyAsset],
			inventoryArticle.slug,
		),
		bodyTextSha256: bodyTextSha256(bodyDocument),
		bodyBlockCount: 1,
		license: { name: "All Rights Reserved" },
	};
	assert.doesNotThrow(() => validateMediumSnapshot(snapshot, inventoryArticle));
	assert.throws(
		() =>
			validateMediumSnapshot(
				{
					...snapshot,
					bodyHtml: renderMediumBodyHtml(
						bodyDocument,
						[bodyAsset],
						"other-story",
					),
				},
				inventoryArticle,
			),
		/snapshot body metadata is not deterministic/u,
	);
});

test("draft creation is unpublished and refuses overwrite", async (context) => {
	const root = await mkdtemp(path.join(os.tmpdir(), "shots-content-new-"));
	context.after(() => rm(root, { recursive: true, force: true }));
	const target = await createDraft({
		repoRoot: root,
		section: "nonfiction",
		slug: "future-essay",
		date: "2026-07-25",
	});
	assert.match(await readFile(target, "utf8"), /draft: true/u);
	await assert.rejects(
		createDraft({
			repoRoot: root,
			section: "nonfiction",
			slug: "future-essay",
			date: "2026-07-25",
		}),
		/Refusing duplicate content slug/u,
	);
});

test("draft creation rejects impossible UTC dates", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "shots-content-date-"));
	try {
		await assert.rejects(
			createDraft({
				repoRoot: root,
				section: "fiction",
				slug: "impossible-date",
				date: "2026-02-30",
			}),
			/date must use YYYY-MM-DD/u,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("first-party publication binds the exact source bytes and refuses drafts", () => {
	const published = Buffer.from(
		'---\nimage: "./hero.png"\ndraft: false\n---\n\nExact text.\n',
		"utf8",
	);
	const digest = `sha256:${createHash("sha256").update(published).digest("hex")}`;
	const article = {
		slug: "exact-story",
		hashes: { source: digest, output: digest },
		assets: [{ role: "hero", path: "src/content/posts/exact-story/hero.png" }],
	};
	assert.equal(verifyFirstPartyMarkdown(article, published), digest);
	const draft = Buffer.from(
		'---\nimage: "./hero.png"\ndraft: true\n---\n\nExact text.\n',
		"utf8",
	);
	const draftDigest = `sha256:${createHash("sha256").update(draft).digest("hex")}`;
	assert.throws(
		() =>
			verifyFirstPartyMarkdown(
				{
					...article,
					hashes: { source: draftDigest, output: draftDigest },
				},
				draft,
			),
		/draft: false/u,
	);
	assert.throws(
		() =>
			verifyFirstPartyMarkdown(
				{
					...article,
					hashes: {
						source: `sha256:${"f".repeat(64)}`,
						output: digest,
					},
				},
				published,
			),
		/source hash differs/u,
	);
	assert.throws(
		() =>
			verifyFirstPartyMarkdown(
				{
					...article,
					hashes: {
						source: `sha256:${createHash("sha256")
							.update(
								published.toString("utf8").replace("hero.png", "other.png"),
							)
							.digest("hex")}`,
						output: `sha256:${createHash("sha256")
							.update(
								published.toString("utf8").replace("hero.png", "other.png"),
							)
							.digest("hex")}`,
					},
				},
				Buffer.from(
					published.toString("utf8").replace("hero.png", "other.png"),
					"utf8",
				),
			),
		/approved hero/u,
	);
});

test("Medium manifest rejects duplicate or non-image assets", () => {
	const digest = `sha256:${"a".repeat(64)}`;
	const hero = {
		id: "hero",
		role: "hero",
		path: "src/content/posts/essay/hero.png",
		sha256: digest,
		acquisitionManifestSha256: digest,
		captureSha256: digest,
		pixelSha256: digest,
		mimeType: "image/png",
		width: 1200,
		height: 1200,
		byteSize: 123,
	};
	const base = {
		schemaVersion: 1,
		state: "active",
		authority: { platform: "Medium", captureFormat: "account-export-zip" },
		author: {
			name: "Tai Song",
			profileUrl: "https://medium.com/@ShotsOfRhapsody",
		},
		inventoryPath: "provenance/medium/inventory.json",
		inventorySha256: digest,
		articles: [
			{
				slug: "essay",
				capturedAt: "2026-07-25T12:00:00.000Z",
				canonicalUrl: "https://medium.com/@ShotsOfRhapsody/essay-123",
				paths: {
					snapshot: "provenance/medium/posts/essay.json",
					markdown: "src/content/posts/essay/index.md",
				},
				hashes: {
					rawExport: digest,
					rawSource: digest,
					snapshot: digest,
					markdown: digest,
					bodyText: digest,
				},
				content: { title: "Essay", subtitle: "", bodyBlockCount: 1 },
				assets: [hero],
			},
		],
	};
	assert.doesNotThrow(() => validateMediumManifest(base));
	assert.throws(
		() =>
			validateMediumManifest({
				...base,
				articles: [{ ...base.articles[0], assets: [hero, hero] }],
			}),
		/repeats id|exactly one hero/u,
	);
	assert.throws(
		() =>
			validateMediumManifest({
				...base,
				articles: [
					{
						...base.articles[0],
						assets: [{ ...hero, role: "embed", mimeType: "text/html" }],
					},
				],
			}),
		/role must be hero or body/u,
	);
});
