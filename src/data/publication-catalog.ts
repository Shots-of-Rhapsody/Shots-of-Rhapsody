import mediumManifestJson from "../../provenance/medium/manifest.json" with {
	type: "json",
};
import publicationCatalogJson from "../../provenance/publication-catalog.json" with {
	type: "json",
};
import releaseTargetJson from "../../provenance/release-target.json" with {
	type: "json",
};
import {
	getPublishedPostMarkdownPath,
	isMasterFolder,
	type MasterFolder,
	masterFolderForSection,
	type WritingSection,
} from "../utils/content-path.ts";
import { IS_PUBLIC_REVIEW, type ShotsBuildMode } from "./build-mode.ts";

export type { MasterFolder, WritingSection } from "../utils/content-path.ts";
export type PublicationSource = "tai-song" | "medium" | "first-party";

export interface PublicationCatalogEntry {
	readonly slug: string;
	readonly source: PublicationSource;
	readonly markdown: string;
	readonly section: WritingSection;
	readonly masterFolder: MasterFolder;
}

export interface PublicationCatalogV2 {
	readonly schemaVersion: 2;
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
		!(["tai-song", "medium", "first-party"] as const).includes(entry.source) ||
		!(["fiction", "poetry-reflection", "nonfiction"] as const).includes(
			entry.section,
		) ||
		!isMasterFolder(entry.masterFolder) ||
		entry.masterFolder !== masterFolderForSection(entry.section) ||
		entry.markdown !==
			getPublishedPostMarkdownPath(entry.masterFolder, entry.slug) ||
		(entry.source === "medium" && entry.section !== "nonfiction")
	) {
		throw new Error(`${label} contains an invalid publication entry`);
	}
}

export function createEffectivePublicationCatalog({
	mode: _mode,
	publicationCatalog,
	mediumManifest,
	releaseTarget,
}: {
	readonly mode: ShotsBuildMode;
	readonly publicationCatalog: PublicationCatalogV2;
	readonly mediumManifest: MediumManifest;
	readonly releaseTarget: ReleaseTarget;
}): PublicationCatalogV2 {
	if (
		publicationCatalog.schemaVersion !== 2 ||
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
	if (
		publicationCatalog.entries.some((entry) => entry.source === "first-party")
	) {
		throw new Error(
			"The v1.0.0 publication catalog permits only the sealed archive and Medium essays",
		);
	}
	if (mediumManifest.state !== "active") {
		throw new Error("The v1.0.0 catalog requires the active Medium manifest");
	}
	if (mediumManifest.articles.length !== releaseTarget.expected.mediumWriting) {
		throw new Error("The v1.0.0 catalog requires exactly 24 Medium essays");
	}

	const mediumEntries = publicationCatalog.entries.filter(
		(entry) => entry.source === "medium",
	);
	for (const entry of mediumEntries) {
		assertCatalogEntry(entry, "Release Medium catalog");
	}
	const mediumBySlug = new Map(
		mediumManifest.articles.map((article) => [article.slug, article]),
	);
	if (
		mediumEntries.length !== releaseTarget.expected.mediumWriting ||
		mediumEntries.some(
			(entry) =>
				mediumBySlug.get(entry.slug)?.paths.markdown !== entry.markdown,
		) ||
		mediumManifest.articles.some(
			(article) => !mediumEntries.some((entry) => entry.slug === article.slug),
		)
	) {
		throw new Error(
			"The v1.0.0 publication catalog must bind all 24 Medium essays to their manifest paths",
		);
	}
	if (
		publicationCatalog.entries.length !==
		releaseTarget.expected.archiveWriting + releaseTarget.expected.mediumWriting
	) {
		throw new Error("The v1.0.0 publication catalog has an invalid count");
	}
	if (
		new Set(publicationCatalog.entries.map((entry) => entry.slug)).size !==
		publicationCatalog.entries.length
	) {
		throw new Error("The v1.0.0 publication catalog repeats a slug");
	}
	return publicationCatalog;
}

export const PUBLICATION_CATALOG = createEffectivePublicationCatalog({
	mode: IS_PUBLIC_REVIEW ? "public-review" : "release",
	publicationCatalog: publicationCatalogJson as PublicationCatalogV2,
	mediumManifest: mediumManifestJson as MediumManifest,
	releaseTarget: releaseTargetJson as ReleaseTarget,
});
