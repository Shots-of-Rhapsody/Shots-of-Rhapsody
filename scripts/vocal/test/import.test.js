import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { importArticles } from "../lib/pipeline.js";
import {
	makePage,
	makePng,
	makePost,
	makeRepository,
	inventoryArticle,
	SAMPLE_CAPTURED_AT,
	SAMPLE_SLUG,
	writeRawArticle,
} from "./helpers.js";

test("dry-run validates inputs but writes nothing", async (testContext) => {
	const { root } = await makeRepository(testContext);
	const result = await importArticles({ repoRoot: root, slugs: [SAMPLE_SLUG] });
	assert.equal(result.mode, "dry-run");
	assert.equal(result.articles[0].capturedAtRequired, true);
	await assert.rejects(
		access(path.join(root, "provenance", "vocal", "manifest.json")),
		/ENOENT/u,
	);
	await assert.rejects(
		access(path.join(root, "src", "content", "posts", SAMPLE_SLUG, "index.md")),
		/ENOENT/u,
	);
});

test("first write requires capturedAt and creates deterministic artifacts", async (testContext) => {
	const { root, post } = await makeRepository(testContext);
	await assert.rejects(
		importArticles({ repoRoot: root, slugs: [SAMPLE_SLUG], write: true }),
		/--captured-at/u,
	);
	const first = await importArticles({
		repoRoot: root,
		slugs: [SAMPLE_SLUG],
		write: true,
		capturedAt: SAMPLE_CAPTURED_AT,
	});
	assert.equal(first.articles[0].actions.snapshot, "create");
	assert.equal(first.manifestAction, "create");

	const snapshotPath = path.join(
		root,
		"provenance",
		"vocal",
		"posts",
		`${SAMPLE_SLUG}.json`,
	);
	const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
	assert.deepEqual(snapshot, post);
	assert.equal(snapshot.account, undefined);
	const manifest = JSON.parse(
		await readFile(path.join(root, "provenance", "vocal", "manifest.json"), "utf8"),
	);
	assert.equal(manifest.platform, "Vocal");
	assert.deepEqual(manifest.articles[0].image, {
		mimeType: "image/png",
		width: 2,
		height: 3,
		byteSize: makePng().byteLength,
	});

	const markdown = await readFile(
		path.join(root, "src", "content", "posts", SAMPLE_SLUG, "index.md"),
		"utf8",
	);
	assert.match(markdown, /description: "Curly quotes, colons: and <characters> remain exact\."/u);
	assert.match(markdown, /source:\r?\n {2}platform: "Vocal"/u);
	assert.match(markdown, /capturedAt: "2026-07-21T19:20:21\.000Z"/u);
	assert.match(markdown, /<strong><em> boldly<\/em><\/strong>/u);

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

test("safe updates require review and refuse overwritten generated files", async (testContext) => {
	const { root, post } = await makeRepository(testContext);
	await importArticles({
		repoRoot: root,
		slugs: [SAMPLE_SLUG],
		write: true,
		capturedAt: SAMPLE_CAPTURED_AT,
	});
	const changedPost = makePost({ subtitle: "Reviewed replacement subtitle." });
	await writeFile(
		path.join(root, ".vocal-import", "raw", SAMPLE_SLUG, "page.html"),
		await makePage(changedPost),
	);
	const dryRun = await importArticles({ repoRoot: root, slugs: [SAMPLE_SLUG] });
	assert.equal(dryRun.articles[0].actions.markdown, "replace");
	assert.equal(dryRun.articles[0].capturedAtRequired, true);
	await assert.rejects(
		importArticles({ repoRoot: root, slugs: [SAMPLE_SLUG], write: true }),
		/new --captured-at/u,
	);
	await assert.rejects(
		importArticles({
			repoRoot: root,
			slugs: [SAMPLE_SLUG],
			write: true,
			capturedAt: "2026-07-22T19:20:21.000Z",
		}),
		/--write --update/u,
	);
	await assert.rejects(
		importArticles({
			repoRoot: root,
			slugs: [SAMPLE_SLUG],
			write: true,
			update: true,
			capturedAt: SAMPLE_CAPTURED_AT,
		}),
		/requires a capture timestamp different/u,
	);
	await importArticles({
		repoRoot: root,
		slugs: [SAMPLE_SLUG],
		write: true,
		update: true,
		capturedAt: "2026-07-22T19:20:21.000Z",
	});
	const updatedManifest = JSON.parse(
		await readFile(path.join(root, "provenance", "vocal", "manifest.json"), "utf8"),
	);
	assert.equal(
		updatedManifest.articles[0].capturedAt,
		"2026-07-22T19:20:21.000Z",
	);

	const markdownPath = path.join(
		root,
		"src",
		"content",
		"posts",
		SAMPLE_SLUG,
		"index.md",
	);
	await writeFile(markdownPath, "manual edit\n");
	await writeFile(
		path.join(root, ".vocal-import", "raw", SAMPLE_SLUG, "page.html"),
		await makePage({ ...post, subtitle: "Another replacement." }),
	);
	await assert.rejects(
		importArticles({
			repoRoot: root,
			slugs: [SAMPLE_SLUG],
			write: true,
			update: true,
			capturedAt: "2026-07-23T19:20:21.000Z",
		}),
		/does not match its recorded manifest hash/u,
	);
});

test("rejects duplicate Vocal source ids across an import batch", async (testContext) => {
	const firstPost = makePost();
	const secondPost = makePost({
		id: firstPost.id,
		name: "Second Article",
		slug: "second-article",
		wordCount: 7,
	});
	const { root } = await makeRepository(testContext, {
		post: firstPost,
		articles: [inventoryArticle(firstPost), inventoryArticle(secondPost)],
		expectedWordCount: 12,
	});
	await writeRawArticle(root, secondPost);
	await assert.rejects(
		importArticles({
			repoRoot: root,
			all: true,
			capturedAt: SAMPLE_CAPTURED_AT,
		}),
		/repeats Vocal source id/u,
	);
});

test("rejects a PNG whose chunk checksum is invalid", async (testContext) => {
	const { root, post } = await makeRepository(testContext, { writeRaw: false });
	const corruptPng = makePng();
	corruptPng[45] ^= 1;
	await writeRawArticle(root, post, corruptPng);
	await assert.rejects(
		importArticles({ repoRoot: root, slugs: [SAMPLE_SLUG] }),
		/chunk checksum/u,
	);
});
