import assert from "node:assert/strict";
import test from "node:test";
import {
	ContractError,
	serializeJson,
	VOCAL_PLATFORM,
} from "../lib/contract.js";
import { extractNextDataPost } from "../lib/extract.js";
import { validatePost } from "../lib/pipeline.js";
import { renderIndexMarkdown, renderSlateDocument } from "../lib/render.js";
import {
	inventoryArticle,
	makePage,
	makePost,
	SAMPLE_CAPTURED_AT,
} from "./helpers.js";

test("extracts only the complete props.pageProps.post object", async () => {
	const post = makePost();
	const extracted = extractNextDataPost(await makePage(post));
	assert.deepEqual(extracted, post);
	assert.equal(extracted.account, undefined);
	assert.match(serializeJson(extracted), /"unknownPostField"/u);
});

test("requires exactly one typed __NEXT_DATA__ script", async () => {
	const valid = await makePage(makePost());
	assert.throws(
		() => extractNextDataPost(valid.replace(' type="application/json"', "")),
		/type="application\/json"/u,
	);
	assert.throws(() => extractNextDataPost(`${valid}${valid}`), /found 2/u);
	assert.throws(() => extractNextDataPost("<html></html>"), /found 0/u);
});

test("fails closed on invalid Next JSON or post paths", () => {
	assert.throws(
		() =>
			extractNextDataPost(
				'<script id="__NEXT_DATA__" type="application/json">{</script>',
			),
		/invalid JSON/u,
	);
	assert.throws(
		() =>
			extractNextDataPost(
				'<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{}}}</script>',
			),
		/pageProps\.post/u,
	);
});

test("renders approved Slate paragraphs and marks deterministically", () => {
	const document = makePost().content.document;
	assert.equal(
		renderSlateDocument(document),
		"<p>Hello &amp; &lt;world&gt;<strong><em> boldly</em></strong></p>",
	);

	const unsupportedMark = structuredClone(document);
	unsupportedMark.nodes[0].nodes[0].marks.push({ type: "underline" });
	assert.throws(() => renderSlateDocument(unsupportedMark), /unsupported/u);

	const unsupportedBlock = structuredClone(document);
	unsupportedBlock.nodes[0].type = "heading-one";
	assert.throws(() => renderSlateDocument(unsupportedBlock), /unsupported/u);
});

test("renders the complete approved text edge-case matrix exactly", () => {
	const document = {
		object: "document",
		data: {},
		nodes: [
			{
				object: "block",
				type: "paragraph",
				data: {},
				nodes: [
					{
						object: "text",
						text: "Plain *markdown* [link] — “smart” ",
						marks: [],
					},
					{ object: "text", text: "bold ", marks: [{ type: "bold" }] },
					{ object: "text", text: "italic ", marks: [{ type: "italic" }] },
					{
						object: "text",
						text: "mixed",
						marks: [{ type: "bold" }, { type: "italic" }],
					},
					{ object: "text", text: "\nnext", marks: [] },
				],
			},
			{ object: "block", type: "paragraph", data: {}, nodes: [] },
		],
	};
	assert.equal(
		renderSlateDocument(document),
		"<p>Plain *markdown* [link] — “smart” <strong>bold </strong><em>italic </em><strong><em>mixed</em></strong><br />\nnext</p>\n<p></p>",
	);
});

test("maps null alt text and the exact Vocal platform literal", () => {
	const post = makePost({ heroImageAltText: null });
	const model = validatePost(post, inventoryArticle(post), SAMPLE_CAPTURED_AT);
	const markdown = renderIndexMarkdown(model.metadata, model.document);
	assert.equal(VOCAL_PLATFORM, "Vocal");
	assert.equal(model.metadata.imageAlt, null);
	assert.match(markdown, /^imageAlt: null$/mu);
	assert.match(markdown, /^ {2}platform: "Vocal"$/mu);
});

test("includes updated only when contentUpdatedAt is later than publication", () => {
	const publishedAt = "2025-01-02T03:04:05.000Z";
	for (const [contentUpdatedAt, expected] of [
		["2025-01-01T03:04:05.000Z", undefined],
		[publishedAt, undefined],
		["2025-01-03T03:04:05.000Z", "2025-01-03T03:04:05.000Z"],
	]) {
		const post = makePost({ publishedAt, contentUpdatedAt });
		const model = validatePost(
			post,
			inventoryArticle(post),
			SAMPLE_CAPTURED_AT,
		);
		assert.equal(model.metadata.updated, expected);
	}
});

test("requires an absolute HTTPS heroImage.id during post validation", () => {
	for (const id of [
		"http://images.example.test/original.png",
		"/original.png",
	]) {
		const basePost = makePost();
		const post = makePost({ heroImage: { ...basePost.heroImage, id } });
		assert.throws(
			() => validatePost(post, inventoryArticle(post), SAMPLE_CAPTURED_AT),
			/absolute URL|HTTPS/u,
		);
	}
});

test("fails closed on nonempty body media and embed collections", () => {
	for (const field of ["images", "oEmbeds"]) {
		const post = makePost();
		post.content[field] = [{ id: "unsupported" }];
		assert.throws(
			() => validatePost(post, inventoryArticle(post), SAMPLE_CAPTURED_AT),
			/unsupported media renderer/u,
		);
	}
});

test("rejects unsafe integers instead of silently rounding them", async () => {
	const page = await makePage(
		makePost({ unsafe: Number.MAX_SAFE_INTEGER + 1 }),
	);
	assert.throws(
		() => extractNextDataPost(page),
		(error) =>
			error instanceof ContractError && /unsafe integer/u.test(error.message),
	);
});
