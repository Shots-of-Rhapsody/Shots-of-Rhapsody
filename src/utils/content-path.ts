export const MASTER_FOLDERS = ["fiction", "nonfiction"] as const;

export type MasterFolder = (typeof MASTER_FOLDERS)[number];
export type WritingSection = "fiction" | "poetry-reflection" | "nonfiction";

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export function isMasterFolder(value: unknown): value is MasterFolder {
	return MASTER_FOLDERS.includes(value as MasterFolder);
}

export function masterFolderForSection(section: WritingSection): MasterFolder {
	if (section === "nonfiction") return "nonfiction";
	if (section === "fiction" || section === "poetry-reflection")
		return "fiction";
	throw new Error(`Unsupported writing section: ${String(section)}`);
}

function assertContentSlug(slug: string): void {
	if (!SLUG_PATTERN.test(slug)) {
		throw new Error(`Invalid content slug: ${slug}`);
	}
}

export function getPublishedPostDirectory(
	masterFolder: MasterFolder,
	slug: string,
): `src/content/posts/${MasterFolder}/${string}` {
	if (!isMasterFolder(masterFolder)) {
		throw new Error(`Invalid master folder: ${String(masterFolder)}`);
	}
	assertContentSlug(slug);
	return `src/content/posts/${masterFolder}/${slug}`;
}

export function getPublishedPostsRoot(
	masterFolder: MasterFolder,
): `src/content/posts/${MasterFolder}` {
	if (!isMasterFolder(masterFolder)) {
		throw new Error(`Invalid master folder: ${String(masterFolder)}`);
	}
	return `src/content/posts/${masterFolder}`;
}

export function getPublishedPostMarkdownPath(
	masterFolder: MasterFolder,
	slug: string,
): `src/content/posts/${MasterFolder}/${string}/index.md` {
	return `${getPublishedPostDirectory(masterFolder, slug)}/index.md`;
}

export function getPublishedPostAssetPrefix(
	masterFolder: MasterFolder,
	slug: string,
): `src/content/posts/${MasterFolder}/${string}/` {
	return `${getPublishedPostDirectory(masterFolder, slug)}/`;
}

export function getDraftPostDirectory(
	section: WritingSection,
	slug: string,
): `src/content/drafts/${MasterFolder}/${string}` {
	assertContentSlug(slug);
	return `src/content/drafts/${masterFolderForSection(section)}/${slug}`;
}

export function parsePublishedPostMarkdownPath(
	repositoryPath: string,
): { masterFolder: MasterFolder; slug: string } | undefined {
	const match =
		/^src\/content\/posts\/(fiction|nonfiction)\/([a-z0-9]+(?:-[a-z0-9]+)*)\/index\.md$/u.exec(
			repositoryPath,
		);
	if (!match) return undefined;
	return { masterFolder: match[1] as MasterFolder, slug: match[2] };
}
