import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { importArticles, verifyArticles } from "../lib/pipeline.js";
import {
	inventoryArticle,
	makePost,
	makeRepository,
	SAMPLE_CAPTURED_AT,
	SAMPLE_SLUG,
} from "./helpers.js";

async function importFixture(testContext, options = {}) {
	const fixture = await makeRepository(testContext, options);
	await importArticles({
		repoRoot: fixture.root,
		slugs: [SAMPLE_SLUG],
		write: true,
		capturedAt: SAMPLE_CAPTURED_AT,
	});
	return fixture;
}

test("committed-only and raw-backed verification both pass", async (testContext) => {
	const { root } = await importFixture(testContext);
	const rawResult = await verifyArticles({ repoRoot: root, withRaw: true });
	assert.equal(rawResult.complete, true);
	assert.equal(rawResult.importedCount, 1);

	await rm(path.join(root, ".vocal-import"), { recursive: true, force: true });
	const committedResult = await verifyArticles({ repoRoot: root });
	assert.equal(committedResult.complete, true);
	await assert.rejects(
		verifyArticles({ repoRoot: root, withRaw: true }),
		/Raw page/u,
	);
});

test("verification detects tampering in generated Markdown", async (testContext) => {
	const { root } = await importFixture(testContext);
	const markdownPath = path.join(
		root,
		"src",
		"content",
		"posts",
		SAMPLE_SLUG,
		"index.md",
	);
	await writeFile(markdownPath, "tampered\n");
	await assert.rejects(
		verifyArticles({ repoRoot: root }),
		/Generated Markdown differs/u,
	);
});

test("verification detects snapshot and raw-page divergence", async (testContext) => {
	const { root } = await importFixture(testContext);
	const snapshotPath = path.join(
		root,
		"provenance",
		"vocal",
		"posts",
		`${SAMPLE_SLUG}.json`,
	);
	const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
	snapshot.unknownPostField.preserve = false;
	await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
	await assert.rejects(
		verifyArticles({ repoRoot: root }),
		/snapshot hash mismatch/u,
	);
});

test("requireComplete rejects a pending subset", async (testContext) => {
	const post = makePost();
	const pendingPost = makePost({
		id: "post-002",
		name: "Pending Article",
		slug: "pending-article",
		wordCount: 7,
	});
	const articles = [inventoryArticle(post), inventoryArticle(pendingPost)];
	const { root } = await importFixture(testContext, {
		post,
		articles,
		expectedWordCount: 12,
	});
	const partial = await verifyArticles({ repoRoot: root });
	assert.equal(partial.complete, false);
	await assert.rejects(
		verifyArticles({ repoRoot: root, requireComplete: true }),
		/Import is incomplete/u,
	);
});

test("verification refuses an allowlisted legacy duplicate route file", async (testContext) => {
	const post = makePost();
	const legacyPath = "src/content/posts/Legacy Article/Legacy Article.md";
	const { root } = await importFixture(testContext, {
		post,
		articles: [inventoryArticle(post, { legacyPaths: [legacyPath] })],
	});
	const absoluteLegacyPath = path.join(root, ...legacyPath.split("/"));
	await mkdir(path.dirname(absoluteLegacyPath), { recursive: true });
	await writeFile(absoluteLegacyPath, "legacy duplicate\n");
	await assert.rejects(
		verifyArticles({ repoRoot: root }),
		/Legacy duplicate route input still exists/u,
	);
	await rm(absoluteLegacyPath);
	const result = await verifyArticles({ repoRoot: root });
	assert.equal(result.complete, true);
});
