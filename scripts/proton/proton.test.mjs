import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { DEFAULT_REPO_ROOT, serializeJson } from "../medium/lib/contract.js";
import { sha256 } from "../medium/lib/integrity.js";
import {
	expectedInventory,
	heroSourceSha256,
	ProtonContractError,
	semanticSha256,
	validateCapture,
	validateLedger,
	verifyCaptureInventory,
	verifyFictionHeroBuffer,
	writeLedgerNoOverwrite,
} from "./lib.mjs";

function digest(index) {
	return `sha256:${index.toString(16).padStart(64, "0")}`;
}

function makeLedger() {
	return {
		schemaVersion: 1,
		expectedCount: 35,
		records: Array.from({ length: 35 }, (_, index) => ({
			slug: `article-${index + 1}`,
			section: index < 11 ? "fiction" : "nonfiction",
			cloudTitle: `Article ${index + 1}`,
			exportedAt: "2026-07-26T00:00:00.000Z",
			exportSha256: digest(index + 1),
			semanticSha256: digest(100 + index),
			heroSha256: digest(200 + index),
			heroPixelSha256: digest(300 + index),
			heroSourceSha256: digest(350 + index),
			sourceSnapshotSha256: digest(400 + index),
			siteOutputSha256: digest(500 + index),
			bodyBlockCount: index + 1,
		})),
	};
}

function makeCapture(inventory) {
	return {
		schemaVersion: 1,
		capturedAt: "2026-07-26T00:00:00.000Z",
		sections: Object.fromEntries(
			["fiction", "nonfiction"].map((section) => [
				section,
				inventory.sections[section].map(({ slug, title }) => ({
					slug,
					title,
					exportedAt: "2026-07-26T00:00:00.000Z",
					file: `.proton-import/raw/${slug}/export.html`,
					...(section === "fiction"
						? { heroFile: `.proton-import/raw/${slug}/hero-original.png` }
						: {}),
				})),
			]),
		),
	};
}

test("Proton master ledger is strict, complete, sanitized, and sorted", () => {
	const ledger = makeLedger();
	ledger.records.reverse();
	const normalized = validateLedger(ledger, { requireComplete: true });
	assert.equal(normalized.records.length, 35);
	assert.equal(normalized.records[0].slug, "article-1");
	assert.equal(normalized.records.at(-1).slug, "article-9");
	assert.doesNotMatch(serializeJson(normalized), /https?:|[A-Za-z]:[\\/]/u);

	const duplicate = structuredClone(ledger);
	duplicate.records[0].slug = duplicate.records[1].slug;
	assert.throws(
		() => validateLedger(duplicate, { requireComplete: true }),
		/ledger repeats slug/u,
	);

	const privatePath = structuredClone(ledger);
	privatePath.records[0].cloudTitle = "C:\\Users\\private\\document";
	assert.throws(
		() => validateLedger(privatePath, { requireComplete: true }),
		/URL, account reference, raw-source path, or local path/u,
	);

	const incomplete = structuredClone(ledger);
	incomplete.records.pop();
	assert.throws(
		() => validateLedger(incomplete, { requireComplete: true }),
		/incomplete: 34\/35/u,
	);
});

test("capture contract rejects traversal, placeholders, duplicates, and unknown keys", () => {
	const capture = {
		schemaVersion: 1,
		capturedAt: "2026-07-26T00:00:00.000Z",
		sections: {
			fiction: [
				{
					slug: "exact-work",
					title: "Exact Work",
					exportedAt: "2026-07-26T00:00:00.000Z",
					file: ".proton-import/raw/exact-work/export.html",
					heroFile: ".proton-import/raw/exact-work/hero-original.png",
				},
			],
			nonfiction: [],
		},
	};
	assert.deepEqual(validateCapture(capture), capture);
	const legacyMedium = structuredClone(capture);
	legacyMedium.sections.fiction[0].file =
		".medium-import/proton-exports/exact-work/export.html";
	legacyMedium.sections.fiction[0].heroFile =
		".medium-import/proton-captures/fiction/exact-work/hero-original.png";
	assert.deepEqual(validateCapture(legacyMedium), legacyMedium);

	const traversal = structuredClone(capture);
	traversal.sections.fiction[0].file = ".proton-import/../outside.html";
	assert.throws(
		() => validateCapture(traversal),
		/normalized repository-relative path/u,
	);

	const duplicate = structuredClone(capture);
	const { heroFile: _heroFile, ...duplicateEntry } =
		duplicate.sections.fiction[0];
	duplicate.sections.nonfiction.push(duplicateEntry);
	assert.throws(() => validateCapture(duplicate), /repeats slug exact-work/u);

	const unknown = structuredClone(capture);
	unknown.sections.fiction[0].documentId = "private";
	assert.throws(() => validateCapture(unknown), /unsupported key/u);
});

test("hero source digest binds the single exported image without exposing its URL", () => {
	const first = heroSourceSha256(
		Buffer.from('<p><img src="https://private.invalid/one" alt=""></p>'),
	);
	const second = heroSourceSha256(
		Buffer.from('<p><img src="https://private.invalid/two" alt=""></p>'),
	);
	assert.match(first, /^sha256:[a-f0-9]{64}$/u);
	assert.notEqual(first, second);
	assert.throws(
		() => heroSourceSha256(Buffer.from("<p>No image</p>")),
		/exactly one hero image source/u,
	);
	assert.throws(
		() =>
			heroSourceSha256(Buffer.from('<p><img src="one"><img src="two"></p>')),
		/exactly one hero image source/u,
	);
});

test("fiction hero verification binds exact PNG bytes, dimensions, and pixels", async () => {
	const png = await sharp({
		create: {
			width: 2,
			height: 2,
			channels: 4,
			background: { r: 28, g: 74, b: 67, alpha: 1 },
		},
	})
		.png()
		.toBuffer();
	const pixels = await sharp(png)
		.toColourspace("srgb")
		.ensureAlpha()
		.raw({ depth: "uchar" })
		.toBuffer();
	const binding = {
		slug: "exact-work",
		heroSha256: sha256(png),
		heroPixelSha256: sha256(pixels),
		snapshot: { hero: { width: 2, height: 2 } },
	};
	await verifyFictionHeroBuffer(binding, png);

	await assert.rejects(
		verifyFictionHeroBuffer(binding, Buffer.concat([png, Buffer.from([0])])),
		/hero bytes differ/u,
	);

	await assert.rejects(
		verifyFictionHeroBuffer(
			{
				...binding,
				snapshot: { hero: { width: 3, height: 2 } },
			},
			png,
		),
		/format or dimensions differ/u,
	);

	const changedPixelsPng = await sharp({
		create: {
			width: 2,
			height: 2,
			channels: 4,
			background: { r: 120, g: 28, b: 35, alpha: 1 },
		},
	})
		.png()
		.toBuffer();
	await assert.rejects(
		verifyFictionHeroBuffer(
			{ ...binding, heroSha256: sha256(changedPixelsPng) },
			changedPixelsPng,
		),
		/hero pixels differ/u,
	);
});

test("expected inventory binds exactly 11 fiction and 24 nonfiction titles", async () => {
	const inventory = await expectedInventory({ repoRoot: DEFAULT_REPO_ROOT });
	assert.equal(inventory.expectedCount, 35);
	assert.equal(inventory.sections.fiction.length, 11);
	assert.equal(inventory.sections.nonfiction.length, 24);
	const fictionTitles = new Map(
		inventory.sections.fiction.map(({ slug, title }) => [slug, title]),
	);
	assert.equal(
		fictionTitles.get("before-the-sky-went-quiet-part-i-the-girl-who-faded"),
		"Before the Sky Went Quiet_Part I - The Girl Who Faded",
	);
	assert.equal(
		fictionTitles.get("before-the-sky-went-quiet-part-ii-the-goodbye"),
		"Before the Sky Went Quiet_Part II - The Goodbye",
	);
	assert.equal(
		fictionTitles.get(
			"before-the-sky-went-quiet-part-iii-the-echo-that-stayed",
		),
		"Before the Sky Went Quiet_Part III - The Echo That Stayed",
	);
	assert.equal(
		fictionTitles.get("the-guild-a-chronicle-of-pretty-souls"),
		"The Guild_A Chronicle of Pretty Souls",
	);
	const capture = makeCapture(inventory);
	const result = await verifyCaptureInventory({
		repoRoot: DEFAULT_REPO_ROOT,
		capture,
	});
	assert.deepEqual(result, {
		capturedAt: "2026-07-26T00:00:00.000Z",
		fictionCount: 11,
		nonfictionCount: 24,
		totalCount: 35,
		complete: true,
	});

	const changed = structuredClone(capture);
	changed.sections.nonfiction[0].title += " changed";
	await assert.rejects(
		verifyCaptureInventory({ repoRoot: DEFAULT_REPO_ROOT, capture: changed }),
		/exact committed slug\/title set/u,
	);
});

test("semantic digest preserves marks, Unicode, lists, links, and breaks", () => {
	const model = {
		bodyDocument: {
			blocks: [
				{
					type: "paragraph",
					children: [
						{ type: "text", text: "Unicode λ", marks: ["bold"] },
						{ type: "break" },
						{
							type: "text",
							text: "link",
							marks: [],
							href: "https://example.com/?a=1&b=2",
						},
					],
				},
				{
					type: "list",
					ordered: true,
					start: 2,
					items: [[{ type: "paragraph", children: [] }]],
				},
			],
		},
	};
	const digestValue = semanticSha256(model);
	assert.equal(digestValue, semanticSha256(structuredClone(model)));
	for (const mutate of [
		(value) => {
			value.bodyDocument.blocks[0].children[0].text = "Unicode λ";
		},
		(value) => {
			value.bodyDocument.blocks[0].children[0].marks = ["italic"];
		},
		(value) => {
			value.bodyDocument.blocks[0].children.splice(1, 1);
		},
		(value) => {
			value.bodyDocument.blocks[1].start = 1;
		},
	]) {
		const changed = structuredClone(model);
		mutate(changed);
		assert.notEqual(semanticSha256(changed), digestValue);
	}
});

test("ledger writer never overwrites an existing record", async (context) => {
	const root = await mkdtemp(path.join(os.tmpdir(), "shots-proton-ledger-"));
	context.after(() => rm(root, { recursive: true, force: true }));
	await mkdir(path.join(root, "provenance", "proton"), { recursive: true });
	const ledger = makeLedger();
	await writeLedgerNoOverwrite({ repoRoot: root, ledger });
	await assert.rejects(
		writeLedgerNoOverwrite({ repoRoot: root, ledger }),
		(error) =>
			error instanceof ProtonContractError &&
			/Refusing to overwrite/u.test(error.message),
	);
});
