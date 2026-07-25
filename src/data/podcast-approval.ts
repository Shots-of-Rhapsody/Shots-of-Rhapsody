import { createHash } from "node:crypto";
import contentSignoffsJson from "../../provenance/reviews/content-signoffs-v2.json" with {
	type: "json",
};
import {
	getPublishablePodcastEpisodes,
	PODCAST_SHOW,
	type PodcastEpisode,
	type PodcastShow,
} from "./podcast.ts";
import type { ContentSignoffV2 } from "./signoffs.ts";

interface ContentSignoffLedgerV2 {
	readonly version: 2;
	readonly entries: readonly ContentSignoffV2[];
}

const committedContentSignoffs =
	contentSignoffsJson as unknown as ContentSignoffLedgerV2;

export function getPodcastReviewOutputSha256(
	episode: PodcastEpisode,
	show: PodcastShow = PODCAST_SHOW,
): `sha256:${string}` {
	if (episode.transcript === null)
		throw new Error(
			`Podcast review output cannot be calculated without a transcript: ${episode.slug}`,
		);
	const reviewEnvelope = {
		show: {
			title: show.title,
			description: show.description,
			author: show.author,
			language: show.language,
			explicit: show.explicit,
		},
		episode: {
			slug: episode.slug,
			title: episode.title,
			description: episode.description,
			author: episode.author,
			publishedAt: episode.publishedAt,
			explicit: episode.explicit,
			episodeType: episode.episodeType,
			episodeNumber: episode.episodeNumber,
			guid: episode.guid,
			rightsCleared: episode.rightsCleared,
			audio: episode.audio,
			transcript: episode.transcript,
		},
		artwork: show.artwork,
	};
	return `sha256:${createHash("sha256")
		.update(Buffer.from(JSON.stringify(reviewEnvelope), "utf8"))
		.digest("hex")}`;
}

export function assertPodcastContentSignoff(
	episode: PodcastEpisode,
	ledger: ContentSignoffLedgerV2,
	show: PodcastShow = PODCAST_SHOW,
): ContentSignoffV2 {
	if (ledger.version !== 2 || !Array.isArray(ledger.entries))
		throw new Error("Podcast content signoff ledger is malformed");
	if (episode.transcript === null)
		throw new Error(
			`Podcast content signoff cannot be checked without a transcript: ${episode.slug}`,
		);
	const signoff: ContentSignoffV2 | undefined = ledger.entries.find(
		(entry) => entry.kind === "podcast" && entry.slug === episode.slug,
	);
	if (
		signoff?.reviewer !== "Tai Song" ||
		signoff.accuracy !== "passed" ||
		signoff.rights !== "passed"
	)
		throw new Error(`Podcast content signoff is missing: ${episode.slug}`);

	const expectedAssets = [
		episode.audio.sha256,
		show.artwork.sha256,
		episode.transcript.sha256,
	];
	if (signoff.sourceSha256 !== episode.audio.sha256)
		throw new Error(`Podcast content signoff has stale audio: ${episode.slug}`);
	if (signoff.outputSha256 !== getPodcastReviewOutputSha256(episode, show))
		throw new Error(
			`Podcast content signoff has stale transcript or metadata: ${episode.slug}`,
		);
	if (
		signoff.assetSha256.length !== expectedAssets.length ||
		signoff.assetSha256.some(
			(digest, index) => digest !== expectedAssets[index],
		)
	)
		throw new Error(
			`Podcast content signoff has stale assets: ${episode.slug}`,
		);
	return signoff;
}

export function getApprovedPodcastEpisodes(
	ledger: ContentSignoffLedgerV2 = committedContentSignoffs,
	show: PodcastShow = PODCAST_SHOW,
): PodcastEpisode[] {
	return getPublishablePodcastEpisodes().filter((episode) => {
		try {
			assertPodcastContentSignoff(episode, ledger, show);
			return true;
		} catch {
			return false;
		}
	});
}
