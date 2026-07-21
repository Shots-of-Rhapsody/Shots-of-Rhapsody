import assert from "node:assert/strict";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { verifyBuiltSite } from "../../verify-built-site.mjs";
import { importArticles } from "../lib/pipeline.js";
import {
	makeRepository,
	SAMPLE_CAPTURED_AT,
	SAMPLE_SLUG,
} from "./helpers.js";

const SITE = "https://shots-of-rhapsody.github.io/Shots-of-Rhapsody/";

function escapeHtml(value) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

test("verifies built local routes, metadata, RSS, and manifested Vocal output", async (testContext) => {
	const { root, post } = await makeRepository(testContext);
	await importArticles({
		repoRoot: root,
		slugs: [SAMPLE_SLUG],
		write: true,
		capturedAt: SAMPLE_CAPTURED_AT,
	});

	const dist = path.join(root, "dist");
	const postDirectory = path.join(dist, "posts", SAMPLE_SLUG);
	const assetDirectory = path.join(dist, "_astro");
	await mkdir(postDirectory, { recursive: true });
	await mkdir(assetDirectory, { recursive: true });
	const localUrl = `${SITE}posts/${SAMPLE_SLUG}/`;
	const imageUrl = `${SITE}_astro/hero.png`;
	const sourceUrl = `https://vocal.media/fiction/${SAMPLE_SLUG}`;
	const jsonLd = {
		"@context": "https://schema.org",
		"@type": "BlogPosting",
		headline: post.name,
		alternativeHeadline: post.subtitle,
		description: post.subtitle,
		keywords: post.tags.map((tag) => tag.name),
		author: { "@type": "Person", name: "Tai Song" },
		datePublished: post.publishedAt,
		dateModified: post.contentUpdatedAt,
		url: localUrl,
		mainEntityOfPage: { "@type": "WebPage", "@id": localUrl },
		image: {
			"@type": "ImageObject",
			url: imageUrl,
			contentUrl: imageUrl,
			sameAs: post.heroImage.id,
			description: post.heroImageAltText,
			caption: post.heroImageCaption,
		},
		isBasedOn: sourceUrl,
		articleSection: post.vocalSite.name,
		wordCount: post.wordCount,
		license: "All Rights Reserved",
		copyrightNotice: "All Rights Reserved",
	};
	const html = `<!doctype html>
<html><head>
<meta name="description" content="${escapeHtml(post.subtitle)}">
<meta name="author" content="Tai Song">
<meta property="og:url" content="${localUrl}">
<meta property="og:title" content="${escapeHtml(post.name)}">
<meta property="og:description" content="${escapeHtml(post.subtitle)}">
<meta property="og:image" content="${imageUrl}">
<meta property="og:image:alt" content="${escapeHtml(post.heroImageAltText)}">
<meta name="twitter:url" content="${localUrl}">
<meta name="twitter:image" content="${imageUrl}">
<meta name="twitter:image:alt" content="${escapeHtml(post.heroImageAltText)}">
<link rel="canonical" href="${localUrl}">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
</head><body>
<h1 data-vocal-field="title">${escapeHtml(post.name)}</h1>
<p data-vocal-field="subtitle">${escapeHtml(post.subtitle)}</p>
<span data-vocal-field="author">By Tai Song</span>
<a data-vocal-source-url href="${sourceUrl}">Originally published on Vocal</a>
<figure data-vocal-hero><img src="${imageUrl}" alt="${escapeHtml(post.heroImageAltText)}"><figcaption data-vocal-field="image-caption">${escapeHtml(post.heroImageCaption)}</figcaption></figure>
<div data-license-name="All Rights Reserved">All Rights Reserved</div>
</body></html>`;
	await writeFile(path.join(postDirectory, "index.html"), html);
	await copyFile(
		path.join(root, "src", "content", "posts", SAMPLE_SLUG, "hero-original.png"),
		path.join(assetDirectory, "hero.png"),
	);

	const categories = [...post.tags.map((tag) => tag.name), post.vocalSite.name]
		.map((category) => `<category>${escapeHtml(category)}</category>`)
		.join("");
	const rss = `<?xml version="1.0"?><rss><channel><item>
<title>${escapeHtml(post.name)}</title><link>${localUrl}</link><guid>${localUrl}</guid>
<description>${escapeHtml(post.summary)}</description><dc:creator>Tai Song</dc:creator>
<dc:source>${sourceUrl}</dc:source>${categories}
<media:content url="${imageUrl}" medium="image" />
</item></channel></rss>`;
	await writeFile(path.join(dist, "rss.xml"), rss);
	await writeFile(
		path.join(dist, "sitemap-index.xml"),
		`<sitemapindex><sitemap><loc>${SITE}sitemap-0.xml</loc></sitemap></sitemapindex>`,
	);
	await writeFile(
		path.join(dist, "sitemap-0.xml"),
		`<urlset><url><loc>${localUrl}</loc></url></urlset>`,
	);

	const result = await verifyBuiltSite({ dist, site: SITE, repoRoot: root });
	assert.deepEqual(result, { htmlPages: 1, postPages: 1 });
});
