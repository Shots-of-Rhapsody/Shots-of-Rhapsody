import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
	archiveBodyStructure,
	artifactBufferHasPrivateReference,
	decodePagefindFragment,
	frontmatterDraftValue,
	hasPrivateProtonReference,
	loadPublicationManifest,
	markedAttributeValues,
	markedField,
	parseArguments,
	publicFacingCopyViolations,
	publicReviewRobotsFailures,
	publicReviewSyndicationFailures,
	validateNoProjectRobots,
	verifyDraftSources,
	verifyMediumRenderedBodies,
	verifyNoPrivateBuildReferences,
	verifyPodcastArtifacts,
} from "../../verify-built-site.mjs";

function testSha256(bytes) {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function validMediumStagingManifest(slug, markdown) {
	const hash = `sha256:${"1".repeat(64)}`;
	return {
		schemaVersion: 1,
		state: "active",
		authority: {
			platform: "Medium",
			captureFormat: "account-export-zip",
		},
		author: {
			name: "Tai Song",
			profileUrl: "https://medium.com/@ShotsOfRhapsody",
		},
		inventoryPath: "provenance/medium/inventory.json",
		inventorySha256: hash,
		presentationSetVersion: 1,
		presentationSetSha256: hash,
		articles: [
			{
				slug,
				capturedAt: "2026-07-25T00:00:00.000Z",
				canonicalUrl: `https://medium.com/@ShotsOfRhapsody/${slug}-0123456789ab`,
				paths: {
					snapshot: `provenance/medium/posts/${slug}.json`,
					markdown,
				},
				hashes: {
					rawExport: hash,
					rawSource: hash,
					snapshot: hash,
					markdown: hash,
					bodyText: hash,
				},
				content: {
					title: "Staged Medium essay",
					subtitle: "An exact authored subtitle.",
					seriesLine: "A Ledger Series article on staging boundaries.",
					bodyBlockCount: 1,
				},
				assets: [
					{
						id: "hero",
						role: "hero",
						path: `src/content/posts/${slug}/hero.webp`,
						sha256: hash,
						acquisitionManifestSha256: hash,
						captureSha256: hash,
						pixelSha256: hash,
						mimeType: "image/webp",
						width: 1,
						height: 1,
						byteSize: 1,
					},
				],
			},
		],
	};
}

test("public-copy checks allow authored text and required self-canonical URLs", () => {
	const html = `<!doctype html><html><head>
		<link rel="canonical" href="https://shots-of-rhapsody.github.io/Shots-of-Rhapsody/posts/example/">
		<meta property="og:url" content="https://shots-of-rhapsody.github.io/Shots-of-Rhapsody/posts/example/">
		<script type="application/ld+json">{"@type":"WebSite","url":"https://shots-of-rhapsody.github.io/Shots-of-Rhapsody/","image":{"url":"https://shots-of-rhapsody.github.io/Shots-of-Rhapsody/social/site.jpg"}}</script>
	</head><body>
		<nav><a href="/archive/">Works</a></nav>
		<h1 data-archive-field="title">A Story About GitHub and Medium</h1>
		<div data-archive-body><p>A repository appears in the authored story.</p></div>
	</body></html>`;
	assert.deepEqual(publicFacingCopyViolations(html), []);
});

test("public-copy checks exempt generic authored work without exempting its page", () => {
	const html = `<!doctype html><html><body>
		<article data-authored-content><p>A Medium repository, source review, and human-reviewed transcript appear in the author's exact text.</p></article>
		<footer>Rights and permissions</footer>
	</body></html>`;
	assert.deepEqual(publicFacingCopyViolations(html), []);
	assert.match(
		publicFacingCopyViolations(
			html.replace("Rights and permissions", "GitHub repository"),
		).join("\n"),
		/platform branding|implementation language/u,
	);
});

test("public-copy checks reject editorial process language outside authored text", () => {
	for (const phrase of [
		"author-approved sources",
		"careful source review",
		"preserved author text",
		"reviewed claim by claim",
		"human-reviewed transcript",
	]) {
		assert.deepEqual(
			publicFacingCopyViolations(
				`<!doctype html><html><body><p>${phrase}</p></body></html>`,
			),
			["site-authored copy contains editorial process language"],
			phrase,
		);
	}
});

test("public-copy checks reject metadata and structured-data copy leaks", () => {
	const html = `<!doctype html><html><head>
		<meta name="description" content="Read the GitHub repository manifest.">
		<script type="application/ld+json">{"@type":"WebSite","description":"Essays preserved from author-approved sources.","publisher":{"name":"Medium"}}</script>
	</head><body><p>Reader page</p></body></html>`;
	assert.deepEqual(publicFacingCopyViolations(html), [
		"site-authored copy contains editorial process language",
		"site-authored copy contains internal implementation language",
		"site-authored copy contains third-party platform branding",
	]);
});

test("public-copy metadata checks exempt only authored article fields", () => {
	const html = `<!doctype html><html><head>
		<title>A GitHub Repository — Shots of Rhapsody</title>
		<meta name="description" content="Preserved author text from source review.">
		<meta property="og:title" content="A GitHub Repository">
		<meta property="og:description" content="Preserved author text from source review.">
		<meta property="og:image:alt" content="A human-reviewed transcript">
		<meta property="og:url" content="https://shots-of-rhapsody.github.io/Shots-of-Rhapsody/posts/example/">
		<meta property="article:tag" content="Proton">
		<script type="application/ld+json">{
			"@type":"BlogPosting",
			"@id":"https://shots-of-rhapsody.github.io/Shots-of-Rhapsody/posts/example/#article",
			"headline":"A GitHub Repository",
			"alternativeHeadline":"A Medium subtitle",
			"description":"Preserved author text from source review.",
			"keywords":["Proton","reviewed claim by claim"],
			"publisher":{"name":"Shots of Rhapsody","url":"https://shots-of-rhapsody.github.io/Shots-of-Rhapsody/"},
			"image":{"description":"A human-reviewed transcript","caption":"A Fuwari caption"}
		}</script>
	</head><body>
		<h1 data-archive-field="title">A GitHub Repository</h1>
		<div data-archive-body><p>A Medium repository appears in the authored story.</p></div>
	</body></html>`;
	assert.deepEqual(publicFacingCopyViolations(html), []);
	assert.match(
		publicFacingCopyViolations(
			html.replace(
				'"name":"Shots of Rhapsody"',
				'"name":"GitHub repository manifest"',
			),
		).join("\n"),
		/platform branding|implementation language/u,
	);
	assert.match(
		publicFacingCopyViolations(
			html.replace(
				'<meta name="description" content="Preserved author text from source review.">',
				'<meta name="description" content="Read the GitHub repository manifest.">',
			),
		).join("\n"),
		/platform branding|implementation language/u,
	);
});

test("public-copy checks preserve authored titles in collection structured data", () => {
	for (const [type, property] of [
		["CollectionPage", "itemListElement"],
		["ProfilePage", "workExample"],
	]) {
		const html = `<!doctype html><html><head>
			<script type="application/ld+json">{"@type":"${type}","name":"Shots of Rhapsody","mainEntity":{"${property}":[{"@type":"CreativeWork","name":"A Medium Repository"}]}}</script>
		</head><body></body></html>`;
		assert.deepEqual(publicFacingCopyViolations(html), [], type);
	}
});

test("public-copy checks scan site-created card controls around authored fields", () => {
	const html = `<!doctype html><html><body>
		<article data-post-card-slug="example">
			<h3 class="editorial-card__title">A Medium Story</h3>
			<p class="editorial-card__subtitle">An authored repository.</p>
			<span class="editorial-card__action">Open the GitHub repository</span>
		</article>
	</body></html>`;
	assert.match(
		publicFacingCopyViolations(html).join("\n"),
		/platform branding|implementation language/u,
	);
});

test("public-copy checks reject platform branding and implementation language", () => {
	const html = `<!doctype html><html><head>
		<meta name="generator" content="Astro">
		<meta name="twitter:card" content="summary_large_image">
		<script type="application/ld+json">{"@type":"BlogPosting","isBasedOn":"https://vocal.media/example"}</script>
	</head><body>
		<p>Read the repository manifest on GitHub.</p>
		<a href="https://medium.com/example">Source</a>
	</body></html>`;
	assert.deepEqual(publicFacingCopyViolations(html), [
		"framework generator metadata is public",
		"platform-specific social metadata is public",
		"site-authored copy contains internal implementation language",
		"site-authored copy contains third-party platform branding",
		"site-authored navigation exposes a third-party platform link",
		"structured data exposes historical-source provenance",
	]);
});

test("public-copy checks reject source-branded data attributes", () => {
	const html = `<!doctype html><html><body>
		<article data-medium-field="title">An authored title</article>
		<figure data-vocal-hero></figure>
	</body></html>`;
	assert.deepEqual(publicFacingCopyViolations(html), [
		"public HTML exposes source-branded data attributes",
	]);
});

test("built-site CLI enables signoff enforcement only when requested", () => {
	assert.equal(parseArguments([]).requireSignoff, false);
	assert.equal(parseArguments([]).releaseTarget, "catalog");
	assert.equal(parseArguments([]).reviewBuild, false);
	assert.equal(parseArguments(["--require-signoff"]).requireSignoff, true);
	assert.equal(parseArguments(["--review-build"]).reviewBuild, true);
	assert.equal(
		parseArguments(["--release-target", "archive"]).releaseTarget,
		"archive",
	);
	assert.throws(
		() => parseArguments(["--release-target", "v1.1.0"]),
		/Unsupported release target/u,
	);
	assert.throws(() => parseArguments(["--unknown"]), /Unknown argument/u);
});

test("catalog publication mode preserves the sealed archive and exact contract", async (context) => {
	const root = await mkdtemp(path.join(tmpdir(), "publication-catalog-"));
	context.after(() => rm(root, { recursive: true, force: true }));
	const articles = [];
	const entries = [];
	for (let index = 1; index <= 11; index += 1) {
		const slug = `archive-${index}`;
		const markdown = `src/content/posts/${slug}/index.md`;
		await mkdir(path.join(root, "src", "content", "posts", slug), {
			recursive: true,
		});
		await writeFile(
			path.join(root, ...markdown.split("/")),
			`---\ntitle: ${JSON.stringify(`Archive ${index}`)}\npublished: ${JSON.stringify(`2026-07-${String(index).padStart(2, "0")}T00:00:00.000Z`)}\n---\n`,
		);
		articles.push({ slug, paths: { markdown } });
		entries.push({ slug, source: "tai-song", markdown, section: "fiction" });
	}
	await mkdir(path.join(root, "provenance"), { recursive: true });
	await writeFile(
		path.join(root, "provenance", "publication-catalog.json"),
		JSON.stringify({ schemaVersion: 1, entries }),
	);
	const failures = [];
	const manifest = await loadPublicationManifest(
		root,
		{ articles },
		"catalog",
		failures,
	);
	assert.deepEqual(failures, []);
	assert.equal(manifest.articles.length, 11);

	await writeFile(
		path.join(root, "provenance", "publication-catalog.json"),
		JSON.stringify({
			schemaVersion: 1,
			entries: [{ ...entries[0], unexpected: true }, ...entries.slice(1)],
		}),
	);
	const malformedFailures = [];
	await loadPublicationManifest(
		root,
		{ articles },
		"catalog",
		malformedFailures,
	);
	assert.match(malformedFailures.join("\n"), /entry contract is invalid/u);

	const mediumSlug = "medium-essay";
	const mediumMarkdown = `src/content/posts/${mediumSlug}/index.md`;
	await mkdir(path.join(root, "src", "content", "posts", mediumSlug), {
		recursive: true,
	});
	await writeFile(
		path.join(root, ...mediumMarkdown.split("/")),
		'---\ntitle: "Medium Essay"\npublished: "2026-07-25T00:00:00.000Z"\ndraft: false\nsection: "fiction"\n---\n',
	);
	await writeFile(
		path.join(root, "provenance", "publication-catalog.json"),
		JSON.stringify({
			schemaVersion: 1,
			entries: [
				...entries,
				{
					slug: mediumSlug,
					source: "medium",
					markdown: mediumMarkdown,
					section: "fiction",
				},
			],
		}),
	);
	const classificationFailures = [];
	await loadPublicationManifest(
		root,
		{ articles },
		"catalog",
		classificationFailures,
	);
	assert.match(classificationFailures.join("\n"), /entry contract is invalid/u);
});

test("manifest-bound Medium staging stays private without requiring draft true", async (context) => {
	const root = await mkdtemp(path.join(tmpdir(), "medium-staging-boundary-"));
	context.after(() => rm(root, { recursive: true, force: true }));
	const articles = [];
	const entries = [];
	for (let index = 1; index <= 11; index += 1) {
		const slug = `archive-${index}`;
		const markdown = `src/content/posts/${slug}/index.md`;
		await mkdir(path.join(root, "src", "content", "posts", slug), {
			recursive: true,
		});
		await writeFile(
			path.join(root, ...markdown.split("/")),
			`---\ntitle: ${JSON.stringify(`Archive ${index}`)}\npublished: ${JSON.stringify(`2026-07-${String(index).padStart(2, "0")}T00:00:00.000Z`)}\n---\n`,
		);
		articles.push({ slug, paths: { markdown } });
		entries.push({ slug, source: "tai-song", markdown, section: "fiction" });
	}

	const stagedSlug = "staged-medium-essay";
	const stagedMarkdown = `src/content/posts/${stagedSlug}/index.md`;
	const unknownSlug = "unknown-essay";
	const unknownMarkdown = `src/content/posts/${unknownSlug}/index.md`;
	for (const [slug, markdown] of [
		[stagedSlug, stagedMarkdown],
		[unknownSlug, unknownMarkdown],
	]) {
		await mkdir(path.join(root, "src", "content", "posts", slug), {
			recursive: true,
		});
		await writeFile(
			path.join(root, ...markdown.split("/")),
			`---\ntitle: ${JSON.stringify(slug)}\npublished: "2026-07-25T00:00:00.000Z"\ndraft: false\nsection: "nonfiction"\n---\n`,
		);
	}

	await mkdir(path.join(root, "provenance", "medium"), { recursive: true });
	await writeFile(
		path.join(root, "provenance", "publication-catalog.json"),
		JSON.stringify({ schemaVersion: 1, entries }),
	);
	await writeFile(
		path.join(root, "provenance", "medium", "manifest.json"),
		JSON.stringify(validMediumStagingManifest(stagedSlug, stagedMarkdown)),
	);

	const catalogFailures = [];
	const publication = await loadPublicationManifest(
		root,
		{ articles },
		"catalog",
		catalogFailures,
	);
	assert.deepEqual(catalogFailures, []);
	assert.equal(publication.articles.length, 11);
	assert.equal(
		publication.articles.some((article) => article.slug === stagedSlug),
		false,
		"staged Medium evidence must not enter the public route inventory",
	);

	const failures = [];
	await verifyDraftSources(root, publication, failures);
	assert.deepEqual(failures, [
		`Uncataloged writing must remain an explicit draft: ${unknownMarkdown}`,
	]);

	await writeFile(
		path.join(root, "provenance", "medium", "manifest.json"),
		JSON.stringify({
			state: "active",
			articles: [{ slug: stagedSlug, paths: { markdown: stagedMarkdown } }],
		}),
	);
	const malformedFailures = [];
	await verifyDraftSources(root, publication, malformedFailures);
	assert.match(
		malformedFailures.join("\n"),
		/Medium staging manifest is invalid/u,
	);
	assert.match(
		malformedFailures.join("\n"),
		new RegExp(
			`Uncataloged writing must remain an explicit draft: ${stagedMarkdown}`,
		),
	);
});

test("Medium rendered-body verification binds exact snapshot bytes and HTML", async (context) => {
	const root = await mkdtemp(path.join(tmpdir(), "medium-built-body-"));
	context.after(() => rm(root, { recursive: true, force: true }));
	const slug = "verified-essay";
	const snapshotRelative = `provenance/medium/posts/${slug}.json`;
	const snapshot = {
		slug,
		exportTitle: "The Exported Headline",
		exportSummary: "The exported summary.",
		title: "The Display Title",
		subtitle: "The exact display subtitle.",
		seriesLine: "A Ledger Series article on exact presentation roles.",
		summary: "The exported summary.",
		description: "The exported summary.",
		author: "Tai Song",
		published: "2026-07-25T12:00:00.000Z",
		category: "Nonfiction",
		tags: ["Economics", "Society"],
		imageAlt: null,
		imageCaption: "",
		hero: {
			outputFile: "hero.webp",
			sha256: "sha256:placeholder",
			acquisitionManifestSha256: `sha256:${"1".repeat(64)}`,
			captureSha256: `sha256:${"2".repeat(64)}`,
			pixelSha256: `sha256:${"3".repeat(64)}`,
			mimeType: "image/webp",
			width: 1200,
			height: 800,
			byteSize: 0,
		},
		license: { name: "All Rights Reserved" },
		bodyHtml: "<p>Exact <em>authored</em> text.</p><p></p>",
	};
	const pageUrl =
		"https://shots-of-rhapsody.github.io/Shots-of-Rhapsody/posts/verified-essay/";
	const socialImageUrl =
		"https://shots-of-rhapsody.github.io/Shots-of-Rhapsody/social/verified-essay.jpg";
	const authorUrl =
		"https://shots-of-rhapsody.github.io/Shots-of-Rhapsody/authors/tai-song/";
	const heroBytes = Buffer.from("synthetic-medium-hero", "utf8");
	snapshot.hero.sha256 = testSha256(heroBytes);
	snapshot.hero.byteSize = heroBytes.byteLength;
	const renderPage = (
		bodyHtml,
		{ heroFirst = false, titleTag = "h1", subtitleFirst = false } = {},
	) => {
		const series = `<p data-article-field="series-line">${snapshot.seriesLine}</p>`;
		const hero = `<figure data-article-hero><div data-image-variant="hero" data-source-width="${snapshot.hero.width}" data-source-height="${snapshot.hero.height}"><picture><source type="image/avif" srcset="/hero.avif"><img src="/hero.webp" alt="" width="${snapshot.hero.width}" height="${snapshot.hero.height}"></picture></div></figure>`;
		const jsonLd = JSON.stringify({
			"@context": "https://schema.org",
			"@type": "BlogPosting",
			headline: snapshot.exportTitle,
			alternativeHeadline: snapshot.title,
			description: snapshot.description,
			author: { "@type": "Person", name: snapshot.author, url: authorUrl },
			datePublished: snapshot.published,
			url: pageUrl,
			mainEntityOfPage: { "@type": "WebPage", "@id": pageUrl },
			articleSection: snapshot.category,
			keywords: snapshot.tags,
			copyrightNotice: "All Rights Reserved",
			image: {
				"@type": "ImageObject",
				url: socialImageUrl,
				contentUrl: socialImageUrl,
				encodingFormat: "image/jpeg",
				width: 1200,
				height: 1200,
			},
		});
		const exportTitle = `<${titleTag} data-article-field="export-title">${snapshot.exportTitle}</${titleTag}>`;
		const summary = `<p data-article-field="summary">${snapshot.summary}</p>`;
		const lead = `<section data-article-lead><h2 data-article-field="title">${snapshot.title}</h2><p data-article-field="subtitle">${snapshot.subtitle}</p></section>`;
		return `<!doctype html><html><head><link rel="canonical" href="${pageUrl}"><meta name="author" content="${snapshot.author}"><meta name="description" content="${snapshot.description}"><meta property="og:title" content="${snapshot.exportTitle}"><meta property="og:description" content="${snapshot.description}"><meta property="og:image" content="${socialImageUrl}"><meta property="og:image:alt" content=""><meta property="og:image:type" content="image/jpeg"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="1200"><meta property="article:published_time" content="${snapshot.published}"><meta property="article:section" content="${snapshot.category}">${snapshot.tags.map((tag) => `<meta property="article:tag" content="${tag}">`).join("")}<script type="application/ld+json">${jsonLd}</script></head><body><article id="post-container"><header>${subtitleFirst ? `${summary}${exportTitle}` : `${exportTitle}${summary}`}<span data-article-field="author">By ${snapshot.author}</span><time data-post-published datetime="${snapshot.published}">${snapshot.published.slice(0, 10)}</time></header>${lead}${heroFirst ? `${hero}${series}` : `${series}${hero}`}<div class="article-body" data-authored-content>${bodyHtml}</div><aside data-license-name="All Rights Reserved"></aside></article></body></html>`;
	};
	const renderRss = ({
		title = snapshot.exportTitle,
		body = snapshot.bodyHtml,
	} = {}) =>
		`<?xml version="1.0" encoding="UTF-8"?><rss xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><item><title>${title}</title><link>${pageUrl}</link><guid>${pageUrl}</guid><description>${snapshot.summary}</description><pubDate>${new Date(snapshot.published).toUTCString()}</pubDate><dc:creator>${snapshot.author}</dc:creator>${snapshot.tags.map((tag) => `<category>${tag}</category>`).join("")}<category>${snapshot.category}</category><media:content url="${socialImageUrl}" medium="image" type="image/jpeg" width="1200" height="1200" /><content:encoded><![CDATA[<section><h2>${snapshot.title}</h2><p>${snapshot.subtitle}</p><p>${snapshot.seriesLine}</p></section><figure><img src="${socialImageUrl}" alt="" width="1200" height="1200"></figure>${body}]]></content:encoded></item></channel></rss>`;
	const snapshotBytes = Buffer.from(JSON.stringify(snapshot), "utf8");
	await mkdir(path.join(root, "provenance", "medium", "posts"), {
		recursive: true,
	});
	await mkdir(path.join(root, "dist", "posts", slug), { recursive: true });
	await mkdir(path.join(root, "src", "content", "posts", slug), {
		recursive: true,
	});
	await writeFile(
		path.join(root, "src", "content", "posts", slug, "hero.webp"),
		heroBytes,
	);
	await writeFile(
		path.join(root, ...snapshotRelative.split("/")),
		snapshotBytes,
	);
	const mediumManifest = {
		state: "active",
		articles: [
			{
				slug,
				paths: { snapshot: snapshotRelative },
				hashes: { snapshot: testSha256(snapshotBytes) },
				assets: [
					{
						role: "hero",
						path: `src/content/posts/${slug}/hero.webp`,
						sha256: snapshot.hero.sha256,
						acquisitionManifestSha256: snapshot.hero.acquisitionManifestSha256,
						captureSha256: snapshot.hero.captureSha256,
						pixelSha256: snapshot.hero.pixelSha256,
						mimeType: snapshot.hero.mimeType,
						width: snapshot.hero.width,
						height: snapshot.hero.height,
						byteSize: snapshot.hero.byteSize,
					},
				],
			},
		],
	};
	await writeFile(
		path.join(root, "provenance", "medium", "manifest.json"),
		JSON.stringify(mediumManifest),
	);
	const pagePath = path.join(root, "dist", "posts", slug, "index.html");
	await writeFile(pagePath, renderPage(snapshot.bodyHtml));
	await writeFile(path.join(root, "dist", "rss.xml"), renderRss());
	const publicationManifest = { articles: [{ slug, source: "medium" }] };
	const failures = [];
	await verifyMediumRenderedBodies(
		root,
		path.join(root, "dist"),
		publicationManifest,
		failures,
	);
	assert.deepEqual(failures, []);

	await writeFile(pagePath, renderPage("<p>Edited text.</p><p></p>"));
	const editedFailures = [];
	await verifyMediumRenderedBodies(
		root,
		path.join(root, "dist"),
		publicationManifest,
		editedFailures,
	);
	assert.match(editedFailures.join("\n"), /rendered body differs/u);

	await writeFile(pagePath, renderPage(snapshot.bodyHtml, { heroFirst: true }));
	const orderFailures = [];
	await verifyMediumRenderedBodies(
		root,
		path.join(root, "dist"),
		publicationManifest,
		orderFailures,
	);
	assert.match(orderFailures.join("\n"), /rendered order/u);

	await writeFile(pagePath, renderPage(snapshot.bodyHtml, { titleTag: "h2" }));
	const semanticFailures = [];
	await verifyMediumRenderedBodies(
		root,
		path.join(root, "dist"),
		publicationManifest,
		semanticFailures,
	);
	assert.match(semanticFailures.join("\n"), /wrong semantic element/u);

	await writeFile(
		pagePath,
		renderPage(snapshot.bodyHtml, { subtitleFirst: true }),
	);
	const headerOrderFailures = [];
	await verifyMediumRenderedBodies(
		root,
		path.join(root, "dist"),
		publicationManifest,
		headerOrderFailures,
	);
	assert.match(headerOrderFailures.join("\n"), /header must preserve/u);

	await writeFile(pagePath, renderPage(snapshot.bodyHtml));
	await writeFile(
		path.join(root, "dist", "rss.xml"),
		renderRss({ title: "Edited title" }),
	);
	const rssFailures = [];
	await verifyMediumRenderedBodies(
		root,
		path.join(root, "dist"),
		publicationManifest,
		rssFailures,
	);
	assert.match(rssFailures.join("\n"), /RSS title differs/u);
	await writeFile(path.join(root, "dist", "rss.xml"), renderRss());

	await writeFile(
		path.join(root, "dist", "rss.xml"),
		renderRss({ body: "<p>Edited RSS body.</p><p></p>" }),
	);
	const rssBodyFailures = [];
	await verifyMediumRenderedBodies(
		root,
		path.join(root, "dist"),
		publicationManifest,
		rssBodyFailures,
	);
	assert.match(rssBodyFailures.join("\n"), /RSS content body differs/u);
	await writeFile(path.join(root, "dist", "rss.xml"), renderRss());

	mediumManifest.articles[0].hashes.snapshot = `sha256:${"0".repeat(64)}`;
	await writeFile(
		path.join(root, "provenance", "medium", "manifest.json"),
		JSON.stringify(mediumManifest),
	);
	const staleFailures = [];
	await verifyMediumRenderedBodies(
		root,
		path.join(root, "dist"),
		publicationManifest,
		staleFailures,
	);
	assert.match(staleFailures.join("\n"), /snapshot hash differs/u);
});

test("podcast artifact allowlist accepts only approved routes, audio, cover, and VTT", () => {
	const distRoot = path.resolve("synthetic-dist");
	const episode = {
		slug: "episode-one",
		audio: { publicPath: "/media/podcast/episode-one.mp3" },
		transcript: {
			publicPath: "/podcast/episode-one/transcript/",
			vttPath: "/podcast/episode-one/transcript.vtt",
		},
	};
	const expected = [
		"podcast/index.html",
		"podcast/episode-one/index.html",
		"podcast/episode-one/transcript/index.html",
		"podcast/episode-one/transcript.vtt",
		"media/podcast/episode-one.mp3",
		"media/podcast/shots-of-rhapsody-podcast-cover.png",
	].map((relative) => path.join(distRoot, ...relative.split("/")));
	const failures = [];
	verifyPodcastArtifacts(expected, distRoot, [episode], failures);
	assert.deepEqual(failures, []);

	verifyPodcastArtifacts(
		[...expected, path.join(distRoot, "media", "podcast", "unapproved.mp3")],
		distRoot,
		[episode],
		failures,
	);
	assert.match(failures.join("\n"), /unexpectedly includes/u);
});

test("podcast artifact allowlist accepts a transcript-free episode", () => {
	const distRoot = path.resolve("synthetic-dist");
	const episode = {
		slug: "episode-one",
		audio: { publicPath: "/media/podcast/episode-one.mp3" },
		transcript: null,
	};
	const expected = [
		"podcast/index.html",
		"podcast/episode-one/index.html",
		"media/podcast/episode-one.mp3",
		"media/podcast/shots-of-rhapsody-podcast-cover.png",
	].map((relative) => path.join(distRoot, ...relative.split("/")));
	const failures = [];
	verifyPodcastArtifacts(expected, distRoot, [episode], failures);
	assert.deepEqual(failures, []);
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

test("visible archive fields ignore only serialization boundary whitespace", () => {
	const html = `<!doctype html><html><body>
		<h1 data-archive-field="title">
			The  Seventh Skin
		</h1>
	</body></html>`;
	assert.equal(markedField(html, "title"), "The  Seventh Skin");
	assert.equal(markedField(html, "missing"), undefined);
	assert.equal(
		markedField(
			'<p data-archive-field="author">\nBy <a href="/author/">Tai Song</a>\n</p>',
			"author",
		),
		"By Tai Song",
	);
});

test("project artifact omits non-authoritative robots files", () => {
	assert.deepEqual(
		validateNoProjectRobots(["index.html", "sitemap-index.xml"]),
		[],
	);
	assert.match(
		validateNoProjectRobots(["nested\\robots.txt"]).join("\n"),
		/host-root file can control crawling/u,
	);
});

test("public-review pages require exact noindex directives and omit feeds", () => {
	const html = `<html><head><meta name="robots" content="noindex, nofollow, noarchive, nosnippet"></head></html>`;
	assert.deepEqual(publicReviewRobotsFailures(html, "index.html"), []);
	assert.match(
		publicReviewRobotsFailures(
			'<meta name="robots" content="noindex, nofollow">',
			"index.html",
		).join("\n"),
		/noarchive/u,
	);
	assert.deepEqual(
		publicReviewSyndicationFailures(["index.html", "pagefind/pagefind.js"]),
		[],
	);
	assert.match(
		publicReviewSyndicationFailures([
			"rss.xml",
			"sitemap-index.xml",
			"sitemap-0.xml",
		]).join("\n"),
		/rss\.xml.*sitemap-index\.xml.*sitemap-0\.xml/u,
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

test("full decoded Pagefind records reject nested private source data", () => {
	const privateUrl = [
		"https://docs.proton.me",
		"u",
		"1",
		"document",
		"synthetic-test-only",
	].join("/");
	const record = {
		url: "/posts/example/",
		meta: { title: "Example" },
		content: "Public excerpt",
		internal: { nested: [{ source: privateUrl }] },
	};
	const decoded = decodePagefindFragment(
		gzipSync(
			Buffer.concat([
				Buffer.from("pagefind_dcd", "utf8"),
				Buffer.from(JSON.stringify(record), "utf8"),
			]),
		),
	);
	assert.equal(hasPrivateProtonReference(decoded), true);
	assert.equal(
		hasPrivateProtonReference({ rawSourcePath: "redacted-but-forbidden" }),
		true,
	);
	assert.equal(
		hasPrivateProtonReference("http://localhost:4321/preview"),
		true,
	);
	assert.equal(
		hasPrivateProtonReference("file:///synthetic/local-preview"),
		true,
	);
	assert.equal(
		hasPrivateProtonReference(
			["C:", "Users", "synthetic", "preview"].join("\\"),
		),
		true,
	);
});

test("all built artifacts are scanned as bytes without exposing leak details", async (context) => {
	const root = await mkdtemp(path.join(tmpdir(), "site-verifier-"));
	context.after(() => rm(root, { recursive: true, force: true }));
	const cleanFile = path.join(root, "clean.bin");
	const privateFile = path.join(root, "private.bin");
	const rawSourceDirectory = [".", "proton-import"].join("");
	const rawSourcePath = [rawSourceDirectory, "raw", "private-id"].join("/");
	await writeFile(cleanFile, Buffer.from([0, 255, 1, 128, 2]));
	await writeFile(
		privateFile,
		Buffer.concat([
			Buffer.from([0, 255, 254]),
			Buffer.from(rawSourcePath, "ascii"),
			Buffer.from([253, 0]),
		]),
	);

	assert.equal(
		artifactBufferHasPrivateReference(await readFile(privateFile)),
		true,
	);
	const failures = [];
	await verifyNoPrivateBuildReferences([cleanFile, privateFile], failures);
	assert.deepEqual(failures, [
		"built artifact 2 contains a private, raw-source, or local-runtime reference",
	]);
	assert.equal(failures[0].includes(rawSourcePath), false);
	assert.equal(failures[0].includes(path.basename(privateFile)), false);
});
