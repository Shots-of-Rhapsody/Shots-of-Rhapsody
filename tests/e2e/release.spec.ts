import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import {
	type APIRequestContext,
	type ConsoleMessage,
	expect,
	type Page,
	type Request,
	type TestInfo,
	test,
} from "@playwright/test";
import { IS_PUBLIC_REVIEW } from "../../src/data/build-mode";
import { PODCAST_EPISODES, PODCAST_SHOW } from "../../src/data/podcast";
import { getVisiblePodcastEpisodes } from "../../src/data/podcast-approval";
import { PUBLICATION_CATALOG } from "../../src/data/publication-catalog";
import {
	CARD_IMAGE_WIDTHS,
	FEATURED_IMAGE_SIZES,
	HERO_IMAGE_SIZES,
	HERO_IMAGE_WIDTHS,
} from "../../src/utils/image-policy";
import {
	hasExternalPlaywrightBaseURL,
	playwrightBasePathname,
	playwrightBaseURL,
	playwrightOrigin,
} from "./base-url";

interface ArchiveArticle {
	slug: string;
	title: string;
	subtitle: string;
	author: string;
	imageAlt: string | null;
	imageCaption: string;
	image: { width: number; height: number };
	published: string;
	ending: string;
}

interface PublicationCatalogEntry {
	slug: string;
	source: "tai-song" | "medium" | "first-party";
	markdown: string;
	section: "fiction" | "poetry-reflection" | "nonfiction";
}

interface MediumArticle {
	slug: string;
	exportTitle: string;
	exportSummary: string | null;
	title: string;
	subtitle: string;
	seriesLine: string;
	summary: string;
	description: string;
	author: string;
	imageAlt: string | null;
	imageCaption: string;
	hero: { width: number; height: number };
	published: string;
	bodyHtml: string;
}

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const manifest = JSON.parse(
	readFileSync(
		path.join(repositoryRoot, "provenance/tai-song/manifest.json"),
		"utf8",
	),
);
const articles: ArchiveArticle[] = manifest.articles.map((entry) => {
	const snapshot = JSON.parse(
		readFileSync(path.join(repositoryRoot, entry.paths.snapshot), "utf8"),
	);
	const ending = snapshot.bodyDocument.blocks
		.toReversed()
		.flatMap((block) => block.children)
		.map((child) => child.text)
		.find((text) => text.length > 0);
	if (!ending) throw new Error(`${entry.slug}: snapshot has no ending text`);
	return {
		slug: entry.slug,
		title: snapshot.title,
		subtitle: snapshot.subtitle,
		author: snapshot.author,
		imageAlt: snapshot.imageAlt,
		imageCaption: snapshot.imageCaption,
		image: entry.image,
		published: snapshot.published,
		ending,
	};
});
const publicationCatalog = PUBLICATION_CATALOG as {
	readonly schemaVersion: number;
	readonly entries: readonly PublicationCatalogEntry[];
};
if (publicationCatalog.schemaVersion !== 1) {
	throw new Error(
		"Publication catalog schema is not supported by browser tests",
	);
}
const catalogEntries = [...publicationCatalog.entries];
const mediumManifest = JSON.parse(
	readFileSync(
		path.join(repositoryRoot, "provenance/medium/manifest.json"),
		"utf8",
	),
) as {
	state: string;
	articles: Array<{ slug: string; paths: { snapshot: string } }>;
};
const mediumInventory = JSON.parse(
	readFileSync(
		path.join(repositoryRoot, "provenance/medium/inventory.json"),
		"utf8",
	),
) as {
	candidates: Array<{
		suggestedSlug: string;
		include: boolean;
		classification: { authorship: string; format: string };
	}>;
};
const excludedResponseSlugs = mediumInventory.candidates
	.filter(
		(candidate) =>
			!candidate.include &&
			candidate.classification.authorship === "response" &&
			candidate.classification.format === "response",
	)
	.map(({ suggestedSlug }) => suggestedSlug)
	.toSorted();
if (excludedResponseSlugs.length !== 9) {
	throw new Error(
		"Browser tests require exactly nine excluded Medium responses",
	);
}
const catalogMediumSlugs = catalogEntries
	.filter(({ source }) => source === "medium")
	.map(({ slug }) => slug)
	.toSorted();
const mediumManifestBySlug = new Map(
	mediumManifest.articles.map((entry) => [entry.slug, entry]),
);
const mediumArticles: MediumArticle[] = catalogMediumSlugs.map((slug) => {
	if (mediumManifest.state !== "active") {
		throw new Error(
			`Publication catalog exposes Medium essay ${slug} before its manifest is active`,
		);
	}
	const entry = mediumManifestBySlug.get(slug);
	if (!entry) {
		throw new Error(
			`Publication catalog exposes Medium essay ${slug} without manifest evidence`,
		);
	}
	const snapshot = JSON.parse(
		readFileSync(path.join(repositoryRoot, entry.paths.snapshot), "utf8"),
	) as MediumArticle;
	if (snapshot.slug !== entry.slug) {
		throw new Error(`${entry.slug}: Medium snapshot slug differs`);
	}
	return snapshot;
});
const sealedArchiveSlugSet = new Set(articles.map(({ slug }) => slug));
const expectedWritingSlugs = catalogEntries.map(({ slug }) => slug).toSorted();
if (
	expectedWritingSlugs.length < articles.length ||
	new Set(expectedWritingSlugs).size !== expectedWritingSlugs.length ||
	articles.some((article) => !expectedWritingSlugs.includes(article.slug))
) {
	throw new Error(
		"Publication catalog must uniquely retain every sealed archive article",
	);
}
const creativeWritingSlugs = catalogEntries
	.filter(({ section }) => section !== "nonfiction")
	.map(({ slug }) => slug)
	.toSorted();
const nonfictionEntries = catalogEntries.filter(
	({ section }) => section === "nonfiction",
);
const nonfictionSlugs = nonfictionEntries.map(({ slug }) => slug).toSorted();
const approvedPodcastEpisodes = getVisiblePodcastEpisodes();
const approvedPodcastSlugs = approvedPodcastEpisodes
	.map(({ slug }) => slug)
	.toSorted();
const approvedPodcastSlugSet = new Set(approvedPodcastSlugs);
const expectedPrimaryNavigation = [
	"Works",
	...(nonfictionEntries.length > 0 ? ["Nonfiction"] : []),
	...(approvedPodcastEpisodes.length > 0 ? ["Podcast"] : []),
	"About",
];
const continuationBySlug = new Map<string, string>([
	[
		"before-the-sky-went-quiet-part-i-the-girl-who-faded",
		"before-the-sky-went-quiet-part-ii-the-goodbye",
	],
	[
		"before-the-sky-went-quiet-part-ii-the-goodbye",
		"before-the-sky-went-quiet-part-iii-the-echo-that-stayed",
	],
	[
		"before-the-sky-went-quiet-part-iii-the-echo-that-stayed",
		"the-seventh-skin",
	],
	["the-seventh-skin", "cold-children"],
	["cold-children", "lanterns-for-the-unreturning"],
	["lanterns-for-the-unreturning", "the-khan-who-chose-the-grain"],
	["the-khan-who-chose-the-grain", "eggasaurus-rex"],
	["eggasaurus-rex", "before-the-sky-went-quiet-part-i-the-girl-who-faded"],
	["poetic-biography", "the-guild-a-chronicle-of-pretty-souls"],
	["the-guild-a-chronicle-of-pretty-souls", "where-we-last-were-us"],
	["where-we-last-were-us", "poetic-biography"],
]);
const draftSlugs = [
	"guide",
	"video",
	"modular-ethics/modular-ethics",
	"the-last-cup/the-last-cup",
];
const authorBio =
	"Tai Song is a Singapore-based commodity trader and trade strategist whose writing spans fiction, poetry, reflection, and nonfiction. Across global markets and imagined futures, Tai explores power, policy, inequality, memory, the consequences of invention, and the fragile things people try to preserve.";
const nonfictionDescription =
	"Essays on markets, power, policy, inequality, and a changing world.";
const forbiddenReaderProcessCopy =
	/\b(?:author-approved sources?|(?:careful\s+)?source review|preserved author text|reviewed claim by claim|human-reviewed transcripts?)\b/i;
const privateReference =
	/(\.proton-import|protonusercontent\.(?:com|ch)|docs\.proton\.me\/u\/\d+\/)/i;
class RedactedRuntimeRecorder {
	private readonly issues = new Map<string, number>();
	private readonly onConsole = (message: ConsoleMessage) => {
		this.recordPrivateReference("console", message.text());
		if (message.type() === "error") this.record("console-error");
	};
	private readonly onPageError = (error: Error) => {
		this.recordPrivateReference("page-error", error.message);
		this.record("uncaught-page-error");
	};
	private readonly onRequest = (request: Request) => {
		const requestUrl = request.url();
		this.recordPrivateReference("request", requestUrl);
		try {
			const parsed = new URL(requestUrl);
			if (
				(parsed.protocol === "http:" || parsed.protocol === "https:") &&
				(parsed.origin !== playwrightOrigin ||
					!parsed.pathname.startsWith(playwrightBasePathname))
			) {
				this.record("request-outside-project-base");
			}
		} catch {
			this.record("malformed-request-url");
		}
	};
	private readonly onRequestFailed = (request: Request) => {
		this.recordPrivateReference("failed-request", request.url());
		// Chromium may cancel a lower-priority responsive-image candidate after
		// selecting a better source. It received no HTTP failure, and every final
		// image is separately required to complete with nonzero dimensions.
		if (request.failure()?.errorText === "net::ERR_ABORTED") return;
		this.record("failed-request");
	};

	constructor(private readonly page: Page) {
		page.on("console", this.onConsole);
		page.on("pageerror", this.onPageError);
		page.on("request", this.onRequest);
		page.on("requestfailed", this.onRequestFailed);
	}

	private record(code: string) {
		this.issues.set(code, (this.issues.get(code) ?? 0) + 1);
	}

	private recordPrivateReference(source: string, value: string) {
		if (privateReference.test(value)) {
			this.record(`private-reference-in-${source}`);
		}
	}

	assertClean(label: string) {
		const summary = [...this.issues]
			.toSorted(([left], [right]) => left.localeCompare(right))
			.map(([code, count]) => ({ code, count }));
		expect(summary, `${label}: redacted browser runtime failures`).toEqual([]);
	}

	stop() {
		this.page.off("console", this.onConsole);
		this.page.off("pageerror", this.onPageError);
		this.page.off("request", this.onRequest);
		this.page.off("requestfailed", this.onRequestFailed);
	}
}

const runtimeRecorders = new WeakMap<Page, RedactedRuntimeRecorder>();

function runtimeRecorder(page: Page) {
	const existing = runtimeRecorders.get(page);
	if (existing) return existing;
	const recorder = new RedactedRuntimeRecorder(page);
	runtimeRecorders.set(page, recorder);
	return recorder;
}

function expectNoPrivateReference(value: string, label: string) {
	expect(
		privateReference.test(value),
		`${label}: blocked private reference detected`,
	).toBe(false);
}

async function expectPrivacySafeState(page: Page, label: string) {
	const containsPrivateReference = await page
		.locator("html")
		.evaluate(
			(element, pattern) => new RegExp(pattern, "i").test(element.outerHTML),
			privateReference.source,
		);
	expect(
		containsPrivateReference,
		`${label}: rendered page contains a blocked private reference`,
	).toBe(false);
	runtimeRecorder(page).assertClean(label);
}

test.beforeEach(async ({ page }) => {
	runtimeRecorder(page);
});

test.afterEach(async ({ page }, testInfo) => {
	const recorder = runtimeRecorder(page);
	recorder.stop();
	try {
		recorder.assertClean(`${testInfo.title}: complete interaction runtime`);
	} finally {
		runtimeRecorders.delete(page);
	}
});

function sitePath(relativePath = "") {
	return `/Shots-of-Rhapsody/${relativePath}`.replace(/\/{2,}/g, "/");
}

function absoluteSiteUrl(relativePath = "") {
	return new URL(relativePath, playwrightBaseURL).toString();
}

async function setTheme(page: Page, theme: "light" | "dark") {
	await page.emulateMedia({ colorScheme: theme });
	await page.goto("./", { waitUntil: "domcontentloaded" });
	await page.evaluate((selectedTheme) => {
		localStorage.setItem("theme", selectedTheme);
	}, theme);
	await page.reload({ waitUntil: "networkidle" });
}

async function expectTheme(page: Page, theme: "light" | "dark") {
	const isDark = await page
		.locator("html")
		.evaluate((element) => element.classList.contains("dark"));
	expect(isDark).toBe(theme === "dark");
}

async function expectHealthyPage(page: Page, relativePath: string) {
	const response = await page.goto(relativePath || "./", {
		waitUntil: "networkidle",
	});
	expect(response, `No navigation response for ${relativePath}`).not.toBeNull();
	expect(response?.status(), relativePath).toBe(200);
	expect(await page.locator("body").innerText()).not.toHaveLength(0);
	if (IS_PUBLIC_REVIEW) {
		await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
			"content",
			"noindex, nofollow, noarchive, nosnippet",
		);
	}
	await expectPrivacySafeState(page, `Page ${relativePath || "/"}`);
	expect(await page.locator(".vite-error-overlay").count()).toBe(0);

	const images = page.locator("img");
	await images.evaluateAll((elements) => {
		for (const image of elements) {
			(image as HTMLImageElement).loading = "eager";
		}
	});
	await page.waitForFunction(
		() => [...document.images].every((image) => image.complete),
		undefined,
		{ timeout: 10_000 },
	);
	const imageFailureCount = await images.evaluateAll(
		(images) =>
			images.filter((image) => {
				const htmlImage = image as HTMLImageElement;
				return htmlImage.naturalWidth === 0 || htmlImage.naturalHeight === 0;
			}).length,
	);
	expect(imageFailureCount, `Broken image count on ${relativePath}`).toBe(0);

	const insecureAssetCount = await page
		.locator("img,script,link[rel=stylesheet]")
		.evaluateAll(
			(elements) =>
				elements.filter((element) => {
					const assetUrl =
						element instanceof HTMLImageElement
							? element.currentSrc || element.src
							: element instanceof HTMLScriptElement
								? element.src
								: element instanceof HTMLLinkElement
									? element.href
									: "";
					return (
						assetUrl.startsWith("http://") &&
						!assetUrl.startsWith(location.origin)
					);
				}).length,
		);
	expect(insecureAssetCount, `Insecure asset count on ${relativePath}`).toBe(0);
	runtimeRecorder(page).assertClean(`Page ${relativePath || "/"}`);
}

async function expectNoSeriousAxeViolations(page: Page) {
	await expectPrivacySafeState(page, "Accessibility scan input");
	const result = await new AxeBuilder({ page }).analyze();
	const blocking = result.violations.filter(({ impact }) =>
		["critical", "serious"].includes(impact ?? ""),
	);
	expect(
		blocking.map(({ id, impact, nodes }) => ({
			id,
			impact,
			nodes: nodes.length,
		})),
	).toEqual([]);
	await expectPrivacySafeState(page, "Accessibility scan output");
}

async function screenshot(
	page: Page,
	testInfo: TestInfo,
	name: string,
	fullPage = false,
) {
	await expectPrivacySafeState(page, `Screenshot ${name}`);
	await page.screenshot({
		path: testInfo.outputPath(`${name}.png`),
		fullPage,
		animations: "disabled",
	});
}

function publicPath(value: string) {
	return sitePath(value.replace(/^\/+/, ""));
}

async function expectAudioRange(
	request: APIRequestContext,
	assetPath: string,
	range: string,
	expectedStart: number,
	expectedEnd: number,
	totalBytes: number,
) {
	const response = await request.get(assetPath, {
		headers: { Range: range },
	});
	expect(response.status(), `${range}: HTTP status`).toBe(206);
	expect(response.headers()["content-type"]).toContain("audio/mpeg");
	expect(response.headers()["accept-ranges"]).toBe("bytes");
	expect(response.headers()["content-range"]).toBe(
		`bytes ${expectedStart}-${expectedEnd}/${totalBytes}`,
	);
	expect(Number(response.headers()["content-length"])).toBe(
		expectedEnd - expectedStart + 1,
	);
	expect((await response.body()).byteLength).toBe(
		expectedEnd - expectedStart + 1,
	);
}

test.describe("public release inventory", () => {
	test("home catalog exposes only aggregate-approved writing", async ({
		page,
		request,
	}) => {
		await expectHealthyPage(page, "");
		await expect(page.locator("[data-public-article-count]")).toHaveAttribute(
			"data-public-article-count",
			String(catalogEntries.length),
		);
		const discovered = new Set<string>();
		for (const href of await page
			.locator('[data-post-card-slug] a[href*="/posts/"]')
			.evaluateAll((links) =>
				links.map((link) => (link as HTMLAnchorElement).pathname),
			)) {
			const match = href.match(/\/posts\/([^/]+)\/?$/);
			if (match) discovered.add(decodeURIComponent(match[1]));
		}
		expect([...discovered].toSorted()).toEqual(creativeWritingSlugs);
		expect(
			await page.locator("#start-here [data-featured-card-slug]").count(),
		).toBe(3);
		const recentNonfictionSlugs = await page
			.locator("#nonfiction [data-editorial-slug]")
			.evaluateAll((items) =>
				items
					.map((item) => item.getAttribute("data-editorial-slug"))
					.filter((slug): slug is string => slug !== null),
			);
		if (nonfictionEntries.length === 0) {
			expect(recentNonfictionSlugs).toEqual([]);
			await expect(page.locator('a[href$="/nonfiction/"]')).toHaveCount(0);
		} else {
			expect(recentNonfictionSlugs).toHaveLength(
				Math.min(3, nonfictionEntries.length),
			);
			expect(
				recentNonfictionSlugs.every((slug) => nonfictionSlugs.includes(slug)),
			).toBe(true);
			await expect(
				page.getByRole("link", { name: "Explore all nonfiction" }),
			).toHaveAttribute("href", sitePath("nonfiction/"));
		}
		expect((await request.get(sitePath("2/"))).status()).toBe(404);

		const websiteJsonLd = (
			await page.locator('script[type="application/ld+json"]').allTextContents()
		)
			.map((value) => JSON.parse(value))
			.find((value) => value["@type"] === "WebSite");
		const canonicalSiteUrl =
			"https://shots-of-rhapsody.github.io/Shots-of-Rhapsody/";
		const canonicalSocialImageUrl = new URL(
			"social/site.jpg",
			canonicalSiteUrl,
		).toString();
		const servedSocialImageUrl = absoluteSiteUrl("social/site.jpg");
		expect(websiteJsonLd).toMatchObject({
			"@context": "https://schema.org",
			"@type": "WebSite",
			"@id": `${canonicalSiteUrl}#website`,
			name: "Shots of Rhapsody",
			url: canonicalSiteUrl,
			author: {
				"@type": "Person",
				name: "Tai Song",
				url: new URL("authors/tai-song/", canonicalSiteUrl).toString(),
			},
			image: {
				"@type": "ImageObject",
				url: canonicalSocialImageUrl,
				contentUrl: canonicalSocialImageUrl,
				encodingFormat: "image/jpeg",
				width: 1200,
				height: 630,
			},
		});
		for (const selector of ['meta[property="og:image"]']) {
			await expect(page.locator(selector)).toHaveAttribute(
				"content",
				canonicalSocialImageUrl,
			);
		}
		const socialImage = await request.get(sitePath("social/site.jpg"));
		expect(socialImage.status()).toBe(200);
		expect(socialImage.headers()["content-type"]).toContain("image/jpeg");
		expect((await socialImage.body()).byteLength).toBeGreaterThan(0);
		expect(
			await page.evaluate(
				(src) =>
					new Promise<[number, number]>((resolve, reject) => {
						const image = new Image();
						image.addEventListener("load", () =>
							resolve([image.naturalWidth, image.naturalHeight]),
						);
						image.addEventListener("error", () =>
							reject(new Error("site social image failed to load")),
						);
						image.src = src;
					}),
				servedSocialImageUrl,
			),
		).toEqual([1200, 630]);
	});

	test("archive, author, feeds, and reader pages match the aggregate catalog", async ({
		page,
		request,
	}) => {
		await expectHealthyPage(page, "archive/");
		const archiveSlugs = new Set(
			(
				await page.locator('a[href*="/posts/"]').evaluateAll((links) =>
					links.map((link) => {
						const match = (link as HTMLAnchorElement).pathname.match(
							/\/posts\/([^/]+)\/?$/,
						);
						return match ? decodeURIComponent(match[1]) : "";
					}),
				)
			).filter(Boolean),
		);
		expect([...archiveSlugs].toSorted()).toEqual(expectedWritingSlugs);

		await expectHealthyPage(page, "authors/tai-song/");
		const authorSlugs = await page
			.locator("[data-author-article-slug]")
			.evaluateAll((items) =>
				items.map((item) => item.getAttribute("data-author-article-slug")),
			);
		expect(authorSlugs.filter(Boolean).toSorted()).toEqual(
			expectedWritingSlugs,
		);

		const rss = await request.get(sitePath("rss.xml"));
		if (IS_PUBLIC_REVIEW) {
			expect(rss.status()).toBe(404);
			expect((await request.get(sitePath("sitemap-index.xml"))).status()).toBe(
				404,
			);
		} else {
			expect(rss.status()).toBe(200);
			const rssBody = await rss.text();
			expectNoPrivateReference(rssBody, "RSS response");
			expect(rssBody.match(/<item>/g) ?? []).toHaveLength(
				expectedWritingSlugs.length,
			);
			for (const slug of expectedWritingSlugs) {
				expect(rssBody).toContain(
					`https://shots-of-rhapsody.github.io/Shots-of-Rhapsody/posts/${slug}/`,
				);
			}
		}
		for (const slug of expectedWritingSlugs) {
			const response = await request.get(sitePath(`posts/${slug}/`));
			expect(response.status(), `posts/${slug}/`).toBe(200);
			expectNoPrivateReference(
				await response.text(),
				`posts/${slug}/ response`,
			);
		}

		for (const route of [
			...(!IS_PUBLIC_REVIEW ? ["sitemap-index.xml"] : []),
			"about/",
			"rights/",
		]) {
			const response = await request.get(sitePath(route));
			expect(response.status(), route).toBe(200);
			expectNoPrivateReference(await response.text(), `${route} response`);
		}
	});

	test("reader-facing pages use only Shots of Rhapsody branding", async ({
		page,
		request,
	}) => {
		const readerRoutes = [
			"",
			"archive/",
			"authors/tai-song/",
			"about/",
			"rights/",
			`posts/${articles[0].slug}/`,
			...catalogEntries
				.filter(({ slug }) => !sealedArchiveSlugSet.has(slug))
				.map(({ slug }) => `posts/${slug}/`),
			...(nonfictionEntries.length > 0 ? ["nonfiction/"] : []),
			...(approvedPodcastEpisodes.length > 0
				? [
						"podcast/",
						...approvedPodcastEpisodes.flatMap((episode) => [
							`podcast/${episode.slug}/`,
							...(episode.transcript
								? [`podcast/${episode.slug}/transcript/`]
								: []),
						]),
					]
				: []),
		];
		for (const route of readerRoutes) {
			await expectHealthyPage(page, route);
			await expect(page.locator('meta[name="generator"]')).toHaveCount(0);
			await expect(page.locator('meta[name^="twitter:"]')).toHaveCount(0);
			const publicSurface = await page.evaluate(() => {
				const copy = document.body.cloneNode(true) as HTMLElement;
				for (const selector of [
					"[data-authored-content]",
					"[data-archive-body]",
					"[data-archive-field]",
					"[data-archive-hero]",
					"[data-post-card-slug]",
					"[data-featured-card-slug]",
					"[data-author-article-slug]",
					"[data-archive-entry-slug]",
				]) {
					for (const element of copy.querySelectorAll(selector))
						element.remove();
				}
				return {
					text: copy.innerText,
					hrefs: [...copy.querySelectorAll("a[href]")].map(
						(link) => (link as HTMLAnchorElement).href,
					),
				};
			});
			expect(publicSurface.text).not.toMatch(
				/\b(?:GitHub|Vocal|Medium|Proton|Fuwari|Astro|Twitter|repository|manifest|upstream|deployment|backend|system-level)\b/i,
			);
			expect(publicSurface.text).not.toMatch(forbiddenReaderProcessCopy);
			expect(publicSurface.text).not.toContain("shots-of-rhapsody.github.io");
			expect(publicSurface.hrefs).not.toEqual(
				expect.arrayContaining([
					expect.stringMatching(
						/^https:\/\/(?:github\.com|medium\.com|vocal\.media|(?:docs\.)?proton\.me)\//i,
					),
				]),
			);
		}

		await expectHealthyPage(page, "");
		await expect(page.locator(".nav-links a")).toHaveText(
			expectedPrimaryNavigation,
		);
		await expect(page.locator(".site-footer nav a")).toHaveText(
			IS_PUBLIC_REVIEW ? ["Rights"] : ["Rights", "Subscribe"],
		);

		await expectHealthyPage(page, "about/");
		await expect(page.getByText(authorBio, { exact: true })).toBeVisible();

		await expectHealthyPage(page, "authors/tai-song/");
		await expect(page.getByText(authorBio, { exact: true })).toBeVisible();
		const profile = JSON.parse(
			(await page
				.locator('script[type="application/ld+json"]')
				.textContent()) ?? "",
		);
		expect(profile).toMatchObject({
			"@type": "ProfilePage",
			description: authorBio,
			mainEntity: {
				"@type": "Person",
				name: "Tai Song",
				description: authorBio,
			},
		});

		await expectHealthyPage(page, "rights/");
		await expect(
			page.getByText(
				"© Tai Song and Shots of Rhapsody. All writing, original artwork, audio, and transcripts are All Rights Reserved unless a page states otherwise. Linking is welcome; reproduction or redistribution requires written permission.",
				{ exact: true },
			),
		).toBeVisible();
		expect((await request.get(sitePath("content-license/"))).status()).toBe(
			404,
		);
	});

	test("Nonfiction route exists only for aggregate-approved writing", async ({
		page,
		request,
	}) => {
		if (nonfictionEntries.length === 0) {
			expect((await request.get(sitePath("nonfiction/"))).status()).toBe(404);
			await expectHealthyPage(page, "");
			await expect(
				page.locator('.nav-links a[href$="/nonfiction/"]'),
			).toHaveCount(0);
			return;
		}

		await expectHealthyPage(page, "");
		await expect(
			page.locator("#nonfiction").getByText(nonfictionDescription, {
				exact: true,
			}),
		).toBeVisible();
		await expectHealthyPage(page, "authors/tai-song/");
		await expect(
			page.getByText(nonfictionDescription, { exact: true }),
		).toBeVisible();
		await expectHealthyPage(page, "nonfiction/");
		await expect(
			page.getByText(nonfictionDescription, { exact: true }),
		).toBeVisible();
		await expect(page.locator('meta[name="description"]')).toHaveAttribute(
			"content",
			nonfictionDescription,
		);
		const listedSlugs = await page
			.locator("[data-nonfiction-index] [data-editorial-slug]")
			.evaluateAll((items) =>
				items
					.map((item) => item.getAttribute("data-editorial-slug"))
					.filter((slug): slug is string => slug !== null),
			);
		expect(listedSlugs.toSorted()).toEqual(nonfictionSlugs);
		await expect(page.locator('.nav-links a[href$="/nonfiction/"]')).toHaveText(
			"Nonfiction",
		);
		await expectNoSeriousAxeViolations(page);
	});

	test("Podcast routes and media expose only fully approved episodes", async ({
		page,
		request,
	}, testInfo) => {
		const unpublishedEpisodes = PODCAST_EPISODES.filter(
			(episode) => !approvedPodcastSlugSet.has(episode.slug),
		);
		for (const episode of unpublishedEpisodes) {
			expect(
				(await request.get(sitePath(`podcast/${episode.slug}/`))).status(),
				`${episode.slug}: unpublished episode route`,
			).toBe(404);
			expect(
				(await request.get(publicPath(episode.audio.publicPath))).status(),
				`${episode.slug}: unpublished audio`,
			).toBe(404);
			if (episode.transcript !== null) {
				expect(
					(
						await request.get(publicPath(episode.transcript.publicPath))
					).status(),
					`${episode.slug}: unpublished transcript`,
				).toBe(404);
			}
		}

		expect(
			(await request.get(publicPath(PODCAST_SHOW.feedPath))).status(),
		).toBe(404);
		if (approvedPodcastEpisodes.length === 0) {
			expect((await request.get(sitePath("podcast/"))).status()).toBe(404);
			expect(
				(
					await request.get(publicPath(PODCAST_SHOW.artwork.publicPath))
				).status(),
			).toBe(404);
			await expectHealthyPage(page, "");
			await expect(page.locator('.nav-links a[href$="/podcast/"]')).toHaveCount(
				0,
			);
			return;
		}

		await expectHealthyPage(page, "podcast/");
		const indexSlugs = await page
			.locator('.episode-list a[href*="/podcast/"]')
			.evaluateAll((links) =>
				links
					.map(
						(link) =>
							(link as HTMLAnchorElement).pathname.match(
								/\/podcast\/([^/]+)\/?$/,
							)?.[1],
					)
					.filter((slug): slug is string => slug !== undefined),
			);
		expect(indexSlugs.toSorted()).toEqual(approvedPodcastSlugs);
		await expect(page.locator('.nav-links a[href$="/podcast/"]')).toHaveText(
			"Podcast",
		);
		expect(
			(await request.get(publicPath(PODCAST_SHOW.artwork.publicPath))).status(),
		).toBe(200);

		for (const episode of approvedPodcastEpisodes) {
			const audioPath = publicPath(episode.audio.publicPath);
			const transcriptPath = episode.transcript
				? publicPath(episode.transcript.publicPath)
				: undefined;
			const audioPathname = new URL(audioPath, playwrightOrigin).pathname;
			const prematureAudioRequests: string[] = [];
			const recordAudioRequest = (browserRequest: Request) => {
				if (new URL(browserRequest.url()).pathname === audioPathname) {
					prematureAudioRequests.push(browserRequest.method());
				}
			};
			page.on("request", recordAudioRequest);
			try {
				await expectHealthyPage(page, `podcast/${episode.slug}/`);
				await page.waitForTimeout(250);
				expect(
					prematureAudioRequests,
					`${episode.slug}: audio requested before visitor playback`,
				).toEqual([]);
			} finally {
				page.off("request", recordAudioRequest);
			}

			const player = page.locator("audio[controls]");
			await expect(player).toHaveCount(1);
			await expect(player).toHaveAttribute("preload", "none");
			await expect(player).not.toHaveAttribute("autoplay", /.*/u);
			await expect(player.locator("source")).toHaveAttribute("src", audioPath);
			await expect(player.locator("source")).toHaveAttribute(
				"type",
				episode.audio.mimeType,
			);
			if (transcriptPath) {
				await expect(page.locator(`a[href="${transcriptPath}"]`)).toHaveText([
					"Read transcript",
					"Read transcript",
				]);
			} else {
				await expect(
					page.getByRole("link", { name: "Read transcript" }),
				).toHaveCount(0);
				expect(
					(
						await request.get(sitePath(`podcast/${episode.slug}/transcript/`))
					).status(),
				).toBe(404);
			}
			const download = page.locator(`a[href="${audioPath}"][download]`);
			await expect(download).toBeVisible();
			await expect(download).toContainText("Download audio");
			await expect(download).toContainText(
				`${(episode.audio.byteLength / 1024 ** 2).toFixed(1)} MiB`,
			);
			await expectNoSeriousAxeViolations(page);

			if (testInfo.project.name === "desktop-chromium") {
				if (episode.audio.durationSeconds === null) {
					throw new Error(
						`${episode.slug}: approved audio lacks a measured duration`,
					);
				}
				const playback = await player.evaluate(
					async (element, expectedDuration) => {
						const audio = element as HTMLAudioElement;
						const waitFor = (eventName: string) =>
							new Promise<void>((resolve, reject) => {
								const timeout = window.setTimeout(
									() => reject(new Error(`Timed out waiting for ${eventName}`)),
									15_000,
								);
								audio.addEventListener(
									eventName,
									() => {
										window.clearTimeout(timeout);
										resolve();
									},
									{ once: true },
								);
							});
						if (!Number.isFinite(audio.duration)) {
							const metadata = waitFor("loadedmetadata");
							audio.load();
							await metadata;
						}
						audio.muted = true;
						await audio.play();
						const played = !audio.paused;
						const target = Math.min(
							30,
							Math.max(1, Math.min(expectedDuration, audio.duration) - 1),
						);
						const seeked = waitFor("seeked");
						audio.currentTime = target;
						await seeked;
						const result = {
							played,
							duration: audio.duration,
							target,
							currentTime: audio.currentTime,
						};
						audio.pause();
						return result;
					},
					episode.audio.durationSeconds,
				);
				expect(playback.played).toBe(true);
				expect(playback.duration).toBeCloseTo(episode.audio.durationSeconds, 0);
				expect(playback.currentTime).toBeCloseTo(playback.target, 0);
			}

			if (transcriptPath) {
				await expectHealthyPage(page, `podcast/${episode.slug}/transcript/`);
				await expect(page.locator("[data-podcast-transcript]")).not.toBeEmpty();
				await expectNoSeriousAxeViolations(page);
			}
			if (!hasExternalPlaywrightBaseURL) continue;

			const head = await request.head(audioPath);
			expect(head.status(), `${episode.slug}: audio HEAD`).toBe(200);
			expect(head.headers()["content-type"]).toContain("audio/mpeg");
			expect(head.headers()["accept-ranges"]).toBe("bytes");
			expect(Number(head.headers()["content-length"])).toBe(
				episode.audio.byteLength,
			);

			const rangeBytes = Math.min(1024, episode.audio.byteLength);
			const initialEnd = rangeBytes - 1;
			const middleStart = Math.floor(
				(episode.audio.byteLength - rangeBytes) / 2,
			);
			const middleEnd = middleStart + rangeBytes - 1;
			const suffixStart = episode.audio.byteLength - rangeBytes;
			await expectAudioRange(
				request,
				audioPath,
				`bytes=0-${initialEnd}`,
				0,
				initialEnd,
				episode.audio.byteLength,
			);
			await expectAudioRange(
				request,
				audioPath,
				`bytes=${middleStart}-${middleEnd}`,
				middleStart,
				middleEnd,
				episode.audio.byteLength,
			);
			await expectAudioRange(
				request,
				audioPath,
				`bytes=-${rangeBytes}`,
				suffixStart,
				episode.audio.byteLength - 1,
				episode.audio.byteLength,
			);
		}
	});

	test("deployed podcast audio matches approved bytes and cache validators", async ({
		request,
	}, testInfo) => {
		test.skip(
			!hasExternalPlaywrightBaseURL ||
				testInfo.project.name !== "desktop-chromium" ||
				approvedPodcastEpisodes.length === 0,
			"The full-byte media proof runs once against the deployed site.",
		);
		test.setTimeout(180_000);

		for (const episode of approvedPodcastEpisodes) {
			const audioPath = publicPath(episode.audio.publicPath);
			const response = await request.get(audioPath);
			expect(response.status(), `${episode.slug}: full audio status`).toBe(200);
			expect(response.headers()["content-type"]).toContain("audio/mpeg");
			expect(Number(response.headers()["content-length"])).toBe(
				episode.audio.byteLength,
			);
			const cacheControl = response.headers()["cache-control"] ?? "";
			expect(cacheControl).not.toMatch(/\b(?:no-store|private)\b/iu);
			expect(cacheControl).toMatch(/\b(?:public|max-age=\d+)\b/iu);
			const validator = response.headers().etag
				? { "If-None-Match": response.headers().etag }
				: response.headers()["last-modified"]
					? { "If-Modified-Since": response.headers()["last-modified"] }
					: null;
			expect(validator, `${episode.slug}: cache validator`).not.toBeNull();

			const body = await response.body();
			expect(body.byteLength).toBe(episode.audio.byteLength);
			expect(`sha256:${createHash("sha256").update(body).digest("hex")}`).toBe(
				episode.audio.sha256,
			);
			if (validator) {
				const conditional = await request.get(audioPath, {
					headers: validator,
				});
				expect(
					conditional.status(),
					`${episode.slug}: conditional cache response`,
				).toBe(304);
			}
		}
	});

	for (const { name, route } of [
		{ name: "home", route: "" },
		{ name: "archive", route: "archive/" },
		{ name: "author", route: "authors/tai-song/" },
		{ name: "about", route: "about/" },
		{ name: "rights", route: "rights/" },
		...(nonfictionEntries.length > 0
			? [{ name: "nonfiction", route: "nonfiction/" }]
			: []),
		...(approvedPodcastEpisodes.length > 0
			? [
					{ name: "podcast", route: "podcast/" },
					{
						name: "podcast episode",
						route: `podcast/${approvedPodcastEpisodes[0].slug}/`,
					},
					...(approvedPodcastEpisodes[0].transcript
						? [
								{
									name: "podcast transcript",
									route: `podcast/${approvedPodcastEpisodes[0].slug}/transcript/`,
								},
							]
						: []),
				]
			: []),
	]) {
		test(`${name} page has no serious accessibility violations`, async ({
			page,
		}) => {
			await expectHealthyPage(page, route);
			await expectNoSeriousAxeViolations(page);
		});
	}

	for (const draftSlug of draftSlugs) {
		test(`draft route is absent: ${draftSlug}`, async ({ request }) => {
			const encodedSlug = draftSlug
				.split("/")
				.map((segment) => encodeURIComponent(segment))
				.join("/");
			const response = await request.get(sitePath(`posts/${encodedSlug}/`));
			expect(response.status()).toBe(404);
		});
	}

	for (const responseSlug of excludedResponseSlugs) {
		test(`excluded response route is absent: ${responseSlug}`, async ({
			request,
		}) => {
			const response = await request.get(
				sitePath(`posts/${encodeURIComponent(responseSlug)}/`),
			);
			expect(response.status()).toBe(404);
		});
	}

	test("unknown routes use the branded, non-indexable 404 page", async ({
		page,
		request,
	}) => {
		const missing = await request.get(sitePath("missing-folio/"));
		expect(missing.status()).toBe(404);
		expect(await missing.text()).toContain("data-custom-404");

		await expectHealthyPage(page, "404.html");
		await expect(page.locator("[data-custom-404]")).toHaveCount(1);
		await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
			"content",
			IS_PUBLIC_REVIEW ? "noindex, nofollow, noarchive, nosnippet" : "noindex",
		);
		await expect(page.locator("[data-404-home]")).toHaveAttribute(
			"href",
			sitePath(),
		);
		await expect(page.locator("[data-404-archive]")).toHaveAttribute(
			"href",
			sitePath("archive/"),
		);
		await expectPrivacySafeState(page, "Custom 404 page");
		await expectNoSeriousAxeViolations(page);
	});
});

test("archive dates retain their UTC calendar day in UTC and Pacific time", async ({
	browser,
}) => {
	for (const timeZone of ["UTC", "America/Los_Angeles"]) {
		const context = await browser.newContext({
			baseURL: playwrightBaseURL,
			timezoneId: timeZone,
			viewport: { width: 1280, height: 900 },
		});
		const page = await context.newPage();
		const recorder = runtimeRecorder(page);
		try {
			await expectHealthyPage(page, "archive/");
			for (const article of articles) {
				const entry = page.locator(
					`[data-archive-entry-slug="${article.slug}"]`,
				);
				await expect(entry).toHaveCount(1);
				const published = entry.locator("[data-archive-published]");
				await expect(published).toHaveAttribute("datetime", article.published);
				await expect(published).toHaveText(article.published.slice(5, 10));
			}
			await expect(
				page.getByText("2025", { exact: true }).first(),
			).toBeVisible();
			recorder.assertClean(`Archive publication dates in ${timeZone}`);
		} finally {
			recorder.stop();
			runtimeRecorders.delete(page);
			await context.close();
		}
	}
});

test("responsive manuscript layout and initial images meet the release matrix", async ({
	browser,
}, testInfo) => {
	test.skip(
		testInfo.project.name !== "desktop-chromium",
		"The focused responsive matrix runs once.",
	);

	for (const width of [320, 360, 768, 1024, 1440, 1920]) {
		for (const theme of ["light", "dark"] as const) {
			const context = await browser.newContext({
				baseURL: playwrightBaseURL,
				colorScheme: theme,
				viewport: { width, height: 1000 },
			});
			await context.addInitScript((selectedTheme) => {
				localStorage.setItem("theme", selectedTheme);
			}, theme);
			const page = await context.newPage();
			const recorder = runtimeRecorder(page);
			const imageBodies: Promise<number>[] = [];
			const captureImage = (response: import("@playwright/test").Response) => {
				if (response.request().resourceType() === "image") {
					imageBodies.push(response.body().then((body) => body.byteLength));
				}
			};
			page.on("response", captureImage);

			try {
				await page.goto("./", { waitUntil: "networkidle" });
				page.off("response", captureImage);
				await expectTheme(page, theme);
				expect(
					await page.evaluate(
						() =>
							document.documentElement.scrollWidth -
							document.documentElement.clientWidth,
					),
				).toBeLessThanOrEqual(1);

				const priorityImages = page.locator(
					'img[fetchpriority="high"], img[loading="eager"]',
				);
				await expect(priorityImages).toHaveCount(1);
				const featuredPictures = page.locator(
					'[data-editorial-card="featured"] picture',
				);
				await expect(featuredPictures).toHaveCount(
					3 + Math.min(3, nonfictionEntries.length),
				);
				for (const picture of await featuredPictures.all()) {
					await expect(picture.locator("source")).toHaveAttribute(
						"sizes",
						FEATURED_IMAGE_SIZES,
					);
					await expect(picture.locator("img")).toHaveAttribute(
						"sizes",
						FEATURED_IMAGE_SIZES,
					);
					const cardSrcset = await picture
						.locator("img")
						.getAttribute("srcset");
					expect(cardSrcset).not.toBeNull();
					for (const imageWidth of CARD_IMAGE_WIDTHS) {
						expect(cardSrcset).toContain(`${imageWidth}w`);
					}
				}
				if (width === 320) {
					await expect(page.locator("#works")).toBeVisible();
					await expect(
						page.locator("[data-post-card-slug]").first(),
					).toBeVisible();
					const menuButton = page.getByRole("button", { name: "Menu" });
					await expect(menuButton).toBeVisible();
					await menuButton.click();
					await expect(menuButton).toHaveAttribute("aria-expanded", "true");
					await expect(
						page
							.locator("#nav-menu-panel")
							.getByRole("link", { name: "Works" }),
					).toBeVisible();
					await page.keyboard.press("Escape");
					await expect(menuButton).toHaveAttribute("aria-expanded", "false");
					await page.getByRole("button", { name: "Search" }).click();
					await expect(page.getByRole("dialog")).toBeVisible();
					await expect(page.getByRole("searchbox")).toBeFocused();
					await page.getByRole("button", { name: "Close search" }).click();
					await expect(page.getByRole("dialog")).toBeHidden();
				}

				const initialImageBytes = (await Promise.all(imageBodies)).reduce(
					(total, bytes) => total + bytes,
					0,
				);
				const imageBudget = width <= 767 ? 750 * 1024 : 1.25 * 1024 * 1024;
				expect(
					initialImageBytes,
					`${width}px ${theme} homepage initial image bytes`,
				).toBeLessThanOrEqual(imageBudget);

				const representative = articles[0];
				await page.goto(`posts/${representative.slug}/`, {
					waitUntil: "networkidle",
				});
				await expectTheme(page, theme);
				expect(
					await page.evaluate(
						() =>
							document.documentElement.scrollWidth -
							document.documentElement.clientWidth,
					),
				).toBeLessThanOrEqual(1);
				const heroPicture = page.locator("[data-archive-hero] picture");
				await expect(heroPicture.locator("source")).toHaveAttribute(
					"sizes",
					HERO_IMAGE_SIZES,
				);
				await expect(heroPicture.locator("img")).toHaveCSS(
					"object-fit",
					"contain",
				);
				if (width === 320) {
					await expect(page.locator("[data-archive-body]")).toBeVisible();
					const continuation = page.locator(
						"[data-editorial-continuation-from]",
					);
					await expect(continuation).toBeVisible();
					await expect(
						continuation.locator('a[href*="/posts/"]').first(),
					).toBeVisible();
				}
				recorder.assertClean(`${width}px ${theme} responsive matrix`);
			} finally {
				page.off("response", captureImage);
				recorder.stop();
				runtimeRecorders.delete(page);
				await context.close();
			}
		}
	}
});

test("primary reading surfaces remain usable at 200% root text size", async ({
	browser,
}, testInfo) => {
	test.skip(
		testInfo.project.name !== "desktop-chromium",
		"The focused text-resize check runs once.",
	);

	const context = await browser.newContext({
		baseURL: playwrightBaseURL,
		viewport: { width: 1280, height: 900 },
	});
	await context.addInitScript(() => {
		document.addEventListener(
			"DOMContentLoaded",
			() => {
				document.documentElement.style.fontSize = "200%";
			},
			{ once: true },
		);
	});
	const page = await context.newPage();
	const recorder = runtimeRecorder(page);
	try {
		for (const route of ["", `posts/${articles[0].slug}/`]) {
			await expectHealthyPage(page, route);
			const bodyFontSize = await page.evaluate(() =>
				Number.parseFloat(getComputedStyle(document.body).fontSize),
			);
			expect(
				bodyFontSize,
				`${route || "/"}: resized body font`,
			).toBeGreaterThanOrEqual(32);
			expect(
				await page.evaluate(
					() =>
						document.documentElement.scrollWidth -
						document.documentElement.clientWidth,
				),
				`${route || "/"}: horizontal overflow at 200% text size`,
			).toBeLessThanOrEqual(1);
			await expect(page.locator("main")).toBeVisible();
			await expect(page.locator("h1").first()).toBeVisible();
			if (route === "") {
				await expect(
					page.getByRole("link", { name: "Works", exact: true }).first(),
				).toBeVisible();
				await expect(
					page.locator("[data-post-card-slug]").first(),
				).toBeVisible();
				await page.getByRole("button", { name: "Search" }).click();
				await expect(page.getByRole("dialog")).toBeVisible();
				await expect(page.getByRole("searchbox")).toBeFocused();
				await page.getByRole("button", { name: "Close search" }).click();
			} else {
				await expect(page.locator("[data-archive-body]")).toBeVisible();
				await expect(
					page.locator("[data-editorial-continuation-from]"),
				).toBeVisible();
			}
			recorder.assertClean(`${route || "/"} at 200% root text size`);
		}
	} finally {
		recorder.stop();
		runtimeRecorders.delete(page);
		await context.close();
	}
});

test.describe("article release contract", () => {
	for (const article of articles) {
		test(article.title, async ({ page }, testInfo) => {
			const continuation = continuationBySlug.get(article.slug);
			if (!continuation)
				throw new Error(`${article.slug}: continuation is missing`);
			for (const theme of ["light", "dark"] as const) {
				await setTheme(page, theme);
				await expectHealthyPage(page, `posts/${article.slug}/`);
				await expectTheme(page, theme);
				const expectedDateOnly = article.published.slice(0, 10);
				await expect(page.locator("h1")).toHaveText(article.title);
				await expect(
					page.locator('[data-archive-field="subtitle"]'),
				).toHaveText(article.subtitle);
				await expect(
					page.locator('[data-archive-field="author"]'),
				).toContainText(`By ${article.author}`);
				await expect(
					page.locator("[data-archive-publication-url]"),
				).toHaveCount(0);
				await expect(page.locator("[data-post-published]")).toHaveAttribute(
					"datetime",
					article.published,
				);
				await expect(page.locator("[data-post-published]")).toHaveText(
					expectedDateOnly,
				);
				await expect(page.locator("[data-license-published]")).toHaveAttribute(
					"datetime",
					article.published,
				);
				await expect(page.locator("[data-license-published]")).toHaveText(
					expectedDateOnly,
				);
				const hero = page.locator("[data-archive-hero] img");
				await expect(hero).toHaveAttribute("alt", article.imageAlt ?? "");
				await expect(hero).toHaveCSS("object-fit", "contain");
				const dimensions = await hero.evaluate((image: HTMLImageElement) => ({
					width: image.naturalWidth,
					height: image.naturalHeight,
				}));
				expect(dimensions.width / dimensions.height).toBeCloseTo(
					article.image.width / article.image.height,
					5,
				);
				const caption = page.locator('[data-archive-field="image-caption"]');
				await expect(caption).toHaveText(article.imageCaption);
				const captionId = await caption.getAttribute("id");
				expect(captionId).not.toBeNull();
				await expect(hero).toHaveAttribute("aria-describedby", captionId ?? "");
				await expect(page.locator("[data-archive-body]")).toContainText(
					article.ending,
				);
				await expect(page.locator(".license-container")).toContainText(
					"All Rights Reserved",
				);

				const canonical = await page
					.locator('link[rel="canonical"]')
					.getAttribute("href");
				expect(canonical).toBe(
					`https://shots-of-rhapsody.github.io/Shots-of-Rhapsody/posts/${article.slug}/`,
				);
				const jsonLd = JSON.parse(
					(await page
						.locator('script[type="application/ld+json"]')
						.textContent()) ?? "",
				);
				expect(jsonLd.headline).toBe(article.title);
				expect(jsonLd.alternativeHeadline).toBe(article.subtitle);
				expect(jsonLd.datePublished).toBe(article.published);
				expect(jsonLd.author).toMatchObject({
					name: "Tai Song",
					url: "https://shots-of-rhapsody.github.io/Shots-of-Rhapsody/authors/tai-song/",
				});
				expect(jsonLd).not.toHaveProperty("isBasedOn");
				const continuationSection = page.locator(
					`[data-editorial-continuation-from="${article.slug}"]`,
				);
				await expect(continuationSection).toHaveAttribute(
					"data-editorial-continue-slug",
					continuation,
				);
				await expect(
					continuationSection.locator(
						`[data-continuation-slug="${continuation}"] a`,
					),
				).toHaveAttribute("href", sitePath(`posts/${continuation}/`));
				await expectNoSeriousAxeViolations(page);

				if (testInfo.project.name === "mobile-chromium") {
					const overflow = await page.evaluate(
						() =>
							document.documentElement.scrollWidth -
							document.documentElement.clientWidth,
					);
					expect(overflow).toBeLessThanOrEqual(1);
				}
			}

			if (testInfo.project.name === "desktop-chromium") {
				await setTheme(page, "light");
				await page.goto(`posts/${article.slug}/`, { waitUntil: "networkidle" });
				await page.locator("[data-archive-hero]").scrollIntoViewIfNeeded();
				await screenshot(page, testInfo, `${article.slug}-title-hero-caption`);
				await page.locator(".license-container").scrollIntoViewIfNeeded();
				await screenshot(
					page,
					testInfo,
					`${article.slug}-ending-license-rights`,
				);
			}
		});
	}
});

test.describe("Medium article presentation contract", () => {
	for (const article of mediumArticles) {
		test(article.exportTitle, async ({ page }, testInfo) => {
			for (const theme of ["light", "dark"] as const) {
				await setTheme(page, theme);
				await expectHealthyPage(page, `posts/${article.slug}/`);
				await expectTheme(page, theme);
				const exportTitle = page.locator('[data-article-field="export-title"]');
				await expect(exportTitle).toHaveCount(1);
				await expect(exportTitle).toHaveJSProperty("tagName", "H1");
				await expect(exportTitle).toHaveText(article.exportTitle);
				const summary = page.locator('[data-article-field="summary"]');
				await expect(summary).toHaveCount(1);
				await expect(summary).toHaveJSProperty("tagName", "P");
				await expect(summary).toHaveText(article.summary);
				const title = page.locator('[data-article-field="title"]');
				await expect(title).toHaveCount(1);
				await expect(title).toHaveJSProperty("tagName", "H2");
				await expect(title).toHaveText(article.title);
				const subtitle = page.locator('[data-article-field="subtitle"]');
				await expect(subtitle).toHaveCount(1);
				await expect(subtitle).toHaveJSProperty("tagName", "P");
				await expect(subtitle).toHaveText(article.subtitle);
				const seriesLine = page.locator('[data-article-field="series-line"]');
				await expect(seriesLine).toHaveCount(1);
				await expect(seriesLine).toHaveJSProperty("tagName", "P");
				await expect(seriesLine).toHaveText(article.seriesLine);
				await expect(
					page.locator('[data-article-field="author"]'),
				).toContainText(`By ${article.author}`);
				await expect(
					page.locator(".article-header [data-article-field]"),
				).toHaveCount(3);
				expect(
					await page
						.locator(".article-header [data-article-field]")
						.evaluateAll((nodes) =>
							nodes.map((node) => node.getAttribute("data-article-field")),
						),
				).toEqual(["export-title", "summary", "author"]);
				const authoredLead = page.locator("[data-article-lead]");
				await expect(authoredLead).toHaveCount(1);
				await expect(authoredLead).toHaveJSProperty("tagName", "SECTION");
				expect(
					await authoredLead
						.locator(":scope > [data-article-field]")
						.evaluateAll((nodes) =>
							nodes.map((node) => node.getAttribute("data-article-field")),
						),
				).toEqual(["title", "subtitle"]);

				const shellOrder = await page
					.locator("#post-container > *")
					.evaluateAll((nodes) =>
						nodes
							.map((node) => {
								if (node.tagName === "HEADER") return "header";
								if (node.hasAttribute("data-article-lead")) return "lead";
								if (node.hasAttribute("data-article-hero")) return "hero";
								if (node.hasAttribute("data-authored-content")) return "body";
								return node.getAttribute("data-article-field");
							})
							.filter(Boolean),
					);
				expect(shellOrder.slice(0, 5)).toEqual([
					"header",
					"lead",
					"series-line",
					"hero",
					"body",
				]);
				const presentationOrder = await page
					.locator(
						"[data-article-field], [data-article-hero], [data-authored-content].article-body",
					)
					.evaluateAll((nodes) =>
						nodes
							.map((node) =>
								node.hasAttribute("data-article-hero")
									? "hero"
									: node.matches("[data-authored-content].article-body")
										? "body"
										: node.getAttribute("data-article-field"),
							)
							.filter((field) => field !== "author"),
					);
				expect(presentationOrder).toEqual([
					"export-title",
					"summary",
					"title",
					"subtitle",
					"series-line",
					"hero",
					"body",
				]);

				const heroFigure = page.locator("[data-article-hero]");
				await expect(heroFigure).toHaveCount(1);
				await expect(heroFigure).toHaveJSProperty("tagName", "FIGURE");
				await expect(heroFigure.locator("picture")).toHaveCount(1);
				await expect(heroFigure.locator("source")).toHaveCount(1);
				const hero = heroFigure.locator("img");
				await expect(hero).toHaveCount(1);
				await expect(hero).toHaveAttribute("alt", article.imageAlt ?? "");
				const renderedHeroWidth = Math.min(
					article.hero.width,
					HERO_IMAGE_WIDTHS.at(-1) ?? article.hero.width,
				);
				const renderedHeroHeight = Math.round(
					(article.hero.height * renderedHeroWidth) / article.hero.width,
				);
				await expect(hero).toHaveAttribute("width", String(renderedHeroWidth));
				await expect(hero).toHaveAttribute(
					"height",
					String(renderedHeroHeight),
				);
				await expect(hero).toHaveCSS("object-fit", "contain");
				const sourceWrapper = page.locator(
					'[data-article-hero] [data-image-variant="hero"]',
				);
				await expect(sourceWrapper).toHaveAttribute(
					"data-source-width",
					String(article.hero.width),
				);
				await expect(sourceWrapper).toHaveAttribute(
					"data-source-height",
					String(article.hero.height),
				);
				const caption = heroFigure.locator("figcaption");
				if (article.imageCaption === "") {
					await expect(caption).toHaveCount(0);
					await expect(hero).not.toHaveAttribute("aria-describedby", /.*/u);
				} else {
					await expect(caption).toHaveCount(1);
					await expect(caption).toHaveText(article.imageCaption);
					const captionId = await caption.getAttribute("id");
					expect(captionId).not.toBeNull();
					await expect(hero).toHaveAttribute(
						"aria-describedby",
						captionId ?? "",
					);
				}

				const exactBody = await page
					.locator("[data-authored-content].article-body")
					.evaluate((body, expectedHtml) => {
						const template = document.createElement("template");
						template.innerHTML = expectedHtml;
						const normalized = (node: Node): unknown => {
							if (node.nodeType === Node.TEXT_NODE)
								return ["text", node.nodeValue];
							if (node.nodeType === Node.COMMENT_NODE)
								return ["comment", node.nodeValue];
							const element = node as Element;
							return [
								"element",
								element.tagName.toLowerCase(),
								[...element.attributes]
									.map(({ name, value }) => [name, value])
									.sort(([left], [right]) => left.localeCompare(right)),
								[...node.childNodes].map(normalized),
							];
						};
						const significant = (nodes: NodeListOf<ChildNode> | NodeList) =>
							[...nodes]
								.filter(
									(node) =>
										node.nodeType !== Node.TEXT_NODE ||
										/\S/u.test(node.nodeValue ?? ""),
								)
								.map(normalized);
						return (
							JSON.stringify(significant(body.childNodes)) ===
							JSON.stringify(significant(template.content.childNodes))
						);
					}, article.bodyHtml);
				expect(exactBody).toBe(true);

				const jsonLd = JSON.parse(
					(await page
						.locator('script[type="application/ld+json"]')
						.textContent()) ?? "",
				);
				const expectedSocialImage = `https://shots-of-rhapsody.github.io/Shots-of-Rhapsody/social/${article.slug}.jpg`;
				expect(jsonLd.headline).toBe(article.exportTitle);
				expect(jsonLd.alternativeHeadline).toBe(article.title);
				expect(jsonLd.description).toBe(article.description);
				expect(jsonLd.datePublished).toBe(article.published);
				expect(jsonLd.image).toMatchObject({
					"@type": "ImageObject",
					url: expectedSocialImage,
					contentUrl: expectedSocialImage,
					encodingFormat: "image/jpeg",
					width: 1200,
					height: 1200,
				});
				expect(jsonLd.image.description).toBe(article.imageAlt ?? undefined);
				expect(jsonLd.image.caption).toBe(article.imageCaption || undefined);
				await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
					"content",
					expectedSocialImage,
				);
				await expect(
					page.locator('meta[property="og:image:alt"]'),
				).toHaveAttribute("content", article.imageAlt ?? "");
				await expectNoSeriousAxeViolations(page);
				if (testInfo.project.name === "mobile-chromium") {
					const overflow = await page.evaluate(
						() =>
							document.documentElement.scrollWidth -
							document.documentElement.clientWidth,
					);
					expect(overflow).toBeLessThanOrEqual(1);
				}
			}
		});
	}
});

test("theme, search, navigation history, keyboard focus, and release screenshots", async ({
	page,
}, testInfo) => {
	for (const theme of ["light", "dark"] as const) {
		await setTheme(page, theme);
		await expectHealthyPage(page, "");
		await expectTheme(page, theme);
		await screenshot(page, testInfo, `homepage-${theme}`, true);
	}
	await setTheme(page, "light");
	await expectHealthyPage(page, "");
	await expectTheme(page, "light");
	await page.getByRole("button", { name: "Switch to dark theme" }).click();
	await expectTheme(page, "dark");
	await expect(
		page.getByRole("button", { name: "Switch to light theme" }),
	).toHaveAttribute("aria-pressed", "true");

	if (testInfo.project.name === "mobile-chromium") {
		await page.getByRole("button", { name: "Menu" }).click();
		await expect(page.locator("#nav-menu-panel")).not.toHaveClass(
			/float-panel-closed/,
		);
		await expectNoSeriousAxeViolations(page);
		await page.keyboard.press("Escape");
		await expect(page.locator("#nav-menu-panel")).toHaveClass(
			/float-panel-closed/,
		);
		await expect(page.getByRole("button", { name: "Menu" })).toBeFocused();
	}

	await page.getByRole("button", { name: "Search", exact: true }).click();
	await expect(page.locator("#search-panel")).toBeVisible();
	await expectNoSeriousAxeViolations(page);

	await page
		.locator('input[placeholder="Search"]:visible')
		.fill("Poetic Biography");
	await expect(
		page.getByRole("link", { name: /Poetic Biography/ }).first(),
	).toBeVisible();
	await expectNoSeriousAxeViolations(page);
	await page
		.getByRole("link", { name: /Poetic Biography/ })
		.first()
		.click();
	await page.waitForLoadState("networkidle");
	await expectPrivacySafeState(page, "Search-result navigation");
	await expect(page.locator("h1")).toHaveText("Poetic Biography");
	await page.goBack({ waitUntil: "networkidle" });
	await expectPrivacySafeState(page, "Back navigation");
	await page.goForward({ waitUntil: "networkidle" });
	await expectPrivacySafeState(page, "Forward navigation");
	await expect(page.locator("h1")).toHaveText("Poetic Biography");

	await page.goto("./", { waitUntil: "networkidle" });
	await expectPrivacySafeState(page, "Keyboard navigation home page");
	await page.keyboard.press("Tab");
	await expect(page.locator(".skip-link")).toBeFocused();
	await expect(page.locator(".skip-link")).toBeInViewport();
});
