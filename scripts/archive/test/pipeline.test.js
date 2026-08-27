import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
	importArticles,
	validateInventory,
	verifyArticles,
} from "../lib/pipeline.js";
import {
	inventoryArticle,
	makePng,
	makeRepository,
	readFixture,
	SAMPLE_CAPTURED_AT,
	SAMPLE_SLUG,
	writeRawArticle,
} from "./helpers.js";

test("validates exact inventory identity and rejects duplicates", () => {
	const first = inventoryArticle();
	const second = inventoryArticle({
		slug: "second-article",
		title: "Second Article",
		publication: {
			platform: "Vocal",
			url: "https://vocal.media/fiction/second-article",
		},
	});
	const valid = {
		schemaVersion: 1,
		expectedCount: 2,
		articles: [first, second],
	};
	assert.equal(validateInventory(valid).articles.length, 2);
	assert.throws(
		() =>
			validateInventory({
				...valid,
				articles: [
					first,
					{ ...second, slug: first.slug, publication: first.publication },
				],
			}),
		/repeats slug/u,
	);
	assert.throws(
		() =>
			validateInventory({
				...valid,
				articles: [first, { ...second, publication: first.publication }],
			}),
		/publication\.url path must match|repeats publication URL/u,
	);
	assert.throws(
		() =>
			validateInventory({
				...valid,
				articles: [{ ...first, summary: "" }, second],
			}),
		/non-empty string/u,
	);
	assert.throws(
		() =>
			validateInventory({
				...valid,
				articles: [{ ...first, description: "Editorial rewrite" }, second],
			}),
		/description must exactly match its subtitle/u,
	);
	assert.throws(
		() =>
			validateInventory({
				...valid,
				articles: [{ ...first, tags: [""] }, second],
			}),
		/non-empty strings/u,
	);
});

test("dry-run writes nothing and first write creates neutral deterministic evidence", async (testContext) => {
	const { root } = await makeRepository(testContext);
	const dryRun = await importArticles({
		repoRoot: root,
		slugs: [SAMPLE_SLUG],
	});
	assert.equal(dryRun.mode, "dry-run");
	assert.equal(dryRun.articles[0].capturedAtRequired, true);
	await assert.rejects(
		access(path.join(root, "provenance", "tai-song", "manifest.json")),
		/ENOENT/u,
	);

	await assert.rejects(
		importArticles({ repoRoot: root, slugs: [SAMPLE_SLUG], write: true }),
		/--captured-at/u,
	);
	await importArticles({
		repoRoot: root,
		slugs: [SAMPLE_SLUG],
		write: true,
		capturedAt: SAMPLE_CAPTURED_AT,
	});

	const snapshotPath = path.join(
		root,
		"provenance",
		"tai-song",
		"posts",
		`${SAMPLE_SLUG}.json`,
	);
	const snapshotText = await readFile(snapshotPath, "utf8");
	const snapshot = JSON.parse(snapshotText);
	assert.equal(snapshot.provenance.authority, "Proton Docs");
	assert.equal(snapshot.provenance.captureFormat, "html-export");
	assert.equal(snapshot.imageAlt, null);
	assert.equal(snapshot.hero.rawAlt, "");
	assert.equal(snapshot.bodyBlockCount, 4);
	assert.match(snapshot.bodyTextSha256, /^sha256:[0-9a-f]{64}$/u);
	assert.doesNotMatch(snapshotText, /media\.example\.invalid/u);

	const manifestText = await readFile(
		path.join(root, "provenance", "tai-song", "manifest.json"),
		"utf8",
	);
	const manifest = JSON.parse(manifestText);
	assert.deepEqual(manifest.authority, {
		platform: "Proton Docs",
		captureFormat: "html-export",
	});
	assert.equal(manifest.articles[0].image.alt, null);
	assert.equal(
		manifest.articles[0].image.sha256,
		manifest.articles[0].hashes.image,
	);
	assert.doesNotMatch(manifestText, /media\.example\.invalid/u);

	const markdown = await readFile(
		path.join(
			root,
			"src",
			"content",
			"posts",
			"fiction",
			SAMPLE_SLUG,
			"index.md",
		),
		"utf8",
	);
	assert.match(markdown, /^image: "\.\/hero-original\.png"$/mu);
	assert.match(markdown, /^imageAlt: null$/mu);
	assert.match(markdown, /^ {2}captureFormat: "html-export"$/mu);
	assert.match(markdown, /^ {2}bodyBlockCount: 4$/mu);
	assert.doesNotMatch(markdown, /media\.example\.invalid/u);

	const second = await importArticles({
		repoRoot: root,
		slugs: [SAMPLE_SLUG],
		write: true,
	});
	assert.deepEqual(second.articles[0].actions, {
		snapshot: "unchanged",
		markdown: "unchanged",
		image: "unchanged",
	});
	assert.equal(second.manifestAction, "unchanged");
});

test("rejects duplicate Proton exports across distinct articles", async (testContext) => {
	const first = inventoryArticle();
	const second = inventoryArticle({
		slug: "second-article",
		title: "Second Article",
		publication: {
			platform: "Vocal",
			url: "https://vocal.media/fiction/second-article",
		},
	});
	const { root } = await makeRepository(testContext, {
		articles: [first, second],
	});
	await writeRawArticle(root, second);
	await assert.rejects(
		importArticles({
			repoRoot: root,
			all: true,
			capturedAt: SAMPLE_CAPTURED_AT,
		}),
		/duplicates the raw document/u,
	);
});

test("validates an optional observed lead title against the fixed inventory", async (testContext) => {
	const fixture = await readFixture();
	const html = fixture.replace(
		`<span style="white-space: pre-wrap">An exact subtitle — “smart” &amp; deliberate</span>`,
		`<span style="white-space: pre-wrap">Wrong Article</span><br><br><span style="white-space: pre-wrap">An exact subtitle — “smart” &amp; deliberate</span>`,
	);
	const { root } = await makeRepository(testContext, { html });
	await assert.rejects(
		importArticles({ repoRoot: root, slugs: [SAMPLE_SLUG] }),
		/lead title does not exactly match inventory title/u,
	);
});

test("rejects private Proton references in retained article content", async (testContext) => {
	const fixture = await readFixture();
	const privateReference = [
		"https://docs",
		"proton.me/u/1/document/synthetic-test-only",
	].join(".");
	const html = fixture.replace(
		"First body *markdown* [link] — 漢字 😀",
		`Private source ${privateReference}`,
	);
	const { root } = await makeRepository(testContext, { html });
	await assert.rejects(
		importArticles({ repoRoot: root, slugs: [SAMPLE_SLUG] }),
		/private Proton reference/u,
	);
});

test("rejects corrupt PNG evidence before planning an import", async (testContext) => {
	const png = makePng();
	png[20] ^= 0xff;
	const { root } = await makeRepository(testContext, { png });
	await assert.rejects(
		importArticles({ repoRoot: root, slugs: [SAMPLE_SLUG] }),
		/invalid IHDR chunk checksum/u,
	);
});

test("refuses unmanaged destinations and tampered managed updates", async (testContext) => {
	const unmanaged = await makeRepository(testContext);
	const unmanagedPath = path.join(
		unmanaged.root,
		"src",
		"content",
		"posts",
		"fiction",
		SAMPLE_SLUG,
		"index.md",
	);
	await mkdir(path.dirname(unmanagedPath), { recursive: true });
	await writeFile(unmanagedPath, "unmanaged\n");
	await assert.rejects(
		importArticles({ repoRoot: unmanaged.root, slugs: [SAMPLE_SLUG] }),
		/Refusing to adopt unmanaged/u,
	);

	const managed = await makeRepository(testContext);
	await importArticles({
		repoRoot: managed.root,
		slugs: [SAMPLE_SLUG],
		write: true,
		capturedAt: SAMPLE_CAPTURED_AT,
	});
	const rawPagePath = path.join(
		managed.root,
		".proton-import",
		"raw",
		SAMPLE_SLUG,
		"page.html",
	);
	const changedPage = (await readFile(rawPagePath, "utf8")).replace(
		"private-object",
		"private-object?revision=2",
	);
	await writeFile(rawPagePath, changedPage);
	await assert.rejects(
		importArticles({
			repoRoot: managed.root,
			slugs: [SAMPLE_SLUG],
			write: true,
		}),
		/new --captured-at/u,
	);
	await assert.rejects(
		importArticles({
			repoRoot: managed.root,
			slugs: [SAMPLE_SLUG],
			write: true,
			capturedAt: "2026-07-22T19:20:21.000Z",
		}),
		/--write --update/u,
	);
	const managedMarkdown = path.join(
		managed.root,
		"src",
		"content",
		"posts",
		"fiction",
		SAMPLE_SLUG,
		"index.md",
	);
	await writeFile(managedMarkdown, "tampered\n");
	await assert.rejects(
		importArticles({
			repoRoot: managed.root,
			slugs: [SAMPLE_SLUG],
			write: true,
			update: true,
			capturedAt: "2026-07-22T19:20:21.000Z",
		}),
		/does not match its recorded manifest hash/u,
	);
});

test("committed and raw-backed verification detect tampering", async (testContext) => {
	const { root } = await makeRepository(testContext);
	await importArticles({
		repoRoot: root,
		slugs: [SAMPLE_SLUG],
		write: true,
		capturedAt: SAMPLE_CAPTURED_AT,
	});
	const rawResult = await verifyArticles({ repoRoot: root, withRaw: true });
	assert.equal(rawResult.complete, true);
	await rm(path.join(root, ".proton-import"), { recursive: true, force: true });
	const committedResult = await verifyArticles({ repoRoot: root });
	assert.equal(committedResult.complete, true);
	await assert.rejects(
		verifyArticles({ repoRoot: root, withRaw: true }),
		/Raw Proton HTML export/u,
	);

	const snapshotPath = path.join(
		root,
		"provenance",
		"tai-song",
		"posts",
		`${SAMPLE_SLUG}.json`,
	);
	const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
	snapshot.bodyBlockCount += 1;
	await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
	await assert.rejects(
		verifyArticles({ repoRoot: root }),
		/bodyBlockCount differs/u,
	);
});

test("requires a complete inventory only when requested", async (testContext) => {
	const first = inventoryArticle();
	const second = inventoryArticle({
		slug: "pending-article",
		title: "Pending Article",
		publication: {
			platform: "Vocal",
			url: "https://vocal.media/fiction/pending-article",
		},
	});
	const { root } = await makeRepository(testContext, {
		articles: [first, second],
	});
	await importArticles({
		repoRoot: root,
		slugs: [SAMPLE_SLUG],
		write: true,
		capturedAt: SAMPLE_CAPTURED_AT,
	});
	assert.equal((await verifyArticles({ repoRoot: root })).complete, false);
	await assert.rejects(
		verifyArticles({ repoRoot: root, requireComplete: true }),
		/Import is incomplete/u,
	);
});
