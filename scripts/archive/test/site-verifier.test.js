import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
	archiveBodyStructure,
	decodePagefindFragment,
	frontmatterDraftValue,
	markedAttributeValues,
	parseArguments,
	validateRobotsText,
} from "../../verify-built-site.mjs";

test("built-site CLI enables signoff enforcement only when requested", () => {
	assert.equal(parseArguments([]).requireSignoff, false);
	assert.equal(parseArguments(["--require-signoff"]).requireSignoff, true);
	assert.throws(() => parseArguments(["--unknown"]), /Unknown argument/u);
});

test("built-site body comparison normalizes HTML serialization only", () => {
	const source =
		"<p>Exact &#39;text&#39; &amp; marks</p>\n<p><strong>Bold</strong><br /><em>Italic</em></p>";
	const serialized =
		"\n<p>Exact 'text' &amp; marks</p>\n<p><strong>Bold</strong><br><em>Italic</em></p>\n";
	assert.deepEqual(
		archiveBodyStructure(serialized),
		archiveBodyStructure(source),
	);
});

test("built-site body comparison retains exact text, marks, and blocks", () => {
	const source = "<p>Exact text</p><p><strong>Marked</strong></p>";
	assert.notDeepEqual(
		archiveBodyStructure("<p>Edited text</p><p><strong>Marked</strong></p>"),
		archiveBodyStructure(source),
	);
	assert.notDeepEqual(
		archiveBodyStructure("<p>Exact text</p><p><em>Marked</em></p>"),
		archiveBodyStructure(source),
	);
	assert.notDeepEqual(
		archiveBodyStructure("<p>Exact text</p>"),
		archiveBodyStructure(source),
	);
});

test("robots policy requires the base-aware sitemap and allows Astro assets", () => {
	const site = "https://example.test/project/";
	assert.deepEqual(
		validateRobotsText(
			"User-agent: *\nAllow: /\n\nSitemap: https://example.test/project/sitemap-index.xml\n",
			site,
		),
		[],
	);
	assert.match(
		validateRobotsText(
			"User-agent: *\nDisallow: /_astro/\n\nSitemap: https://example.test/sitemap-index.xml",
			site,
		).join("\n"),
		/base-aware|must not disallow|must not block/u,
	);
});

test("frontmatter draft parsing ignores examples in the article body", () => {
	assert.equal(
		frontmatterDraftValue("---\ndraft: true\n---\n\ndraft: false"),
		true,
	);
	assert.equal(
		frontmatterDraftValue(
			"---\ntitle: Example\n---\n\n```yaml\ndraft: true\n```",
		),
		undefined,
	);
	assert.equal(
		frontmatterDraftValue("---\ndraft: true\ndraft: false\n---"),
		undefined,
	);
});

test("marked launch entries retain duplicates for fail-closed comparison", () => {
	const html =
		'<a data-archive-entry-slug="one"></a><a data-archive-entry-slug="one"></a><a></a>';
	assert.deepEqual(
		markedAttributeValues(html, "a", "data-archive-entry-slug"),
		["one", "one"],
	);
});

test("Pagefind fragment decoding accepts only the reviewed payload", () => {
	const record = { url: "/posts/example/", meta: { title: "Example" } };
	const bytes = gzipSync(
		Buffer.concat([
			Buffer.from("pagefind_dcd", "utf8"),
			Buffer.from(JSON.stringify(record), "utf8"),
		]),
	);
	assert.deepEqual(decodePagefindFragment(bytes), record);
	assert.throws(
		() =>
			decodePagefindFragment(
				gzipSync(Buffer.from(`unknown${JSON.stringify(record)}`, "utf8")),
			),
		/unknown payload prefix/u,
	);
	assert.throws(() => decodePagefindFragment(Buffer.from("not gzip")));
});
