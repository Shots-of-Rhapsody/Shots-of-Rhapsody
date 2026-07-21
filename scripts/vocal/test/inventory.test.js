import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { inspectInventoryArticles } from "../lib/pipeline.js";
import {
	makePage,
	makePost,
	makeRepository,
	SAMPLE_SLUG,
	writeRawArticle,
} from "./helpers.js";

test("prints the saved post hero URL after fixed identity validation", async (testContext) => {
	const { root, post } = await makeRepository(testContext);
	const result = await inspectInventoryArticles({
		repoRoot: root,
		slugs: [SAMPLE_SLUG],
	});
	assert.deepEqual(result.articles, [
		{
			slug: SAMPLE_SLUG,
			title: post.name,
			sourceId: post.id,
			sourceUrl: `https://vocal.media/fiction/${SAMPLE_SLUG}`,
			communitySlug: "fiction",
			heroImageUrl: post.heroImage.id,
		},
	]);
});

test("fails closed when saved HTML is missing or malformed", async (testContext) => {
	const missing = await makeRepository(testContext, { writeRaw: false });
	await assert.rejects(
		inspectInventoryArticles({
			repoRoot: missing.root,
			slugs: [SAMPLE_SLUG],
		}),
		/Raw Vocal page/u,
	);

	const malformed = await makeRepository(testContext);
	await writeFile(
		path.join(
			malformed.root,
			".vocal-import",
			"raw",
			SAMPLE_SLUG,
			"page.html",
		),
		"<html>not a saved Vocal page</html>",
	);
	await assert.rejects(
		inspectInventoryArticles({
			repoRoot: malformed.root,
			slugs: [SAMPLE_SLUG],
		}),
		/__NEXT_DATA__/u,
	);
});

test("fails closed on a post by the wrong author", async (testContext) => {
	const post = makePost({ author: { name: "Someone Else" } });
	const { root } = await makeRepository(testContext, { post, writeRaw: false });
	await writeRawArticle(root, post);
	await assert.rejects(
		inspectInventoryArticles({ repoRoot: root, slugs: [SAMPLE_SLUG] }),
		/post\.author\.name/u,
	);
});

test("fails closed when saved post identity disagrees with inventory", async (testContext) => {
	const { root } = await makeRepository(testContext);
	await writeFile(
		path.join(root, ".vocal-import", "raw", SAMPLE_SLUG, "page.html"),
		await makePage(makePost({ name: "Different Title" })),
	);
	await assert.rejects(
		inspectInventoryArticles({ repoRoot: root, slugs: [SAMPLE_SLUG] }),
		/does not exactly match inventory title/u,
	);
});
