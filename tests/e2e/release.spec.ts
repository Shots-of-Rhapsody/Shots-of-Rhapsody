import { readFileSync } from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";
import {
	type ConsoleMessage,
	expect,
	type Page,
	type Request,
	type TestInfo,
	test,
} from "@playwright/test";

interface ArchiveArticle {
	slug: string;
	title: string;
	subtitle: string;
	author: string;
	imageAlt: string | null;
	imageCaption: string;
	publication: { platform: "Vocal"; url: string };
	image: { width: number; height: number };
	published: string;
	ending: string;
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
		publication: snapshot.publication,
		image: entry.image,
		published: snapshot.published,
		ending,
	};
});
const expectedSlugs = articles.map(({ slug }) => slug).toSorted();
const chronologicalArticles = articles.toSorted(
	(left, right) => Date.parse(right.published) - Date.parse(left.published),
);
const navigationBySlug = new Map(
	chronologicalArticles.map((article, index) => [
		article.slug,
		{
			next: index > 0 ? chronologicalArticles[index - 1].slug : null,
			previous:
				index < chronologicalArticles.length - 1
					? chronologicalArticles[index + 1].slug
					: null,
		},
	]),
);
const draftSlugs = [
	"guide",
	"video",
	"modular-ethics/modular-ethics",
	"the-last-cup/the-last-cup",
];
const privateReference =
	/(\.proton-import|protonusercontent\.(?:com|ch)|docs\.proton\.me\/u\/\d+\/)/i;
const previewOrigin = `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? 4387}`;

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
			if (new URL(requestUrl).origin !== previewOrigin) {
				this.record("cross-origin-request");
			}
		} catch {
			this.record("malformed-request-url");
		}
	};
	private readonly onRequestFailed = (request: Request) => {
		this.recordPrivateReference("failed-request", request.url());
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

async function setTheme(page: Page, theme: "light" | "dark") {
	await page.emulateMedia({ colorScheme: theme });
	await page.goto("./", { waitUntil: "networkidle" });
	await page.evaluate((selectedTheme) => {
		localStorage.setItem("theme", selectedTheme);
	}, theme);
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
	await expectPrivacySafeState(page, `Page ${relativePath || "/"}`);
	expect(await page.locator(".vite-error-overlay").count()).toBe(0);

	const imageFailureCount = await page.locator("img").evaluateAll(
		(images) =>
			images.filter((image) => {
				const htmlImage = image as HTMLImageElement;
				return (
					!htmlImage.complete ||
					htmlImage.naturalWidth === 0 ||
					htmlImage.naturalHeight === 0
				);
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

test.describe("public release inventory", () => {
	test("home pagination exposes all and only the 11 manifest articles", async ({
		page,
	}) => {
		const discovered = new Set<string>();
		for (const route of ["", "2/"]) {
			const response = await page.goto(route || "./", {
				waitUntil: "networkidle",
			});
			if (route && response?.status() === 404) continue;
			for (const href of await page
				.locator('a[href*="/posts/"]')
				.evaluateAll((links) =>
					links.map((link) => (link as HTMLAnchorElement).pathname),
				)) {
				const match = href.match(/\/posts\/([^/]+)\/?$/);
				if (match) discovered.add(decodeURIComponent(match[1]));
			}
		}
		expect([...discovered].toSorted()).toEqual(expectedSlugs);
	});

	test("archive, author, RSS, sitemap, and robots expose exactly 11 articles", async ({
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
		expect([...archiveSlugs].toSorted()).toEqual(expectedSlugs);

		await expectHealthyPage(page, "authors/tai-song/");
		const authorSlugs = await page
			.locator("[data-author-article-slug]")
			.evaluateAll((items) =>
				items.map((item) => item.getAttribute("data-author-article-slug")),
			);
		expect(authorSlugs.filter(Boolean).toSorted()).toEqual(expectedSlugs);

		const rss = await request.get(sitePath("rss.xml"));
		expect(rss.status()).toBe(200);
		const rssBody = await rss.text();
		expectNoPrivateReference(rssBody, "RSS response");
		expect(rssBody.match(/<item>/g) ?? []).toHaveLength(11);

		for (const route of [
			"sitemap-index.xml",
			"robots.txt",
			"about/",
			"content-license/",
		]) {
			const response = await request.get(sitePath(route));
			expect(response.status(), route).toBe(200);
			expectNoPrivateReference(await response.text(), `${route} response`);
		}
	});

	for (const { name, route } of [
		{ name: "home", route: "" },
		{ name: "archive", route: "archive/" },
		{ name: "author", route: "authors/tai-song/" },
		{ name: "about", route: "about/" },
		{ name: "rights", route: "content-license/" },
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
});

test.describe("article release contract", () => {
	for (const article of articles) {
		test(article.title, async ({ page }, testInfo) => {
			const navigation = navigationBySlug.get(article.slug);
			if (!navigation)
				throw new Error(`${article.slug}: navigation is missing`);
			for (const theme of ["light", "dark"] as const) {
				await setTheme(page, theme);
				await expectHealthyPage(page, `posts/${article.slug}/`);
				await expectTheme(page, theme);
				await expect(page.locator("h1")).toHaveText(article.title);
				await expect(
					page.locator('[data-archive-field="subtitle"]'),
				).toHaveText(article.subtitle);
				await expect(
					page.locator('[data-archive-field="author"]'),
				).toContainText(`By ${article.author}`);
				await expect(
					page.locator("[data-archive-publication-url]"),
				).toHaveAttribute("href", article.publication.url);
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
				expect(jsonLd.author).toMatchObject({
					name: "Tai Song",
					url: "https://shots-of-rhapsody.github.io/Shots-of-Rhapsody/authors/tai-song/",
				});
				expect(jsonLd.isBasedOn).toBe(article.publication.url);
				for (const direction of ["next", "previous"] as const) {
					const link = page.locator(`[data-post-navigation="${direction}"]`);
					const target = navigation[direction];
					if (target) {
						await expect(link).toHaveAttribute(
							"href",
							sitePath(`posts/${target}/`),
						);
					} else {
						await expect(link).toHaveCount(0);
					}
				}
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
					`${article.slug}-ending-license-source`,
				);
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
	await page.getByRole("button", { name: "Light/Dark Mode" }).click();
	await expectTheme(page, "dark");

	if (testInfo.project.name === "mobile-chromium") {
		await page.getByRole("button", { name: "Menu" }).click();
		await expect(page.locator("#nav-menu-panel")).not.toHaveClass(
			/float-panel-closed/,
		);
		await expectNoSeriousAxeViolations(page);
		await page.getByRole("button", { name: "Menu" }).click();
		await expect(page.locator("#nav-menu-panel")).toHaveClass(
			/float-panel-closed/,
		);
		await page.getByRole("button", { name: "Search Panel" }).click();
		await expect(page.locator("#search-panel")).not.toHaveClass(
			/float-panel-closed/,
		);
		await expectNoSeriousAxeViolations(page);
	}

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
	const focused = await page.evaluate(() => ({
		tag: document.activeElement?.tagName,
		visible: document.activeElement
			? Boolean((document.activeElement as HTMLElement).offsetParent)
			: false,
	}));
	expect(focused.tag).not.toBe("BODY");
	expect(focused.visible).toBe(true);
});
