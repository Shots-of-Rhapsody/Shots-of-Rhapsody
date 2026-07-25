import type { CollectionEntry } from "astro:content";
import publicationCatalog from "../../provenance/publication-catalog.json";
import manifest from "../../provenance/tai-song/manifest.json";

export const MANIFEST_SLUGS = [
	"before-the-sky-went-quiet-part-i-the-girl-who-faded",
	"before-the-sky-went-quiet-part-ii-the-goodbye",
	"before-the-sky-went-quiet-part-iii-the-echo-that-stayed",
	"cold-children",
	"eggasaurus-rex",
	"lanterns-for-the-unreturning",
	"poetic-biography",
	"the-guild-a-chronicle-of-pretty-souls",
	"the-khan-who-chose-the-grain",
	"the-seventh-skin",
	"where-we-last-were-us",
] as const;

export type ManifestSlug = (typeof MANIFEST_SLUGS)[number];
export type WritingSection = "fiction" | "poetry-reflection" | "nonfiction";

export interface EditorialMetadata {
	section: WritingSection;
	featuredOrder?: 1 | 2 | 3;
	series?: {
		id: "before-the-sky-went-quiet";
		name: "Before the Sky Went Quiet";
		position: 1 | 2 | 3;
		total: 3;
	};
	continueSlug: ManifestSlug;
}

export interface EditorialGroup {
	id: "sky-trilogy" | "stories" | "poetry-and-reflection";
	title: string;
	description: string;
	slugs: readonly ManifestSlug[];
}

const SKY_PART_I =
	"before-the-sky-went-quiet-part-i-the-girl-who-faded" as const;
const SKY_PART_II = "before-the-sky-went-quiet-part-ii-the-goodbye" as const;
const SKY_PART_III =
	"before-the-sky-went-quiet-part-iii-the-echo-that-stayed" as const;

export const EDITORIAL_METADATA = {
	[SKY_PART_I]: {
		section: "fiction",
		featuredOrder: 1,
		series: {
			id: "before-the-sky-went-quiet",
			name: "Before the Sky Went Quiet",
			position: 1,
			total: 3,
		},
		continueSlug: SKY_PART_II,
	},
	[SKY_PART_II]: {
		section: "fiction",
		series: {
			id: "before-the-sky-went-quiet",
			name: "Before the Sky Went Quiet",
			position: 2,
			total: 3,
		},
		continueSlug: SKY_PART_III,
	},
	[SKY_PART_III]: {
		section: "fiction",
		series: {
			id: "before-the-sky-went-quiet",
			name: "Before the Sky Went Quiet",
			position: 3,
			total: 3,
		},
		continueSlug: "the-seventh-skin",
	},
	"cold-children": {
		section: "fiction",
		continueSlug: "lanterns-for-the-unreturning",
	},
	"eggasaurus-rex": {
		section: "fiction",
		continueSlug: SKY_PART_I,
	},
	"lanterns-for-the-unreturning": {
		section: "fiction",
		continueSlug: "the-khan-who-chose-the-grain",
	},
	"poetic-biography": {
		section: "poetry-reflection",
		continueSlug: "the-guild-a-chronicle-of-pretty-souls",
	},
	"the-guild-a-chronicle-of-pretty-souls": {
		section: "poetry-reflection",
		continueSlug: "where-we-last-were-us",
	},
	"the-khan-who-chose-the-grain": {
		section: "fiction",
		continueSlug: "eggasaurus-rex",
	},
	"the-seventh-skin": {
		section: "fiction",
		featuredOrder: 2,
		continueSlug: "cold-children",
	},
	"where-we-last-were-us": {
		section: "poetry-reflection",
		featuredOrder: 3,
		continueSlug: "poetic-biography",
	},
} as const satisfies Record<ManifestSlug, EditorialMetadata>;

export const EDITORIAL_GROUPS = [
	{
		id: "sky-trilogy",
		title: "Before the Sky Went Quiet",
		description:
			"Read the three-part story in order, from the first fading voice to the echo that remains.",
		slugs: [SKY_PART_I, SKY_PART_II, SKY_PART_III],
	},
	{
		id: "stories",
		title: "Stories",
		description:
			"Speculative futures, remembered lives, quiet legends, and one joyful Wobblebottom adventure.",
		slugs: [
			"the-seventh-skin",
			"cold-children",
			"lanterns-for-the-unreturning",
			"the-khan-who-chose-the-grain",
			"eggasaurus-rex",
		],
	},
	{
		id: "poetry-and-reflection",
		title: "Poetry & reflection",
		description:
			"Poetic memory, digital kinship, and the places where love leaves an echo.",
		slugs: [
			"poetic-biography",
			"the-guild-a-chronicle-of-pretty-souls",
			"where-we-last-were-us",
		],
	},
] as const satisfies readonly EditorialGroup[];

const manifestSlugSet = new Set<ManifestSlug>(MANIFEST_SLUGS);
const publicationSections = new Map(
	publicationCatalog.entries.map((entry) => [
		entry.slug,
		entry.section as WritingSection,
	]),
);

export function isManifestSlug(value: string): value is ManifestSlug {
	return manifestSlugSet.has(value as ManifestSlug);
}

export function getWritingSection(slug: string): WritingSection | undefined {
	return publicationSections.get(slug);
}

export function getWritingTypeLabel(
	slug: string,
	category = "",
): "Fiction" | "Poetry" | "Reflection" | "Nonfiction" | "Work" {
	const section = getWritingSection(slug);
	if (section === "fiction") return "Fiction";
	if (section === "nonfiction") return "Nonfiction";
	if (section === "poetry-reflection")
		return category.toLowerCase().includes("poet") ? "Poetry" : "Reflection";
	return "Work";
}

export function indexEditorialEntries(
	entries: readonly CollectionEntry<"posts">[],
): Map<ManifestSlug, CollectionEntry<"posts">> {
	const indexed = new Map<ManifestSlug, CollectionEntry<"posts">>();

	for (const entry of entries) {
		if (!isManifestSlug(entry.id)) continue;
		if (indexed.has(entry.id)) {
			throw new Error(`Duplicate editorial article slug: ${entry.id}`);
		}
		indexed.set(entry.id, entry);
	}

	const missing = MANIFEST_SLUGS.filter((slug) => !indexed.has(slug));
	if (missing.length > 0 || indexed.size !== MANIFEST_SLUGS.length) {
		throw new Error(
			`Editorial archive must contain exactly ${MANIFEST_SLUGS.length} articles; missing: ${missing.join(", ") || "none"}`,
		);
	}

	return indexed;
}

export function entriesForSlugs(
	indexed: ReadonlyMap<ManifestSlug, CollectionEntry<"posts">>,
	slugs: readonly ManifestSlug[],
): CollectionEntry<"posts">[] {
	return slugs.map((slug) => {
		const entry = indexed.get(slug);
		if (!entry) throw new Error(`Editorial article is missing: ${slug}`);
		return entry;
	});
}

export function getFeaturedEntries(
	indexed: ReadonlyMap<ManifestSlug, CollectionEntry<"posts">>,
): CollectionEntry<"posts">[] {
	return MANIFEST_SLUGS.filter(
		(slug) =>
			(EDITORIAL_METADATA[slug] as EditorialMetadata).featuredOrder !==
			undefined,
	)
		.sort(
			(left, right) =>
				((EDITORIAL_METADATA[left] as EditorialMetadata).featuredOrder ?? 0) -
				((EDITORIAL_METADATA[right] as EditorialMetadata).featuredOrder ?? 0),
		)
		.map((slug) => {
			const entry = indexed.get(slug);
			if (!entry) throw new Error(`Featured article is missing: ${slug}`);
			return entry;
		});
}

const manifestSlugs = manifest.articles.map((article) => article.slug);
const unexpectedManifestSlugs = manifestSlugs.filter(
	(slug) => !isManifestSlug(slug),
);
const missingManifestSlugs = MANIFEST_SLUGS.filter(
	(slug) => !manifestSlugs.includes(slug),
);

if (
	manifestSlugs.length !== MANIFEST_SLUGS.length ||
	new Set(manifestSlugs).size !== MANIFEST_SLUGS.length ||
	unexpectedManifestSlugs.length > 0 ||
	missingManifestSlugs.length > 0
) {
	throw new Error(
		"Editorial metadata and the Tai Song provenance manifest do not describe the same eleven articles",
	);
}

for (const slug of MANIFEST_SLUGS) {
	if (publicationSections.get(slug) !== EDITORIAL_METADATA[slug].section) {
		throw new Error(
			`Publication catalog and editorial metadata disagree for ${slug}`,
		);
	}
}
