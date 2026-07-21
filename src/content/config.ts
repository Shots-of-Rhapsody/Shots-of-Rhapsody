import { defineCollection, z } from "astro:content";

const httpsUrl = z
	.string()
	.url()
	.refine(
		(value) => {
			try {
				return new URL(value).protocol === "https:";
			} catch {
				return false;
			}
		},
		{ message: "URL must use HTTPS" },
	);

const postSchema = z
	.object({
		title: z.string(),
		subtitle: z.string().optional().default(""),
		summary: z.string().optional().default(""),
		author: z.string().optional().default(""),
		published: z.coerce.date(),
		updated: z.coerce.date().optional(),
		draft: z.boolean().optional().default(false),
		description: z.string().optional().default(""),
		image: z.string().optional().default(""),
		tags: z.array(z.string().min(1)).optional().default([]),
		category: z.string().optional().nullable().default(""),
		lang: z.string().optional().default(""),
		imageAlt: z.string().nullable().optional().default(null),
		imageCaption: z.string().optional().default(""),
		imageSourceUrl: z
			.union([z.literal(""), z.string().url()])
			.optional()
			.default(""),
		provenance: z
			.object({
				authority: z.literal("Proton Docs"),
				captureFormat: z.literal("html-export"),
				capturedAt: z.string().datetime({ offset: true }),
				wordCount: z.number().int().nonnegative().optional(),
				bodyTextSha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
				bodyBlockCount: z.number().int().positive(),
			})
			.strict()
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
				url: z.string().url().optional(),
			})
			.optional(),

		/* For internal use */
		prevTitle: z.string().default(""),
		prevSlug: z.string().default(""),
		nextTitle: z.string().default(""),
		nextSlug: z.string().default(""),
	})
	.superRefine((post, context) => {
		if (!post.provenance) return;

		const requireValue = (
			field:
				| "title"
				| "subtitle"
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
		for (const field of [
			"title",
			"subtitle",
			"summary",
			"description",
			"author",
			"imageCaption",
		] as const) {
			requireValue(field);
		}

		if (post.author !== "Tai Song") {
			context.addIssue({
				code: "custom",
				message: "Author-master archive posts must identify Tai Song as author",
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
		if (post.description !== post.subtitle) {
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
		if (post.image !== "./hero-original.png") {
			context.addIssue({
				code: "custom",
				message:
					"Author-master archive posts must use the colocated original hero PNG",
				path: ["image"],
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
				message: "Author-master archive posts must declare All Rights Reserved",
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
	});

const postsCollection = defineCollection({
	schema: postSchema,
});
const specCollection = defineCollection({
	schema: z.object({}),
});
export const collections = {
	posts: postsCollection,
	spec: specCollection,
};
