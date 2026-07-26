import mediumManifestJson from "../../provenance/medium/manifest.json" with {
	type: "json",
};
import publicationCatalogJson from "../../provenance/publication-catalog.json" with {
	type: "json",
};
import releaseTargetJson from "../../provenance/release-target.json" with {
	type: "json",
};
import { IS_PUBLIC_REVIEW, type ShotsBuildMode } from "./build-mode.ts";

export type WritingSection = "fiction" | "poetry-reflection" | "nonfiction";
export type PublicationSource = "tai-song" | "medium" | "first-party";

export interface PublicationCatalogEntry {
	readonly slug: string;
	readonly source: PublicationSource;
	readonly markdown: string;
	readonly section: WritingSection;
}

export interface PublicationCatalogV1 {
	readonly schemaVersion: 1;
	readonly entries: readonly PublicationCatalogEntry[];
}

interface MediumManifest {
	readonly state: string;
	readonly articles: readonly {
		readonly slug: string;
		readonly paths: { readonly markdown: string };
	}[];
}

interface ReleaseTarget {
	readonly expected: {
		readonly archiveWriting: number;
		readonly mediumWriting: number;
	};
}

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

function assertCatalogEntry(
	entry: PublicationCatalogEntry,
	label: string,
): void {
	if (
		!SLUG_PATTERN.test(entry.slug) ||
		entry.markdown !== `src/content/posts/${entry.slug}/index.md` ||
		!(["tai-song", "medium", "first-party"] as const).includes(entry.source) ||
		!(["fiction", "poetry-reflection", "nonfiction"] as const).includes(
			entry.section,
		) ||
		(entry.source === "medium" && entry.section !== "nonfiction")
	) {
		throw new Error(`${label} contains an invalid publication entry`);
	}
}

export function createEffectivePublicationCatalog({
	mode,
	publicationCatalog,
	mediumManifest,
	releaseTarget,
}: {
	readonly mode: ShotsBuildMode;
	readonly publicationCatalog: PublicationCatalogV1;
	readonly mediumManifest: MediumManifest;
	readonly releaseTarget: ReleaseTarget;
}): PublicationCatalogV1 {
	if (
		publicationCatalog.schemaVersion !== 1 ||
		publicationCatalog.entries.length < releaseTarget.expected.archiveWriting
	) {
		throw new Error(
			"The release publication catalog must contain the sealed archive",
		);
	}
	for (const entry of publicationCatalog.entries) {
		assertCatalogEntry(entry, "Release publication catalog");
	}
	const archiveEntries = publicationCatalog.entries.filter(
		(entry) => entry.source === "tai-song",
	);
	if (archiveEntries.length !== releaseTarget.expected.archiveWriting) {
		throw new Error(
			"The release publication catalog must contain the sealed archive",
		);
	}

	if (mode === "release") return publicationCatalog;
	if (
		publicationCatalog.entries.some((entry) => entry.source === "first-party")
	) {
		throw new Error(
			"Public review permits only the sealed archive and Medium essays",
		);
	}
	if (mediumManifest.state !== "active") {
		throw new Error("Public review requires the active Medium manifest");
	}
	if (mediumManifest.articles.length !== releaseTarget.expected.mediumWriting) {
		throw new Error("Public review requires exactly 24 Medium essays");
	}

	const mediumEntries: PublicationCatalogEntry[] = mediumManifest.articles.map(
		(article) => ({
			slug: article.slug,
			source: "medium",
			markdown: article.paths.markdown,
			section: "nonfiction",
		}),
	);
	for (const entry of mediumEntries) {
		assertCatalogEntry(entry, "Public-review Medium catalog");
	}

	const entries = [...archiveEntries, ...mediumEntries];
	if (new Set(entries.map((entry) => entry.slug)).size !== entries.length) {
		throw new Error("Public-review publication catalog repeats a slug");
	}
	if (
		entries.length !==
		releaseTarget.expected.archiveWriting + releaseTarget.expected.mediumWriting
	) {
		throw new Error("Public-review publication catalog has an invalid count");
	}
	return { schemaVersion: 1, entries };
}

export const PUBLICATION_CATALOG = createEffectivePublicationCatalog({
	mode: IS_PUBLIC_REVIEW ? "public-review" : "release",
	publicationCatalog: publicationCatalogJson as PublicationCatalogV1,
	mediumManifest: mediumManifestJson as MediumManifest,
	releaseTarget: releaseTargetJson as ReleaseTarget,
});
