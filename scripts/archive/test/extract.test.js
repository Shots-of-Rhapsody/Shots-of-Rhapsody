import assert from "node:assert/strict";
import test from "node:test";
import { extractProtonHtml } from "../lib/extract.js";
import { bodyTextSha256, renderBodyHtml } from "../lib/render.js";
import { readFixture, SAMPLE_CAPTION, SAMPLE_SUBTITLE } from "./helpers.js";

test("extracts the observed Proton HTML contract without retaining its URL", async () => {
	const result = extractProtonHtml(await readFixture());
	assert.equal(result.subtitle, SAMPLE_SUBTITLE);
	assert.equal(result.caption, SAMPLE_CAPTION);
	assert.deepEqual(result.hero, { alt: "" });
	assert.equal(result.document.blocks.length, 4);
	assert.equal(
		renderBodyHtml(result.document),
		"<p>First body *markdown* [link] — 漢字 😀</p>\n<p>Plain text <strong>bold</strong> <em>italic</em> <strong><em>mixed</em></strong><br />next line</p>\n<p><br /></p>\n<p></p>",
	);
	assert.match(bodyTextSha256(result.document), /^sha256:[0-9a-f]{64}$/u);
	assert.doesNotMatch(JSON.stringify(result), /media\.example\.invalid/u);
});

test("preserves source code points, entities, marks, breaks, and empty blocks", async () => {
	const result = extractProtonHtml(await readFixture());
	const [first, marked, breakOnly, empty] = result.document.blocks;
	assert.equal(
		first.children[0].text,
		"First body *markdown* [link] — 漢字 😀",
	);
	assert.equal(marked.children[0].text, "Plain text ");
	assert.deepEqual(marked.children[1].marks, ["bold"]);
	assert.deepEqual(marked.children[3].marks, ["italic"]);
	assert.deepEqual(marked.children[5].marks, ["bold", "italic"]);
	assert.deepEqual(marked.children[6], { type: "break" });
	assert.deepEqual(breakOnly.children, [{ type: "break" }]);
	assert.deepEqual(empty.children, []);
});

test("accepts the observed split subtitle/hero lead and inert author link", () => {
	const html = `<h2 dir="ltr" style="text-align: start"><span style="font-size: 16px; white-space: pre-wrap">${SAMPLE_SUBTITLE.replace("&", "&amp;")}</span></h2><p dir="ltr" style="text-align: start"><a href="https://vocal.media/authors/tai-song"></a><br><img src="https://media.example.invalid/private-object" alt="" width="inherit" height="inherit"><br><span style="white-space: pre-wrap">${SAMPLE_CAPTION.replace("&", "&amp;")}</span><br><br><br><span style="white-space: pre-wrap">Body resumes here.</span></p><p style="text-align: start"><br></p>`;
	const result = extractProtonHtml(html);
	assert.equal(result.leadTitle, undefined);
	assert.equal(result.subtitle, SAMPLE_SUBTITLE);
	assert.equal(result.caption, SAMPLE_CAPTION);
	assert.equal(result.document.blocks.length, 2);
	assert.equal(
		renderBodyHtml(result.document),
		"<p>Body resumes here.</p>\n<p><br /></p>",
	);
	assert.doesNotMatch(JSON.stringify(result), /vocal\.media\/authors/u);

	assert.throws(
		() =>
			extractProtonHtml(
				html.replace("vocal.media/authors/tai-song", "example.invalid/author"),
			),
		/reviewed Tai Song Vocal author URL/u,
	);
	assert.throws(
		() => extractProtonHtml(html.replace("</a>", "not inert</a>")),
		/must be inert and have no children/u,
	);
});

test("extracts an optional observed lead title without adding it to the body", () => {
	const html = `<h1 dir="ltr" style="font-size: 16px; text-align: start"><span style="white-space: pre-wrap">Exact Article</span><br><br><span style="white-space: pre-wrap">${SAMPLE_SUBTITLE.replace("&", "&amp;")}</span><br><br><img src="https://media.example.invalid/private-object" alt="" width="inherit" height="inherit"><br><br><span style="white-space: pre-wrap">${SAMPLE_CAPTION.replace("&", "&amp;")}</span><br><br><br><span style="white-space: pre-wrap">First body block.</span></h1>`;
	const result = extractProtonHtml(html);
	assert.equal(result.leadTitle, "Exact Article");
	assert.equal(result.subtitle, SAMPLE_SUBTITLE);
	assert.equal(renderBodyHtml(result.document), "<p>First body block.</p>");
	assert.doesNotMatch(result.bodyHtml ?? "", /Exact Article/u);
});

test("fails closed on unknown elements, comments, events, and unsafe CSS", async () => {
	const fixture = await readFixture();
	for (const [name, html, pattern] of [
		[
			"script",
			fixture.replace("</h2>", "<script>run()</script></h2>"),
			/unsupported element/u,
		],
		[
			"unknown element",
			fixture
				.replace("<b><strong", "<u><strong")
				.replace("</strong></b>", "</strong></u>"),
			/unsupported element/u,
		],
		[
			"comment",
			fixture.replace("<p dir=", "<!-- private --><p dir="),
			/unsupported comment/u,
		],
		[
			"event handler",
			fixture.replace('<p dir="ltr"', '<p onclick="run()" dir="ltr"'),
			/unsupported key "onclick"/u,
		],
		[
			"unsafe CSS",
			fixture.replace(
				"text-align: start",
				"background: url(https://example.invalid/x)",
			),
			/unsupported CSS/u,
		],
	]) {
		assert.throws(() => extractProtonHtml(html), pattern, name);
	}
});

test("requires exactly one HTTPS hero and rejects other remote media", async () => {
	const fixture = await readFixture();
	const image = fixture.match(/<img\b[^>]*>/u)[0];
	for (const [name, html, pattern] of [
		["missing hero", fixture.replace(image, ""), /exactly one hero/u],
		[
			"duplicate hero",
			fixture.replace(image, `${image}${image}`),
			/exactly one hero/u,
		],
		[
			"insecure hero",
			fixture.replace("https://", "http://"),
			/must use HTTPS/u,
		],
		[
			"remote iframe",
			fixture.replace(
				"</h2>",
				'<iframe src="https://example.invalid"></iframe></h2>',
			),
			/unsupported element/u,
		],
	]) {
		assert.throws(() => extractProtonHtml(html), pattern, name);
	}
});

test("requires the exact three-break caption/body separator", async () => {
	const fixture = await readFixture();
	const separator = "</span><br><br><br><span style";
	assert.ok(fixture.includes(separator));
	for (const replacement of [
		"</span><br><br><span style",
		"</span><br><br><br><br><span style",
	]) {
		assert.throws(
			() => extractProtonHtml(fixture.replace(separator, replacement)),
			/three-<br> caption\/body separator/u,
		);
	}
});

test("rejects malformed HTML and unsupported top-level blocks", async () => {
	const fixture = await readFixture();
	assert.throws(
		() =>
			extractProtonHtml(
				fixture.replace('<h2 dir="ltr"', '<h2 dir="ltr" dir="ltr"'),
			),
		/malformed HTML/u,
	);
	assert.throws(
		() => extractProtonHtml(fixture.replace("<p dir=", "<h3 dir=")),
		/unsupported top-level element/u,
	);
});
