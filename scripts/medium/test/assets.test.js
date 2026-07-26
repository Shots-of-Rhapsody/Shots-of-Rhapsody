import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deflateRawSync } from "node:zlib";
import {
	buildMediumHeroChecklist,
	parseApprovedMediumTitleFile,
} from "../lib/assets.js";
import { extractCandidateMetadata } from "../lib/html.js";
import { sha256 } from "../lib/integrity.js";
import {
	mediumCandidateSetSha256,
	mediumPresentationSetSha256,
} from "../lib/model.js";
import {
	createMediumHeroChecklist,
	createUnreviewedInventoryCandidates,
} from "../lib/pipeline.js";
import { readZipEntries } from "../lib/zip.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"b".repeat(64)}`;

function officialStory({
	title = "Approved Essay",
	description = "Exact export summary.",
	displayTitle = title,
	displaySubtitle = "Exact public subtitle.",
	seriesLine = "A Ledger Series article on exact evidence.",
	id = "0123456789ab",
	heroId = `1*${id}@2x.jpeg`,
	heroUrl = `https://cdn-images-1.medium.com/max/800/${heroId}`,
	width = 1024,
	height = 1024,
	alt,
	caption,
	heroes = 1,
	featured = true,
} = {}) {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/gu, "-")
		.replace(/^-|-$/gu, "");
	const figures = Array.from({ length: heroes }, () => {
		const altAttribute = alt === undefined ? "" : ` alt="${alt}"`;
		const captionElement =
			caption === undefined ? "" : `<figcaption>${caption}</figcaption>`;
		const featuredAttribute = featured ? ' data-is-featured="true"' : "";
		return `<figure name="abcd" id="abcd" class="graf graf--figure graf-after--p"><img class="graf-image" data-image-id="${heroId}" data-width="${width}" data-height="${height}"${featuredAttribute} src="${heroUrl}"${altAttribute}>${captionElement}</figure>`;
	}).join("");
	const canonical = `https://medium.com/@ShotsOfRhapsody/${slug}-${id}`;
	return `<!doctype html><html><head><title>${title}</title><style>p { color: black; }</style></head><body><article class="h-entry"><header><h1 class="p-name">${title}</h1></header><section data-field="subtitle" class="p-summary">${description}</section><section data-field="body" class="e-content"><section name="c0de" class="section section--body section--first section--last"><div class="section-divider"><hr class="section-divider"></div><div class="section-content"><div class="section-inner sectionLayout--insetColumn"><h3 name="cafe" id="cafe" class="graf graf--h3 graf--leading graf--title">${displayTitle}</h3><h4 name="feed" id="feed" class="graf graf--h4 graf-after--h3 graf--subtitle">${displaySubtitle}</h4><p name="face" id="face" class="graf graf--p graf-after--h4">${seriesLine}</p>${figures}<p name="beef" id="beef" class="graf graf--p graf-after--figure">Exact body.</p></div></div></section></section><footer><p>By <a href="https://medium.com/@ShotsOfRhapsody" class="p-author h-card">Tai Song</a> on <a href="https://medium.com/p/${id}"><time class="dt-published" datetime="2025-04-01T12:00:00.000Z">April 1, 2025</time></a>.</p><p><a href="${canonical}" class="p-canonical">Canonical link</a></p><p><a href="https://medium.com">Exported from Medium</a></p></footer></article></body></html>`;
}

function fixture(entries) {
	const candidates = [...entries.entries()].map(([sourcePath, contents]) => ({
		...extractCandidateMetadata(contents.toString("utf8"), sourcePath),
		sourcePath,
		sourceSha256: DIGEST,
		include: null,
		exclusionReason: "",
		classification: { visibility: null, authorship: null, format: null },
	}));
	return { entries, candidates };
}

function checklist(
	entries,
	approvedTitles,
	expectedCount = approvedTitles.length,
	expectedCandidateCount = entries.size,
	bindingOverrides = {},
) {
	const source = fixture(entries);
	const candidateSetSha256 = mediumCandidateSetSha256(source.candidates);
	return buildMediumHeroChecklist({
		...source,
		approvedAllowlist: {
			schemaVersion: 1,
			expectedCount,
			expectedCandidateCount,
			exportSha256: bindingOverrides.exportSha256 ?? DIGEST,
			candidateSetSha256:
				bindingOverrides.candidateSetSha256 ?? candidateSetSha256,
			titles: approvedTitles,
		},
		expectedCount,
		expectedCandidateCount,
		exportFileName: "medium-export.zip",
		exportSha256: DIGEST,
		candidateSetSha256,
	});
}

test("hero checklist preserves exact evidence and leaves other candidates unresolved", () => {
	const approved = officialStory({ alt: "", caption: "Exact caption." });
	const other = officialStory({
		title: "Unapproved Response",
		id: "abcdef012345",
		heroId: "1*other@2x.jpeg",
	});
	const entries = new Map([
		[
			"posts/2025-04-01_Approved-Essay-0123456789ab.html",
			Buffer.from(approved),
		],
		[
			"posts/2025-04-02_Unapproved-Response-abcdef012345.html",
			Buffer.from(other),
		],
	]);
	const result = checklist(entries, ["Approved Essay"]);
	assert.equal(result.exportedCandidateCount, 2);
	assert.equal(result.approvedTitleCount, 1);
	assert.equal(result.unapprovedCandidateCount, 1);
	assert.equal(result.expectedCandidateCount, 2);
	assert.deepEqual(result.assetPolicy, {
		exportedSourceUrlUse: "comparison-reference-only",
		browserCaptureRequired: true,
		captureKind: "highest-observed-medium-responsive-derivative",
		originalUploadClaimed: false,
		automatedDownloadAllowed: false,
		metadataStrippingRequired: true,
	});
	assert.equal(result.items.length, 1);
	assert.deepEqual(
		{
			title: result.items[0].title,
			descriptionCandidate: result.items[0].descriptionCandidate,
			exportSummaryCandidate: result.items[0].exportSummaryCandidate,
			displayTitleCandidate: result.items[0].displayTitleCandidate,
			displaySubtitleCandidate: result.items[0].displaySubtitleCandidate,
			seriesLineCandidate: result.items[0].seriesLineCandidate,
		},
		{
			title: "Approved Essay",
			descriptionCandidate: "Exact export summary.",
			exportSummaryCandidate: "Exact export summary.",
			displayTitleCandidate: "Approved Essay",
			displaySubtitleCandidate: "Exact public subtitle.",
			seriesLineCandidate: "A Ledger Series article on exact evidence.",
		},
	);
	assert.deepEqual(result.items[0].exportedHero, {
		identificationEvidence: "exported-featured-flag",
		sourceUrl: "https://cdn-images-1.medium.com/max/800/1*0123456789ab@2x.jpeg",
		declaredWidth: 1024,
		declaredHeight: 1024,
		alt: { present: true, value: "" },
		caption: { present: true, value: "Exact caption." },
	});
	assert.equal(
		result.items[0].requiredCapturePath,
		".medium-import/raw/assets/approved-essay/hero-medium.webp",
	);
	assert.equal(
		result.items[0].requiredSiteReadyPath,
		".medium-import/site-ready/assets/approved-essay/hero-sanitized.webp",
	);
	assert.equal(fixture(entries).candidates[1].include, null);
	const absentEvidence = checklist(
		new Map([
			[
				"posts/2025-04-01_Approved-Essay-0123456789ab.html",
				Buffer.from(officialStory()),
			],
		]),
		["Approved Essay"],
	).items[0].exportedHero;
	assert.deepEqual(absentEvidence.alt, { present: false, value: null });
	assert.deepEqual(absentEvidence.caption, { present: false, value: null });
	const soleFigureEvidence = checklist(
		new Map([
			[
				"posts/2025-04-01_Approved-Essay-0123456789ab.html",
				Buffer.from(officialStory({ featured: false })),
			],
		]),
		["Approved Essay"],
	).items[0].exportedHero;
	assert.equal(
		soleFigureEvidence.identificationEvidence,
		"sole-exported-figure",
	);
});

test("versioned title allowlist is exact, unique, and count-bound", () => {
	assert.deepEqual(
		parseApprovedMediumTitleFile(
			JSON.stringify({
				schemaVersion: 1,
				expectedCount: 2,
				expectedCandidateCount: 3,
				exportSha256: DIGEST,
				candidateSetSha256: OTHER_DIGEST,
				titles: ["One", "Two"],
			}),
			{ expectedCount: 2, expectedCandidateCount: 3 },
		),
		{
			schemaVersion: 1,
			expectedCount: 2,
			expectedCandidateCount: 3,
			exportSha256: DIGEST,
			candidateSetSha256: OTHER_DIGEST,
			titles: ["One", "Two"],
		},
	);
	for (const [value, pattern] of [
		[
			{
				schemaVersion: 2,
				expectedCount: 2,
				expectedCandidateCount: 3,
				exportSha256: DIGEST,
				candidateSetSha256: OTHER_DIGEST,
				titles: ["One", "Two"],
			},
			/schemaVersion/u,
		],
		[
			{
				schemaVersion: 1,
				expectedCount: 2,
				expectedCandidateCount: 3,
				exportSha256: DIGEST,
				candidateSetSha256: OTHER_DIGEST,
				titles: ["One", "One"],
			},
			/repeats/u,
		],
		[
			{
				schemaVersion: 1,
				expectedCount: 1,
				expectedCandidateCount: 3,
				exportSha256: DIGEST,
				candidateSetSha256: OTHER_DIGEST,
				titles: ["One"],
			},
			/expectedCount/u,
		],
		[
			{
				schemaVersion: 1,
				expectedCount: 2,
				expectedCandidateCount: 4,
				exportSha256: DIGEST,
				candidateSetSha256: OTHER_DIGEST,
				titles: ["One", "Two"],
			},
			/expectedCandidateCount/u,
		],
	]) {
		assert.throws(
			() =>
				parseApprovedMediumTitleFile(JSON.stringify(value), {
					expectedCount: 2,
					expectedCandidateCount: 3,
				}),
			pattern,
		);
	}
});

test("checklist binds the complete export candidate count", () => {
	const entries = new Map([
		[
			"posts/2025-04-01_Approved-Essay-0123456789ab.html",
			Buffer.from(officialStory()),
		],
	]);
	assert.throws(
		() => checklist(entries, ["Approved Essay"], 1, 2),
		/must contain exactly 2 candidates; found 1/u,
	);
});

test("checklist rejects export bindings before inspecting hero evidence", () => {
	const sourcePath = "posts/2025-04-01_Approved-Essay-0123456789ab.html";
	const valid = new Map([[sourcePath, Buffer.from(officialStory())]]);
	assert.throws(
		() =>
			checklist(valid, ["Approved Essay"], 1, 1, {
				exportSha256: OTHER_DIGEST,
			}),
		/export SHA-256 differs/u,
	);
	const unsafeHero = new Map([
		[
			sourcePath,
			Buffer.from(officialStory({ heroUrl: "http://example.test/hero.jpeg" })),
		],
	]);
	assert.throws(
		() =>
			checklist(unsafeHero, ["Approved Essay"], 1, 1, {
				candidateSetSha256: OTHER_DIGEST,
			}),
		/candidate-set SHA-256 differs/u,
	);
});

test("checklist rejects title mismatches and missing, multiple, or unsafe heroes", () => {
	const sourcePath = "posts/2025-04-01_Approved-Essay-0123456789ab.html";
	const valid = new Map([[sourcePath, Buffer.from(officialStory())]]);
	assert.throws(
		() => checklist(valid, ["Missing Essay"]),
		/does not match the export exactly/u,
	);
	assert.throws(
		() =>
			checklist(
				new Map([[sourcePath, Buffer.from(officialStory({ heroes: 0 }))]]),
				["Approved Essay"],
			),
		/followed immediately by its hero figure/u,
	);
	assert.throws(
		() =>
			checklist(
				new Map([[sourcePath, Buffer.from(officialStory({ heroes: 2 }))]]),
				["Approved Essay"],
			),
		/multiple explicitly featured hero/u,
	);
	assert.throws(
		() =>
			checklist(
				new Map([
					[
						sourcePath,
						Buffer.from(
							officialStory({ heroUrl: "http://example.test/hero.jpeg" }),
						),
					],
				]),
				["Approved Essay"],
			),
		/must use HTTPS/u,
	);
});

test("hero image ids must match their decoded URL path components", () => {
	const firstPath = "posts/2025-04-01_Approved-Essay-0123456789ab.html";
	assert.throws(
		() =>
			checklist(
				new Map([
					[
						firstPath,
						Buffer.from(
							officialStory({
								heroId: "1*declared@2x.jpeg",
								heroUrl:
									"https://cdn-images-1.medium.com/max/800/1*different@2x.jpeg",
							}),
						),
					],
				]),
				["Approved Essay"],
			),
		/data-image-id does not match/u,
	);

	const firstId = "1*first@2x.jpeg";
	const secondId = "1*second@2x.jpeg";
	const swapped = new Map([
		[
			firstPath,
			Buffer.from(
				officialStory({
					heroId: firstId,
					heroUrl: `https://cdn-images-1.medium.com/max/800/${secondId}`,
				}),
			),
		],
		[
			"posts/2025-04-02_Second-Essay-abcdef012345.html",
			Buffer.from(
				officialStory({
					title: "Second Essay",
					id: "abcdef012345",
					heroId: secondId,
					heroUrl: `https://cdn-images-1.medium.com/max/800/${firstId}`,
				}),
			),
		],
	]);
	assert.throws(
		() => checklist(swapped, ["Approved Essay", "Second Essay"]),
		/data-image-id does not match/u,
	);
});

test("checklist rejects duplicate ids, slugs, and URLs", () => {
	const duplicateStoryId = new Map([
		[
			"posts/2025-04-01_Approved-Essay-0123456789ab.html",
			Buffer.from(officialStory()),
		],
		[
			"posts/2025-04-02_Second-Essay-0123456789ab.html",
			Buffer.from(
				officialStory({
					title: "Second Essay",
					heroId: "1*second@2x.jpeg",
					heroUrl: "https://cdn-images-1.medium.com/max/800/1*second@2x.jpeg",
				}),
			),
		],
	]);
	assert.throws(
		() => checklist(duplicateStoryId, ["Approved Essay", "Second Essay"]),
		/repeats story id/u,
	);

	const duplicateSlug = new Map([
		[
			"posts/2025-04-01_Essay-One-0123456789ab.html",
			Buffer.from(officialStory({ title: "Essay One" })),
		],
		[
			"posts/2025-04-02_Essay-One-abcdef012345.html",
			Buffer.from(
				officialStory({
					title: "Essay-One",
					id: "abcdef012345",
					heroId: "1*second@2x.jpeg",
					heroUrl: "https://cdn-images-1.medium.com/max/800/1*second@2x.jpeg",
				}),
			),
		],
	]);
	assert.throws(
		() => checklist(duplicateSlug, ["Essay One", "Essay-One"]),
		/repeats slug/u,
	);

	const duplicateHeroIdentity = new Map([
		[
			"posts/2025-04-01_Approved-Essay-0123456789ab.html",
			Buffer.from(officialStory()),
		],
		[
			"posts/2025-04-02_Second-Essay-abcdef012345.html",
			Buffer.from(
				officialStory({
					title: "Second Essay",
					id: "abcdef012345",
					heroId: "1*0123456789ab@2x.jpeg",
					heroUrl:
						"https://cdn-images-1.medium.com/max/800/1*0123456789ab@2x.jpeg",
				}),
			),
		],
	]);
	assert.throws(
		() => checklist(duplicateHeroIdentity, ["Approved Essay", "Second Essay"]),
		/repeats hero image id/u,
	);
});

test("checklist construction never calls fetch", () => {
	const originalFetch = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = () => {
		calls += 1;
		throw new Error("network access is forbidden");
	};
	try {
		const entries = new Map([
			[
				"posts/2025-04-01_Approved-Essay-0123456789ab.html",
				Buffer.from(officialStory()),
			],
		]);
		assert.equal(checklist(entries, ["Approved Essay"]).items.length, 1);
		assert.equal(calls, 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
	let crc = value;
	for (let bit = 0; bit < 8; bit += 1) {
		crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
	}
	return crc >>> 0;
});

function crc32(buffer) {
	let crc = 0xffffffff;
	for (const byte of buffer) {
		crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function zipEntry(name, contents) {
	const nameBytes = Buffer.from(name, "utf8");
	const compressed = deflateRawSync(contents);
	const crc = crc32(contents);
	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt16LE(0x800, 6);
	local.writeUInt16LE(8, 8);
	local.writeUInt32LE(crc, 14);
	local.writeUInt32LE(compressed.length, 18);
	local.writeUInt32LE(contents.length, 22);
	local.writeUInt16LE(nameBytes.length, 26);
	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50, 0);
	central.writeUInt16LE(0x800, 8);
	central.writeUInt16LE(8, 10);
	central.writeUInt32LE(crc, 16);
	central.writeUInt32LE(compressed.length, 20);
	central.writeUInt32LE(contents.length, 24);
	central.writeUInt16LE(nameBytes.length, 28);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(1, 8);
	end.writeUInt16LE(1, 10);
	end.writeUInt32LE(central.length + nameBytes.length, 12);
	end.writeUInt32LE(local.length + nameBytes.length + compressed.length, 16);
	return Buffer.concat([local, nameBytes, compressed, central, nameBytes, end]);
}

test("write mode refuses to overwrite an existing ignored checklist", async (context) => {
	const repoRoot = await mkdtemp(path.join(os.tmpdir(), "medium-assets-"));
	context.after(() => rm(repoRoot, { recursive: true, force: true }));
	const rawRoot = path.join(repoRoot, ".medium-import", "raw");
	await mkdir(rawRoot, { recursive: true });
	const exportPath = path.join(rawRoot, "medium-export.zip");
	const exportBuffer = zipEntry(
		"posts/2025-04-01_Approved-Essay-0123456789ab.html",
		Buffer.from(officialStory()),
	);
	await writeFile(exportPath, exportBuffer);
	const candidates = createUnreviewedInventoryCandidates(
		readZipEntries(exportBuffer),
	);
	const approvedAllowlist = {
		schemaVersion: 1,
		expectedCount: 1,
		expectedCandidateCount: 1,
		exportSha256: sha256(exportBuffer),
		candidateSetSha256: mediumCandidateSetSha256(candidates),
		titles: ["Approved Essay"],
	};
	const candidateLedger = {
		schemaVersion: 1,
		state: "needs-review",
		authority: {
			platform: "Medium",
			captureFormat: "account-export-zip",
		},
		author: {
			name: "Tai Song",
			profileUrl: "https://medium.com/@ShotsOfRhapsody",
		},
		export: {
			fileName: "medium-export.zip",
			sha256: sha256(exportBuffer),
			capturedAt: "2026-07-25T12:00:00.000Z",
		},
		candidateCount: 1,
		candidateSetSha256: mediumCandidateSetSha256(candidates),
		presentationSetVersion: 1,
		presentationSetSha256: mediumPresentationSetSha256(candidates),
		candidates,
	};
	await writeFile(
		path.join(repoRoot, ".medium-import", "inventory-candidate.json"),
		`${JSON.stringify(candidateLedger, null, 2)}\n`,
	);
	await createMediumHeroChecklist({
		repoRoot,
		exportPath,
		approvedAllowlist,
		expectedCount: 1,
		expectedCandidateCount: 1,
		write: true,
	});
	const checklistPath = path.join(
		repoRoot,
		".medium-import",
		"hero-acquisition-checklist.json",
	);
	const before = await readFile(checklistPath);
	const alteredPresentation = structuredClone(candidateLedger);
	alteredPresentation.candidates[0].displayTitleCandidate = "Altered display";
	alteredPresentation.presentationSetSha256 = mediumPresentationSetSha256(
		alteredPresentation.candidates,
	);
	await writeFile(
		path.join(repoRoot, ".medium-import", "inventory-candidate.json"),
		`${JSON.stringify(alteredPresentation, null, 2)}\n`,
	);
	await assert.rejects(
		createMediumHeroChecklist({
			repoRoot,
			exportPath,
			approvedAllowlist,
			expectedCount: 1,
			expectedCandidateCount: 1,
		}),
		/source-derived fields differ/u,
	);
	await writeFile(
		path.join(repoRoot, ".medium-import", "inventory-candidate.json"),
		`${JSON.stringify(candidateLedger, null, 2)}\n`,
	);
	await assert.rejects(
		createMediumHeroChecklist({
			repoRoot,
			exportPath,
			approvedAllowlist,
			expectedCount: 1,
			expectedCandidateCount: 1,
			write: true,
		}),
		/already exists/u,
	);
	assert.deepEqual(await readFile(checklistPath), before);
});
