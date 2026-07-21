import { defineCollection, z } from "astro:content";

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
		tags: z.array(z.string()).optional().default([]),
		category: z.string().optional().nullable().default(""),
		lang: z.string().optional().default(""),
		imageAlt: z.string().nullable().optional().default(null),
		imageCaption: z.string().optional().default(""),
		imageSourceUrl: z.string().url().optional(),
		source: z
			.object({
				platform: z.literal("Vocal"),
				id: z.string().min(1),
				url: z.string().url(),
				capturedAt: z.string().datetime({ offset: true }),
				publishedAt: z.string().datetime({ offset: true }),
				contentUpdatedAt: z.string().datetime({ offset: true }).nullable(),
				wordCount: z.number().int().nonnegative(),
				communitySlug: z.string().min(1),
			})
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
		if (!post.source) return;

		const requireValue = (field: "subtitle" | "summary" | "author") => {
			if (post[field].length === 0) {
				context.addIssue({
					code: "custom",
					message: `Vocal posts require a nonempty ${field}`,
					path: [field],
				});
			}
		};
		for (const field of ["subtitle", "summary", "author"] as const) {
			requireValue(field);
		}

		if (post.author !== "Tai Song") {
			context.addIssue({
				code: "custom",
				message: "Vocal archive posts must identify Tai Song as author",
				path: ["author"],
			});
		}
		if (post.description !== post.subtitle) {
			context.addIssue({
				code: "custom",
				message: "Vocal post description must exactly match its subtitle",
				path: ["description"],
			});
		}
		if (
			post.published.valueOf() !== new Date(post.source.publishedAt).valueOf()
		) {
			context.addIssue({
				code: "custom",
				message: "Vocal publication timestamps must match",
				path: ["published"],
			});
		}

		const sourceUpdated = post.source.contentUpdatedAt;
		const shouldExposeUpdated =
			sourceUpdated !== null &&
			new Date(sourceUpdated).valueOf() > post.published.valueOf();
		if (
			(shouldExposeUpdated &&
				post.updated?.valueOf() !== new Date(sourceUpdated).valueOf()) ||
			(!shouldExposeUpdated && post.updated !== undefined)
		) {
			context.addIssue({
				code: "custom",
				message:
					"Vocal updated must match a source update later than publication and otherwise be omitted",
				path: ["updated"],
			});
		}
		if (post.image !== "./hero-original.png") {
			context.addIssue({
				code: "custom",
				message: "Vocal posts must use the colocated original hero PNG",
				path: ["image"],
			});
		}
		if (!post.imageSourceUrl) {
			context.addIssue({
				code: "custom",
				message: "Vocal posts require the original hero source URL",
				path: ["imageSourceUrl"],
			});
		}
		if (post.license?.name !== "All Rights Reserved") {
			context.addIssue({
				code: "custom",
				message: "Imported Vocal posts must declare All Rights Reserved",
				path: ["license", "name"],
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
