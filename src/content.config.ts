import { defineCollection, type ImageFunction } from "astro:content";
import { file, glob } from "astro/loaders";
import { z } from "astro/zod";
import firstPartyManifestJson from "../provenance/first-party/manifest.json";
import claimReviewsJson from "../provenance/medium/claim-reviews.json";
import mediumManifestJson from "../provenance/medium/manifest.json";
import publicationCatalog from "../provenance/publication-catalog.json";
import contentSignoffsJson from "../provenance/reviews/content-signoffs-v2.json";
import manifest from "../provenance/tai-song/manifest.json";
import type { ContentSignoffV2 } from "./data/signoffs";
import { generateContentId } from "./utils/content-id";

const EXPECTED_ARCHIVE_POST_COUNT = 11;
const postSourcePrefix = "src/content/posts/";
const mediumManifest = mediumManifestJson as unknown as {
	state: "awaiting-export" | "active";
	articles: Array<{
		slug: string;
		paths: { markdown: string };
		hashes: { rawSource: string; markdown: string };
		assets: Array<{ sha256: string }>;
	}>;
};
const contentSignoffs = contentSignoffsJson as unknown as {
	version: number;
	entries: ContentSignoffV2[];
};
const firstPartyManifest = firstPartyManifestJson as unknown as {
	schemaVersion: number;
	state: "active";
	articles: Array<{
		slug: string;
		markdown: string;
		hashes: { source: string; output: string };
		assets: Array<{ sha256: string }>;
	}>;
};
const claimReviews = claimReviewsJson as unknown as {
	version: number;
	articles: Array<{
		slug: string;
		sourceSha256: string;
		outputSha256: string;
		reviewer: string;
		outcome: string;
	}>;
};
const publicPostPatterns = publicationCatalog.entries.map((article) => {
	const expectedMarkdownPath = `${postSourcePrefix}${article.slug}/index.md`;
	if (article.markdown !== expectedMarkdownPath) {
		throw new Error(
			`Publication catalog path mismatch for ${article.slug}: expected ${expectedMarkdownPath}, received ${article.markdown}`,
		);
	}
	if (
		article.source !== "tai-song" &&
		article.source !== "medium" &&
		article.source !== "first-party"
	) {
		throw new Error(`Unsupported publication source for ${article.slug}`);
	}
	return `${article.slug}/index.md`;
});

if (
	publicationCatalog.schemaVersion !== 1 ||
	publicPostPatterns.length < EXPECTED_ARCHIVE_POST_COUNT ||
	new Set(publicPostPatterns).size !== publicPostPatterns.length
) {
	throw new Error(
		"The public posts collection requires a valid unique publication catalog",
	);
}

if (contentSignoffs.version !== 2) {
	throw new Error("Content approval ledger must use version 2");
}

for (const entry of publicationCatalog.entries.filter(
	(entry) => entry.source === "first-party",
)) {
	const source = firstPartyManifest.articles.find(
		(article) => article.slug === entry.slug,
	);
	const signoff = contentSignoffs.entries.find(
		(review) => review.kind === "writing" && review.slug === entry.slug,
	);
	const sourceAssets = [...(source?.assets ?? [])]
		.map((asset) => asset.sha256)
		.sort();
	const reviewedAssets = [...(signoff?.assetSha256 ?? [])].sort();
	if (
		firstPartyManifest.schemaVersion !== 1 ||
		firstPartyManifest.state !== "active" ||
		!source ||
		source.markdown !== entry.markdown ||
		!signoff ||
		signoff.reviewer !== "Tai Song" ||
		signoff.accuracy !== "passed" ||
		signoff.rights !== "passed" ||
		signoff.sourceSha256 !== source.hashes.source ||
		signoff.outputSha256 !== source.hashes.output ||
		sourceAssets.length !== reviewedAssets.length ||
		sourceAssets.some((digest, index) => digest !== reviewedAssets[index])
	) {
		throw new Error(
			`Publication catalog refuses unsigned or stale first-party writing ${entry.slug}`,
		);
	}
}

for (const entry of publicationCatalog.entries.filter(
	(entry) => entry.source === "medium",
)) {
	const source = mediumManifest.articles.find(
		(article) => article.slug === entry.slug,
	);
	const signoff = contentSignoffs.entries.find(
		(review) => review.kind === "writing" && review.slug === entry.slug,
	);
	const claimReview = claimReviews.articles.find(
		(review) => review.slug === entry.slug,
	);
	const sourceAssets = [...(source?.assets ?? [])]
		.map((asset) => asset.sha256)
		.sort();
	const reviewedAssets = [...(signoff?.assetSha256 ?? [])].sort();
	if (
		mediumManifest.state !== "active" ||
		!source ||
		source.paths.markdown !== entry.markdown ||
		!signoff ||
		claimReviews.version !== 1 ||
		claimReview?.reviewer !== "Tai Song" ||
		claimReview?.outcome !== "passed" ||
		claimReview?.sourceSha256 !== source.hashes.rawSource ||
		claimReview?.outputSha256 !== source.hashes.markdown ||
		signoff.reviewer !== "Tai Song" ||
		signoff.accuracy !== "passed" ||
		signoff.rights !== "passed" ||
		signoff.sourceSha256 !== source.hashes.rawSource ||
		signoff.outputSha256 !== source.hashes.markdown ||
		sourceAssets.length !== reviewedAssets.length ||
		sourceAssets.some((digest, index) => digest !== reviewedAssets[index])
	) {
		throw new Error(
			`Publication catalog refuses unsigned or stale Medium article ${entry.slug}`,
		);
	}
}

const archiveCatalogEntries = publicationCatalog.entries.filter(
	(entry) => entry.source === "tai-song",
);
const archiveManifestSlugs = new Set(
	manifest.articles.map((article) => article.slug),
);
if (
	archiveCatalogEntries.length !== EXPECTED_ARCHIVE_POST_COUNT ||
	archiveCatalogEntries.some(
		(entry) =>
			!archiveManifestSlugs.has(entry.slug) ||
			manifest.articles.find((article) => article.slug === entry.slug)?.paths
				.markdown !== entry.markdown,
	)
) {
	throw new Error(
		"The publication catalog must retain every sealed Tai Song archive path",
	);
}

const httpsUrl = z.url().refine(
	(value) => {
		try {
			return new URL(value).protocol === "https:";
		} catch {
			return false;
		}
	},
	{ message: "URL must use HTTPS" },
);

const createPostSchema = (image: ImageFunction) =>
	z
		.object({
			title: z.string(),
			subtitle: z.string().optional().default(""),
			exportTitle: z.string().optional().default(""),
			exportSummary: z.string().nullable().optional().default(null),
			seriesLine: z.string().optional().default(""),
			summary: z.string().optional().default(""),
			author: z.string().optional().default(""),
			published: z.coerce.date(),
			updated: z.coerce.date().optional(),
			draft: z.boolean().optional().default(false),
			description: z.string().optional().default(""),
			image: image(),
			tags: z.array(z.string().min(1)).optional().default([]),
			category: z.string().optional().nullable().default(""),
			section: z
				.enum(["fiction", "poetry-reflection", "nonfiction"])
				.optional(),
			lang: z.string().optional().default(""),
			imageAlt: z.string().nullable().optional().default(null),
			imageCaption: z.string().optional().default(""),
			imageSourceUrl: z
				.union([z.literal(""), z.url()])
				.optional()
				.default(""),
			provenance: z
				.discriminatedUnion("authority", [
					z
						.object({
							authority: z.literal("Proton Docs"),
							captureFormat: z.literal("html-export"),
							capturedAt: z.iso.datetime({ offset: true }),
							wordCount: z.number().int().nonnegative().optional(),
							bodyTextSha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
							bodyBlockCount: z.number().int().positive(),
						})
						.strict(),
					z
						.object({
							authority: z.literal("Medium account export"),
							captureFormat: z.literal("account-export-html"),
							capturedAt: z.iso.datetime({ offset: true }),
							wordCount: z.number().int().nonnegative().optional(),
							bodyTextSha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
							bodyBlockCount: z.number().int().positive(),
						})
						.strict(),
				])
				.optional(),
			publication: z
				.object({
					platform: z.literal("Vocal"),
					url: httpsUrl,
				})
				.strict()
				.optional(),
			license: z
				.object({
					name: z.string(),
					url: z.url().optional(),
				})
				.optional(),
		})
		.superRefine((post, context) => {
			if (post.draft) {
				context.addIssue({
					code: "custom",
					message: "Publication-catalog posts must not be drafts",
					path: ["draft"],
				});
			}
			if (!post.provenance) return;

			const requireValue = (
				field:
					| "title"
					| "subtitle"
					| "seriesLine"
					| "summary"
					| "description"
					| "author"
					| "imageCaption",
			) => {
				if (post[field].length === 0) {
					context.addIssue({
						code: "custom",
						message: `Author-master archive posts require an explicit nonempty ${field}`,
						path: [field],
					});
				}
			};
			const requiredFields =
				post.provenance.authority === "Proton Docs"
					? ([
							"title",
							"subtitle",
							"summary",
							"description",
							"author",
							"imageCaption",
						] as const)
					: ([
							"title",
							"subtitle",
							"seriesLine",
							"summary",
							"description",
							"author",
						] as const);
			for (const field of requiredFields) {
				requireValue(field);
			}
			if (
				post.provenance.authority === "Medium account export" &&
				!post.seriesLine.startsWith("A Ledger Series article ")
			) {
				context.addIssue({
					code: "custom",
					message:
						"Medium archive posts must preserve their reviewed Ledger Series sentence",
					path: ["seriesLine"],
				});
			}
			if (post.provenance.authority === "Medium account export") {
				if (post.exportTitle.length === 0) {
					context.addIssue({
						code: "custom",
						message:
							"Medium account-export posts must preserve the exported story title",
						path: ["exportTitle"],
					});
				}
				if (
					post.exportSummary !== null &&
					post.summary !== post.exportSummary
				) {
					context.addIssue({
						code: "custom",
						message:
							"Medium public summaries must preserve the exported story summary when present",
						path: ["summary"],
					});
				}
			} else if (post.exportTitle || post.exportSummary !== null) {
				context.addIssue({
					code: "custom",
					message:
						"Only Medium account-export posts may carry exported presentation fields",
					path: [post.exportTitle ? "exportTitle" : "exportSummary"],
				});
			}

			if (post.author !== "Tai Song") {
				context.addIssue({
					code: "custom",
					message:
						"Author-master archive posts must identify Tai Song as author",
					path: ["author"],
				});
			}
			if (typeof post.category !== "string" || post.category.length === 0) {
				context.addIssue({
					code: "custom",
					message:
						"Author-master archive posts require an explicit nonempty category",
					path: ["category"],
				});
			}
			if (
				post.provenance.authority === "Proton Docs" &&
				post.description !== post.subtitle
			) {
				context.addIssue({
					code: "custom",
					message:
						"Author-master archive post descriptions must exactly match their subtitles",
					path: ["description"],
				});
			}
			if (new Set(post.tags).size !== post.tags.length) {
				context.addIssue({
					code: "custom",
					message: "Author-master archive post tags must be unique",
					path: ["tags"],
				});
			}
			if (post.imageSourceUrl) {
				context.addIssue({
					code: "custom",
					message:
						"Author-master archive posts must not expose a private image source URL",
					path: ["imageSourceUrl"],
				});
			}
			if (post.license?.name !== "All Rights Reserved") {
				context.addIssue({
					code: "custom",
					message:
						"Author-master archive posts must declare All Rights Reserved",
					path: ["license", "name"],
				});
			}
			if (post.updated !== undefined) {
				context.addIssue({
					code: "custom",
					message:
						"Author-master archive posts must omit updated when no authoritative update was captured",
					path: ["updated"],
				});
			}
			if (
				post.provenance.authority === "Medium account export" &&
				post.section !== "nonfiction"
			) {
				context.addIssue({
					code: "custom",
					message: "Medium account-export posts must be nonfiction",
					path: ["section"],
				});
			}
		});

const postsCollection = defineCollection({
	loader: glob({
		base: "./src/content/posts",
		pattern: publicPostPatterns,
		generateId: ({ entry, data }) => generateContentId(entry, data),
	}),
	schema: ({ image }) => createPostSchema(image),
});
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const podcastArtworkSchema = z
	.object({
		sourcePath: z.string().min(1),
		sourceSha256: sha256,
		archivePath: z.string().min(1),
		publicPath: z.string().regex(/^\/media\/podcast\/[A-Za-z0-9._~/-]+$/),
		sha256,
		mimeType: z.literal("image/png"),
		width: z.literal(3000),
		height: z.literal(3000),
		approved: z.boolean(),
	})
	.strict();
const podcastCollection = defineCollection({
	loader: file("./src/content/podcast/manifest.json", {
		parser: (text) => {
			const parsed = JSON.parse(text) as { episodes?: unknown };
			if (!Array.isArray(parsed.episodes)) {
				throw new Error(
					"Podcast content manifest must contain an episode array",
				);
			}
			return parsed.episodes as Array<Record<string, unknown>>;
		},
	}),
	schema: z
		.object({
			id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
			slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
			status: z.enum(["draft", "published"]),
			title: z.string().min(1),
			description: z.string().min(1).nullable(),
			author: z.literal("Tai Song").nullable(),
			publishedAt: z.iso.datetime({ offset: true }).nullable(),
			explicit: z.boolean().nullable(),
			episodeType: z.enum(["full", "trailer", "bonus"]),
			episodeNumber: z.number().int().positive().nullable(),
			guid: z.string().min(1).nullable(),
			rightsCleared: z.boolean(),
			audio: z
				.object({
					publicPath: z
						.string()
						.regex(/^\/media\/podcast\/[A-Za-z0-9._~/-]+\.mp3$/),
					mimeType: z.literal("audio/mpeg"),
					byteLength: z.number().int().positive(),
					sha256,
					duration: z.string().regex(/^\d{2}:\d{2}:\d{2}\.\d{3}$/),
					durationSeconds: z.number().positive().nullable(),
					codec: z.string().min(1),
					sampleRateHz: z.number().int().positive().nullable(),
					channels: z.number().int().positive().nullable(),
					channelMode: z.string().min(1),
					bitrateBps: z.number().int().positive().nullable(),
					loudnessLkfs: z.number().nullable(),
					truePeakDbfs: z.number().nullable(),
					distributionDecision: z.enum([
						"pending",
						"retain-current-audio",
						"replace-from-matching-lossless-master",
					]),
					qualityApproved: z.boolean(),
				})
				.strict(),
			artwork: podcastArtworkSchema,
			transcript: z
				.object({
					sourcePath: z.string().min(1),
					publicPath: z.string().regex(/^\/podcast\/[A-Za-z0-9._~/-]+\/$/),
					vttPath: z
						.string()
						.regex(/^\/media\/podcast\/[A-Za-z0-9._~/-]+\.vtt$/)
						.nullable(),
					language: z.literal("en"),
					sha256,
					reviewed: z.boolean(),
				})
				.strict()
				.nullable(),
		})
		.strict()
		.refine((episode) => episode.id === episode.slug, {
			message: "Podcast collection entry id must match its slug",
		}),
});
const specCollection = defineCollection({
	loader: glob({
		base: "./src/content/spec",
		pattern: "**/*.{md,mdx}",
		generateId: ({ entry, data }) => generateContentId(entry, data),
	}),
	schema: z.object({}),
});
export const collections = {
	podcast: podcastCollection,
	posts: postsCollection,
	spec: specCollection,
};
