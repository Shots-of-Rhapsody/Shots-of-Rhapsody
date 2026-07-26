import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { serializeJson } from "../../medium/lib/contract.js";
import { sha256 } from "../../medium/lib/integrity.js";
import {
	mediumCandidateSetSha256,
	mediumPresentationSetSha256,
} from "../../medium/lib/model.js";
import {
	bodyTextSha256,
	renderMediumBodyHtml,
	renderMediumIndexMarkdown,
} from "../../medium/lib/render.js";
import {
	createProtonMasterPackage,
	loadMediumMasterEvidence,
	PROTON_ARCHIVE_CONTRACT,
	renderProtonMasterHtml,
	verifyProtonMasterExport,
} from "../proton-master.js";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const SOURCE_URL = "https://cdn.example/hero.webp";
const BODY_IMAGE_URL = "https://cdn.example/diagram.png";

function textToken(text, marks = [], href = undefined) {
	return {
		type: "text",
		text,
		marks,
		...(href === undefined ? {} : { href }),
	};
}

const BODY_DOCUMENT = {
	blocks: [
		{
			type: "heading",
			level: 3,
			children: [textToken("First Header — exact")],
		},
		{
			type: "paragraph",
			children: [
				textToken("Unicode and "),
				textToken("bold", ["bold"]),
				textToken(", "),
				textToken("italic", ["italic"]),
				{ type: "break" },
				textToken("linked", [], "https://example.com/exact?q=1&x=2"),
			],
		},
		{
			type: "figure",
			sourceUrl: BODY_IMAGE_URL,
			alt: "Exact diagram alt",
			caption: [textToken("Diagram caption.")],
		},
		{ type: "paragraph", children: [] },
		{
			type: "blockquote",
			blocks: [
				{
					type: "paragraph",
					children: [textToken("Quoted — exactly.")],
				},
			],
		},
		{
			type: "list",
			ordered: false,
			start: 1,
			items: [
				[{ type: "paragraph", children: [textToken("First item")] }],
				[{ type: "paragraph", children: [textToken("Second item")] }],
			],
		},
		{
			type: "list",
			ordered: true,
			start: 3,
			items: [[{ type: "paragraph", children: [textToken("Third")] }]],
		},
		{ type: "thematicBreak" },
		{ type: "codeBlock", text: "exact <code> & Unicode λ" },
	],
};

async function decodedPixelSha256(buffer) {
	const pixels = await sharp(buffer)
		.toColourspace("srgb")
		.ensureAlpha()
		.raw({ depth: "uchar" })
		.toBuffer();
	return sha256(pixels);
}

async function writeCanonicalJson(filePath, value) {
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, serializeJson(value), { flag: "wx" });
}

async function createFixture(context) {
	const root = await mkdtemp(path.join(os.tmpdir(), "shots-proton-master-"));
	context.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(path.join(root, ".medium-import"), { recursive: true });

	const hero = await sharp({
		create: {
			width: 3,
			height: 2,
			channels: 4,
			background: { r: 36, g: 91, b: 78, alpha: 0.75 },
		},
	})
		.webp({ lossless: true })
		.toBuffer();
	const heroSha256 = sha256(hero);
	const heroPixelSha256 = await decodedPixelSha256(hero);
	const bodyImage = await sharp({
		create: {
			width: 2,
			height: 1,
			channels: 4,
			background: { r: 172, g: 85, b: 72, alpha: 1 },
		},
	})
		.png()
		.toBuffer();
	const sourceSha256 = sha256(Buffer.from("official export article", "utf8"));
	const candidate = {
		suggestedSlug: "exact-essay",
		title: "Exported Headline — Exact",
		descriptionCandidate: "Exported summary with Unicode.",
		exportSummaryCandidate: "Exported summary with Unicode.",
		displayTitleCandidate: "Origins & Orders",
		displaySubtitleCandidate: "Meaning and measurement collide.",
		seriesLineCandidate: "A Ledger Series article on exact source structure.",
		publishedAtCandidate: "2026-07-25T12:00:00.000Z",
		canonicalUrlCandidate:
			"https://medium.com/@ShotsOfRhapsody/exact-essay-123",
		sourcePath: "posts/exact-essay.html",
		sourceSha256,
		include: true,
		exclusionReason: "",
		classification: {
			visibility: "public",
			authorship: "original",
			format: "standalone",
		},
	};
	const presentationSetVersion = 1;
	const presentationSetSha256 = mediumPresentationSetSha256([candidate]);
	const heroAsset = {
		id: "hero",
		role: "hero",
		sourceUrl: SOURCE_URL,
		rawFile: "hero-medium.webp",
		siteReadyFile: "hero-sanitized.webp",
		outputFile: "hero.webp",
		sha256: heroSha256,
		acquisitionManifestSha256: DIGEST_A,
		captureSha256: DIGEST_A,
		pixelSha256: heroPixelSha256,
		mimeType: "image/webp",
		width: 3,
		height: 2,
		byteSize: hero.byteLength,
		alt: "Celadon field — exact",
		caption: "Exact hero caption.",
	};
	const bodyAsset = {
		id: "diagram",
		role: "body",
		sourceUrl: BODY_IMAGE_URL,
		rawFile: "diagram-source.png",
		outputFile: "diagram.png",
		sha256: sha256(bodyImage),
		mimeType: "image/png",
		width: 2,
		height: 1,
		byteSize: bodyImage.byteLength,
		alt: "Exact diagram alt",
		caption: "Diagram caption.",
	};
	const article = {
		slug: "exact-essay",
		exportTitle: candidate.title,
		exportSummary: candidate.exportSummaryCandidate,
		title: candidate.displayTitleCandidate,
		subtitle: candidate.displaySubtitleCandidate,
		seriesLine: candidate.seriesLineCandidate,
		summary: candidate.exportSummaryCandidate,
		description: candidate.exportSummaryCandidate,
		publishedAt: candidate.publishedAtCandidate,
		canonicalUrl: candidate.canonicalUrlCandidate,
		sourcePath: candidate.sourcePath,
		sourceSha256,
		category: "Nonfiction",
		tags: ["Exactness"],
		classification: candidate.classification,
		assets: [heroAsset, bodyAsset],
	};
	const inventory = {
		schemaVersion: 1,
		state: "reviewed",
		authority: { platform: "Medium", captureFormat: "account-export-zip" },
		author: {
			name: "Tai Song",
			profileUrl: "https://medium.com/@ShotsOfRhapsody",
		},
		export: {
			fileName: "medium-export.zip",
			sha256: DIGEST_A,
			capturedAt: "2026-07-25T12:00:00.000Z",
		},
		candidateCount: 1,
		candidateSetSha256: mediumCandidateSetSha256([candidate]),
		presentationSetVersion,
		presentationSetSha256,
		candidates: [candidate],
		expectedCount: 1,
		articles: [article],
	};
	const inventoryBuffer = Buffer.from(serializeJson(inventory), "utf8");
	await writeCanonicalJson(
		path.join(root, "provenance", "medium", "inventory.json"),
		inventory,
	);
	const snapshot = {
		schemaVersion: 1,
		slug: article.slug,
		exportTitle: article.exportTitle,
		exportSummary: article.exportSummary,
		title: article.title,
		subtitle: article.subtitle,
		seriesLine: article.seriesLine,
		summary: article.summary,
		description: article.description,
		author: "Tai Song",
		published: article.publishedAt,
		category: article.category,
		tags: article.tags,
		imageAlt: heroAsset.alt,
		imageCaption: heroAsset.caption,
		provenance: {
			authority: "Medium account export",
			captureFormat: "account-export-html",
			capturedAt: "2026-07-25T12:00:00.000Z",
			sourcePath: article.sourcePath,
			sourceSha256,
			canonicalUrl: article.canonicalUrl,
			presentationSetVersion,
			presentationSetSha256,
		},
		hero: {
			id: heroAsset.id,
			outputFile: heroAsset.outputFile,
			sha256: heroAsset.sha256,
			acquisitionManifestSha256: heroAsset.acquisitionManifestSha256,
			captureSha256: heroAsset.captureSha256,
			pixelSha256: heroAsset.pixelSha256,
			mimeType: heroAsset.mimeType,
			width: heroAsset.width,
			height: heroAsset.height,
			byteSize: heroAsset.byteSize,
		},
		assets: [heroAsset, bodyAsset],
		bodyDocument: BODY_DOCUMENT,
		bodyHtml: renderMediumBodyHtml(BODY_DOCUMENT, [bodyAsset], article.slug),
		bodyTextSha256: bodyTextSha256(BODY_DOCUMENT),
		bodyBlockCount: BODY_DOCUMENT.blocks.length,
		license: { name: "All Rights Reserved" },
	};
	const snapshotBuffer = Buffer.from(serializeJson(snapshot), "utf8");
	const markdownBuffer = Buffer.from(
		renderMediumIndexMarkdown(snapshot),
		"utf8",
	);
	const snapshotPath = path.join(
		root,
		"provenance",
		"medium",
		"posts",
		"exact-essay.json",
	);
	const markdownPath = path.join(
		root,
		"src",
		"content",
		"posts",
		"exact-essay",
		"index.md",
	);
	const heroPath = path.join(
		root,
		"src",
		"content",
		"posts",
		"exact-essay",
		"hero.webp",
	);
	const bodyImagePath = path.join(
		root,
		"src",
		"content",
		"posts",
		"exact-essay",
		"diagram.png",
	);
	await mkdir(path.dirname(snapshotPath), { recursive: true });
	await mkdir(path.dirname(markdownPath), { recursive: true });
	await writeFile(snapshotPath, snapshotBuffer);
	await writeFile(markdownPath, markdownBuffer);
	await writeFile(heroPath, hero);
	await writeFile(bodyImagePath, bodyImage);
	const manifest = {
		schemaVersion: 1,
		state: "active",
		authority: { platform: "Medium", captureFormat: "account-export-zip" },
		author: {
			name: "Tai Song",
			profileUrl: "https://medium.com/@ShotsOfRhapsody",
		},
		inventoryPath: "provenance/medium/inventory.json",
		inventorySha256: sha256(inventoryBuffer),
		presentationSetVersion,
		presentationSetSha256,
		articles: [
			{
				slug: article.slug,
				capturedAt: "2026-07-25T12:00:00.000Z",
				canonicalUrl: article.canonicalUrl,
				paths: {
					snapshot: "provenance/medium/posts/exact-essay.json",
					markdown: "src/content/posts/exact-essay/index.md",
				},
				hashes: {
					rawExport: inventory.export.sha256,
					rawSource: sourceSha256,
					snapshot: sha256(snapshotBuffer),
					markdown: sha256(markdownBuffer),
					bodyText: snapshot.bodyTextSha256,
				},
				content: {
					title: article.title,
					subtitle: article.subtitle,
					seriesLine: article.seriesLine,
					bodyBlockCount: snapshot.bodyBlockCount,
				},
				assets: [
					{
						id: heroAsset.id,
						role: heroAsset.role,
						path: "src/content/posts/exact-essay/hero.webp",
						sha256: heroAsset.sha256,
						acquisitionManifestSha256: heroAsset.acquisitionManifestSha256,
						captureSha256: heroAsset.captureSha256,
						pixelSha256: heroAsset.pixelSha256,
						mimeType: heroAsset.mimeType,
						width: heroAsset.width,
						height: heroAsset.height,
						byteSize: heroAsset.byteSize,
					},
					{
						id: bodyAsset.id,
						role: bodyAsset.role,
						path: "src/content/posts/exact-essay/diagram.png",
						sha256: bodyAsset.sha256,
						mimeType: bodyAsset.mimeType,
						width: bodyAsset.width,
						height: bodyAsset.height,
						byteSize: bodyAsset.byteSize,
					},
				],
			},
		],
	};
	await writeCanonicalJson(
		path.join(root, "provenance", "medium", "manifest.json"),
		manifest,
	);
	return { root, hero, snapshot };
}

async function writeExport(root, name, bytes) {
	const target = path.join(root, ".medium-import", "proton-exports", name);
	await mkdir(path.dirname(target), { recursive: true });
	await writeFile(target, bytes);
	return target;
}

test("Proton master package is deterministic, ignored, and no-overwrite", async (context) => {
	const fixture = await createFixture(context);
	assert.deepEqual(PROTON_ARCHIVE_CONTRACT, {
		parent: "Blogging",
		fiction: "Fiction",
		nonfiction: "Non-Fiction",
		fictionPolicy: "unchanged",
		nonfictionLayout: "flat",
	});
	const dryRun = await createProtonMasterPackage({
		repoRoot: fixture.root,
		slug: "exact-essay",
	});
	assert.equal(dryRun.mode, "dry-run");
	assert.equal(dryRun.destination, "Blogging/Non-Fiction");
	await assert.rejects(
		readFile(
			path.join(
				fixture.root,
				".medium-import",
				"proton-masters",
				"exact-essay",
				"master.html",
			),
		),
		/ENOENT/u,
	);
	const written = await createProtonMasterPackage({
		repoRoot: fixture.root,
		slug: "exact-essay",
		write: true,
	});
	const output = await readFile(
		path.join(fixture.root, ...written.outputPath.split("/")),
	);
	assert.equal(sha256(output), dryRun.sha256);
	assert.match(output.toString("utf8"), /Exported Headline — Exact/u);
	assert.match(output.toString("utf8"), /data:image\/webp;base64,/u);
	assert.match(output.toString("utf8"), /data:image\/png;base64,/u);
	assert.doesNotMatch(output.toString("utf8"), /proton(?:\.me|usercontent)/iu);
	assert.doesNotMatch(output.toString("utf8"), /https:\/\/cdn\.example/u);
	await assert.rejects(
		createProtonMasterPackage({
			repoRoot: fixture.root,
			slug: "exact-essay",
			write: true,
		}),
		/already exists/u,
	);
});

test("Proton HTML verification preserves the full semantic document", async (context) => {
	const fixture = await createFixture(context);
	const evidence = await loadMediumMasterEvidence({
		repoRoot: fixture.root,
		slug: "exact-essay",
	});
	const master = renderProtonMasterHtml(evidence);
	const exportPath = await writeExport(
		fixture.root,
		"exact-essay.html",
		master,
	);
	const result = await verifyProtonMasterExport({
		repoRoot: fixture.root,
		slug: "exact-essay",
		exportPath,
	});
	assert.equal(result.verified, true);
	assert.equal(result.bodyBlockCount, BODY_DOCUMENT.blocks.length);
	assert.equal(result.heroPixelSha256, evidence.hero.pixelSha256);

	const png = await sharp(fixture.hero).png().toBuffer();
	const pngDataUrl = `data:image/png;base64,${png.toString("base64")}`;
	const reencoded = master
		.toString("utf8")
		.replace(/data:image\/webp;base64,[A-Za-z0-9+/=]+/u, pngDataUrl);
	const reencodedPath = await writeExport(
		fixture.root,
		"exact-essay-reencoded.html",
		reencoded,
	);
	await assert.doesNotReject(
		verifyProtonMasterExport({
			repoRoot: fixture.root,
			slug: "exact-essay",
			exportPath: reencodedPath,
		}),
	);
});

test("Proton verification fails closed on semantic or image drift", async (context) => {
	const fixture = await createFixture(context);
	const evidence = await loadMediumMasterEvidence({
		repoRoot: fixture.root,
		slug: "exact-essay",
	});
	const master = renderProtonMasterHtml(evidence).toString("utf8");
	const mutations = [
		[
			"headline.html",
			master.replace(">Exported Headline — Exact</h1>", ">Changed</h1>"),
		],
		["mark.html", master.replace("<strong>bold</strong>", "<em>bold</em>")],
		["link.html", master.replace("?q=1&amp;x=2", "?q=2&amp;x=2")],
		["list.html", master.replace("<ul>", "<ol>").replace("</ul>", "</ol>")],
		["unicode.html", master.replace("Unicode and", "Unicode and")],
		[
			"order.html",
			master.replace(
				'<p data-shots-role="authored-subtitle">Meaning and measurement collide.</p>\n<p data-shots-role="series-line">A Ledger Series article on exact source structure.</p>',
				'<p data-shots-role="series-line">A Ledger Series article on exact source structure.</p>\n<p data-shots-role="authored-subtitle">Meaning and measurement collide.</p>',
			),
		],
		[
			"remote.html",
			master.replace(
				/data:image\/webp;base64,[A-Za-z0-9+/=]+/u,
				"https://docs.proton.me/private-document-id",
			),
		],
	];
	for (const [name, html] of mutations) {
		const exportPath = await writeExport(fixture.root, name, html);
		await assert.rejects(
			verifyProtonMasterExport({
				repoRoot: fixture.root,
				slug: "exact-essay",
				exportPath,
			}),
			/Proton HTML export|Proton URL|network/u,
		);
	}
});

test("Proton verifier rejects placeholders and non-ignored paths", async (context) => {
	const fixture = await createFixture(context);
	const placeholder = await writeExport(
		fixture.root,
		"empty.protondoc",
		Buffer.alloc(0),
	);
	await assert.rejects(
		verifyProtonMasterExport({
			repoRoot: fixture.root,
			slug: "exact-essay",
			exportPath: placeholder,
		}),
		/Zero-byte \.protondoc sync placeholders/u,
	);
	const outsidePath = path.join(fixture.root, "outside.html");
	await writeFile(outsidePath, "<!doctype html><html><body></body></html>");
	await assert.rejects(
		verifyProtonMasterExport({
			repoRoot: fixture.root,
			slug: "exact-essay",
			exportPath: outsidePath,
		}),
		/beneath the ignored \.medium-import/u,
	);
});
