import podcastManifestJson from "../content/podcast/manifest.json" with {
	type: "json",
};
import {
	hasApprovedCurrentAudioDecision,
	PODCAST_AUDIO_DECISIONS,
	type PodcastAudioDecisionLedgerV1,
	type PodcastAudioDistributionDecision,
} from "./podcast-audio-decisions.ts";

export type PodcastPublicationStatus = "draft" | "published";

export interface PodcastArtwork {
	readonly sourcePath: string;
	readonly sourceSha256: `sha256:${string}`;
	readonly archivePath: string;
	readonly publicPath: string;
	readonly sha256: `sha256:${string}`;
	readonly mimeType: "image/png";
	readonly width: number;
	readonly height: number;
	readonly approved: boolean;
}

export interface PodcastShow {
	readonly status: PodcastPublicationStatus;
	readonly title: string;
	readonly description: string | null;
	readonly author: string;
	readonly language: string;
	readonly explicit: boolean | null;
	readonly feedPath: string;
	readonly artwork: PodcastArtwork;
}

export interface PodcastTranscript {
	readonly sourcePath: string;
	readonly publicPath: string;
	readonly vttPath: string | null;
	readonly language: string;
	readonly sha256: `sha256:${string}`;
	readonly reviewed: boolean;
}

export interface PodcastAudio {
	readonly publicPath: string;
	readonly mimeType: "audio/mpeg";
	readonly byteLength: number;
	readonly sha256: `sha256:${string}`;
	readonly duration: string;
	readonly durationSeconds: number | null;
	readonly codec: string;
	readonly sampleRateHz: number | null;
	readonly channels: number | null;
	readonly channelMode: string;
	readonly bitrateBps: number | null;
	readonly loudnessLkfs: number | null;
	readonly truePeakDbfs: number | null;
	readonly distributionDecision: PodcastAudioDistributionDecision;
	readonly qualityApproved: boolean;
}

export interface PodcastEpisode {
	readonly slug: string;
	readonly status: PodcastPublicationStatus;
	readonly title: string;
	readonly description: string | null;
	readonly author: string | null;
	readonly publishedAt: string | null;
	readonly explicit: boolean | null;
	readonly episodeType: "full" | "trailer" | "bonus";
	readonly episodeNumber: number | null;
	readonly guid: string | null;
	readonly rightsCleared: boolean;
	readonly audio: PodcastAudio;
	readonly artwork: PodcastArtwork;
	readonly transcript: PodcastTranscript | null;
}

export type PodcastPublicationBlocker =
	| "show-draft"
	| "show-description-missing"
	| "show-explicit-rating-missing"
	| "show-artwork-unapproved"
	| "episode-draft"
	| "episode-description-missing"
	| "episode-author-missing"
	| "episode-publication-date-missing"
	| "episode-explicit-rating-missing"
	| "episode-number-missing"
	| "episode-guid-missing"
	| "episode-rights-unconfirmed"
	| "audio-metadata-missing"
	| "audio-decision-pending"
	| "audio-retain-approval-missing"
	| "audio-remaster-required"
	| "audio-quality-unapproved"
	| "transcript-unreviewed";

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const PUBLIC_ASCII_PATH_PATTERN = /^\/[A-Za-z0-9._~/-]+$/u;
const REPOSITORY_ASCII_PATH_PATTERN = /^[A-Za-z0-9._~/-]+$/u;

const podcastManifest = podcastManifestJson as unknown as {
	readonly show: PodcastShow;
	readonly episodes: readonly (PodcastEpisode & { readonly id: string })[];
};

export const PODCAST_SHOW: PodcastShow = podcastManifest.show;

export const PODCAST_EPISODES: readonly PodcastEpisode[] =
	podcastManifest.episodes.map(({ id: _id, ...episode }) => episode);

function hasText(value: string | null): value is string {
	return value !== null && value.trim().length > 0;
}

type MeasuredPodcastAudio = PodcastAudio & {
	readonly durationSeconds: number;
	readonly sampleRateHz: number;
	readonly channels: number;
	readonly bitrateBps: number;
	readonly loudnessLkfs: number;
	readonly truePeakDbfs: number;
};

function hasMeasuredAudio(audio: PodcastAudio): audio is MeasuredPodcastAudio {
	return (
		audio.durationSeconds !== null &&
		audio.durationSeconds > 0 &&
		audio.sampleRateHz !== null &&
		audio.sampleRateHz > 0 &&
		audio.channels !== null &&
		audio.channels > 0 &&
		audio.bitrateBps !== null &&
		audio.bitrateBps > 0 &&
		audio.loudnessLkfs !== null &&
		audio.truePeakDbfs !== null
	);
}

function artworkMatches(left: PodcastArtwork, right: PodcastArtwork): boolean {
	return (
		left.sourcePath === right.sourcePath &&
		left.sourceSha256 === right.sourceSha256 &&
		left.archivePath === right.archivePath &&
		left.publicPath === right.publicPath &&
		left.sha256 === right.sha256 &&
		left.mimeType === right.mimeType &&
		left.width === right.width &&
		left.height === right.height
	);
}

export function getPodcastPublicationBlockers(
	episode: PodcastEpisode,
	show: PodcastShow = PODCAST_SHOW,
	audioDecisions: PodcastAudioDecisionLedgerV1 = PODCAST_AUDIO_DECISIONS,
): PodcastPublicationBlocker[] {
	const blockers: PodcastPublicationBlocker[] = [];

	if (show.status !== "published") blockers.push("show-draft");
	if (!hasText(show.description)) blockers.push("show-description-missing");
	if (show.explicit === null) blockers.push("show-explicit-rating-missing");
	if (!show.artwork.approved) blockers.push("show-artwork-unapproved");
	if (episode.status !== "published") blockers.push("episode-draft");
	if (!hasText(episode.description))
		blockers.push("episode-description-missing");
	if (!hasText(episode.author)) blockers.push("episode-author-missing");
	if (episode.publishedAt === null)
		blockers.push("episode-publication-date-missing");
	if (episode.explicit === null)
		blockers.push("episode-explicit-rating-missing");
	if (episode.episodeNumber === null || episode.episodeNumber < 1)
		blockers.push("episode-number-missing");
	if (!hasText(episode.guid)) blockers.push("episode-guid-missing");
	if (!episode.rightsCleared) blockers.push("episode-rights-unconfirmed");
	if (!hasMeasuredAudio(episode.audio)) blockers.push("audio-metadata-missing");
	switch (episode.audio.distributionDecision) {
		case "pending":
			blockers.push("audio-decision-pending");
			break;
		case "retain-current-audio":
			if (!hasApprovedCurrentAudioDecision(episode, audioDecisions))
				blockers.push("audio-retain-approval-missing");
			break;
		case "replace-from-matching-lossless-master":
			blockers.push("audio-remaster-required");
			break;
		default:
			blockers.push("audio-decision-pending");
	}
	if (!episode.audio.qualityApproved) blockers.push("audio-quality-unapproved");
	if (episode.transcript !== null && !episode.transcript.reviewed)
		blockers.push("transcript-unreviewed");

	return blockers;
}

export function isPodcastEpisodePublishable(
	episode: PodcastEpisode,
	show: PodcastShow = PODCAST_SHOW,
	audioDecisions: PodcastAudioDecisionLedgerV1 = PODCAST_AUDIO_DECISIONS,
): boolean {
	return (
		getPodcastPublicationBlockers(episode, show, audioDecisions).length === 0
	);
}

export function getPublishablePodcastEpisodes(): PodcastEpisode[] {
	return PODCAST_EPISODES.filter((episode) =>
		isPodcastEpisodePublishable(episode),
	);
}

export function getReviewablePodcastEpisodes(): PodcastEpisode[] {
	const episodes = PODCAST_EPISODES.filter(
		(episode) =>
			episode.slug === "modular-ethics" &&
			episode.title === "Episode 1: Modular Ethics" &&
			episode.author === "Tai Song" &&
			episode.rightsCleared &&
			episode.audio.distributionDecision === "retain-current-audio" &&
			episode.audio.qualityApproved &&
			hasApprovedCurrentAudioDecision(episode, PODCAST_AUDIO_DECISIONS),
	);
	if (episodes.length !== 1) {
		throw new Error(
			"Public review requires exactly the rights-cleared Modular Ethics audio",
		);
	}
	return episodes;
}

export function assertPodcastManifest(
	episodes: readonly PodcastEpisode[] = PODCAST_EPISODES,
	show: PodcastShow = PODCAST_SHOW,
	audioDecisions: PodcastAudioDecisionLedgerV1 = PODCAST_AUDIO_DECISIONS,
): void {
	if (episodes.length === 0) throw new Error("Podcast manifest is empty");
	if (show.title !== "Shots of Rhapsody Podcast" || show.author !== "Tai Song")
		throw new Error("Podcast show identity differs from the approved contract");
	const firstEpisode = episodes.find((episode) => episode.episodeNumber === 1);
	if (
		firstEpisode?.slug !== "modular-ethics" ||
		firstEpisode?.title !== "Episode 1: Modular Ethics" ||
		firstEpisode?.author !== "Tai Song" ||
		firstEpisode?.audio.publicPath !==
			"/media/podcast/episode-001-modular-ethics.mp3" ||
		!firstEpisode?.rightsCleared
	) {
		throw new Error("Podcast episode 1 differs from the approved contract");
	}

	const slugs = new Set<string>();
	const audioPaths = new Set<string>();
	const guids = new Set<string>();
	const publicPaths = [show.feedPath, show.artwork.publicPath];

	for (const repositoryPath of [
		show.artwork.sourcePath,
		show.artwork.archivePath,
	]) {
		if (
			!REPOSITORY_ASCII_PATH_PATTERN.test(repositoryPath) ||
			repositoryPath.startsWith("/") ||
			repositoryPath.split("/").some((segment) => segment === "..")
		)
			throw new Error("Podcast artwork repository path is malformed");
	}
	if (!SHA256_PATTERN.test(show.artwork.sourceSha256))
		throw new Error("Podcast artwork source SHA-256 is malformed");
	if (!SHA256_PATTERN.test(show.artwork.sha256))
		throw new Error("Podcast artwork PNG SHA-256 is malformed");
	if (show.artwork.width !== show.artwork.height)
		throw new Error("Podcast artwork must be square");

	for (const episode of episodes) {
		if (!artworkMatches(episode.artwork, show.artwork))
			throw new Error(
				`Podcast episode artwork differs from the show contract: ${episode.slug}`,
			);
		if (slugs.has(episode.slug))
			throw new Error(`Duplicate podcast slug: ${episode.slug}`);
		slugs.add(episode.slug);

		if (audioPaths.has(episode.audio.publicPath))
			throw new Error(
				`Duplicate podcast audio path: ${episode.audio.publicPath}`,
			);
		audioPaths.add(episode.audio.publicPath);
		publicPaths.push(episode.audio.publicPath);

		if (!SHA256_PATTERN.test(episode.audio.sha256))
			throw new Error(`Malformed audio SHA-256: ${episode.slug}`);
		if (episode.audio.byteLength <= 0)
			throw new Error(`Invalid audio byte length: ${episode.slug}`);
		if (
			episode.publishedAt !== null &&
			(!Number.isFinite(Date.parse(episode.publishedAt)) ||
				new Date(episode.publishedAt).toISOString() !== episode.publishedAt)
		)
			throw new Error(
				`Podcast publication date must be a canonical UTC timestamp: ${episode.slug}`,
			);
		if (episode.guid !== null) {
			if (guids.has(episode.guid))
				throw new Error(`Duplicate podcast GUID: ${episode.guid}`);
			guids.add(episode.guid);
		}

		if (episode.transcript !== null) {
			if (!SHA256_PATTERN.test(episode.transcript.sha256))
				throw new Error(`Malformed transcript SHA-256: ${episode.slug}`);
			if (
				!REPOSITORY_ASCII_PATH_PATTERN.test(episode.transcript.sourcePath) ||
				episode.transcript.sourcePath.startsWith("/") ||
				episode.transcript.sourcePath
					.split("/")
					.some((segment) => segment === "..")
			) {
				throw new Error(
					`Podcast transcript source path is malformed: ${episode.slug}`,
				);
			}
			publicPaths.push(episode.transcript.publicPath);
			if (episode.transcript.vttPath)
				publicPaths.push(episode.transcript.vttPath);
		}

		if (
			episode.status === "published" &&
			getPodcastPublicationBlockers(episode, show, audioDecisions).length > 0
		) {
			throw new Error(
				`Published podcast episode is incomplete: ${episode.slug}`,
			);
		}
	}

	for (const publicPath of publicPaths) {
		if (!PUBLIC_ASCII_PATH_PATTERN.test(publicPath) || publicPath.includes(" "))
			throw new Error(
				`Podcast public path must be absolute and ASCII: ${publicPath}`,
			);
		if (
			!publicPath.startsWith("/podcast/") &&
			!publicPath.startsWith("/media/podcast/")
		)
			throw new Error(
				`Podcast public path escaped its route boundary: ${publicPath}`,
			);
		if (publicPath.toLowerCase().includes("legacy"))
			throw new Error(
				`Podcast public path exposes legacy storage: ${publicPath}`,
			);
	}
}

assertPodcastManifest();
