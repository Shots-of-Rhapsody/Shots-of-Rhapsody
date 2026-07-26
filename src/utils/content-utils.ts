import { type CollectionEntry, getCollection } from "astro:content";

export function getPostHeadline(post: CollectionEntry<"posts">): string {
	return post.data.exportTitle || post.data.title;
}

export function getPostDeck(post: CollectionEntry<"posts">): string {
	return (
		post.data.summary ||
		post.data.description ||
		post.data.subtitle ||
		getPostHeadline(post)
	);
}

async function getRawSortedPosts() {
	const posts = await getCollection("posts");
	return posts.toSorted((left, right) => {
		const byDate =
			right.data.published.valueOf() - left.data.published.valueOf();
		return byDate || left.id.localeCompare(right.id);
	});
}

export async function getSortedPosts() {
	return getRawSortedPosts();
}

export type PostForList = {
	slug: string;
	data: Pick<
		CollectionEntry<"posts">["data"],
		"title" | "tags" | "category" | "published"
	>;
};

export async function getSortedPostsList(): Promise<PostForList[]> {
	const posts = await getRawSortedPosts();
	return posts.map((post) => ({
		slug: post.id,
		data: {
			title: getPostHeadline(post),
			tags: post.data.tags,
			category: post.data.category,
			published: post.data.published,
		},
	}));
}
