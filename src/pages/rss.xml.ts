import path from "node:path";
import rss from "@astrojs/rss";
import { getSortedPosts } from "@utils/content-utils";
import { getAbsoluteImageUrl } from "@utils/image-utils";
import {
	getAbsolutePostUrlBySlug,
	getDir,
	getSiteRootUrl,
} from "@utils/url-utils";
import type { APIContext } from "astro";
import MarkdownIt from "markdown-it";
import sanitizeHtml from "sanitize-html";
import { profileConfig, siteConfig } from "@/config";

const parser = new MarkdownIt({ html: true });

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

function stripInvalidXmlChars(str: string): string {
	return str.replace(
		// biome-ignore lint/suspicious/noControlCharactersInRegex: https://www.w3.org/TR/xml/#charsets
		/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\uFDD0-\uFDEF\uFFFE\uFFFF]/g,
		"",
	);
}

export async function GET(context: APIContext) {
	const blog = await getSortedPosts();
	if (!context.site)
		throw new Error("Astro site configuration is required for RSS");
	const site = context.site;
	const siteRoot = getSiteRootUrl(site);
	const items = await Promise.all(
		blog.map(async (post) => {
			const content =
				typeof post.body === "string" ? post.body : String(post.body || "");
			const cleanedContent = stripInvalidXmlChars(content);
			const postUrl = getAbsolutePostUrlBySlug(post.slug, site).toString();
			const basePath = path.join("content/posts/", getDir(post.id));
			const imageUrl = post.data.image
				? await getAbsoluteImageUrl(post.data.image, basePath, site)
				: undefined;
			const imageAlt =
				post.data.imageAlt ?? `Cover image for “${post.data.title}”`;
			const heroFigure = imageUrl
				? `<figure><img src="${escapeXml(imageUrl)}" alt="${escapeXml(imageAlt)}" loading="lazy" decoding="async">${post.data.imageCaption ? `<figcaption>${escapeXml(post.data.imageCaption)}</figcaption>` : ""}</figure>`
				: "";
			const renderedContent = sanitizeHtml(
				`${heroFigure}${parser.render(cleanedContent)}`,
				{
					allowedTags: sanitizeHtml.defaults.allowedTags.concat([
						"img",
						"figure",
						"figcaption",
					]),
					allowedAttributes: {
						...sanitizeHtml.defaults.allowedAttributes,
						img: ["src", "alt", "loading", "decoding"],
					},
				},
			);
			for (const match of renderedContent.matchAll(
				/\b(?:href|src)="([^"]+)"/g,
			)) {
				if (!/^(?:https?:|data:|mailto:|tel:|#)/i.test(match[1])) {
					throw new Error(
						`RSS content for ${post.slug} contains relative URL ${match[1]}`,
					);
				}
			}
			const author = post.data.author || profileConfig.name;
			const customData = [
				`<dc:creator>${escapeXml(author)}</dc:creator>`,
				post.data.updated
					? `<dcterms:modified>${escapeXml(post.data.updated.toISOString())}</dcterms:modified>`
					: "",
				post.data.source?.url
					? `<dc:source>${escapeXml(post.data.source.url)}</dc:source>`
					: "",
				imageUrl
					? `<media:content url="${escapeXml(imageUrl)}" medium="image" />`
					: "",
				imageUrl && post.data.imageCaption
					? `<media:description type="plain">${escapeXml(post.data.imageCaption)}</media:description>`
					: "",
			]
				.filter(Boolean)
				.join("");

			return {
				title: post.data.title,
				pubDate: post.data.published,
				description:
					post.data.summary ||
					post.data.description ||
					post.data.subtitle ||
					post.data.title,
				link: postUrl,
				content: renderedContent,
				categories: [
					...post.data.tags,
					...(post.data.category ? [post.data.category] : []),
				],
				customData,
			};
		}),
	);

	return rss({
		title: siteConfig.title,
		description: siteConfig.subtitle || "No description",
		site: siteRoot,
		items,
		xmlns: {
			dc: "http://purl.org/dc/elements/1.1/",
			dcterms: "http://purl.org/dc/terms/",
			media: "http://search.yahoo.com/mrss/",
		},
		customData: `<language>${siteConfig.lang}</language>`,
	});
}
