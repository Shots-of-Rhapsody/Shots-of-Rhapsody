import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
	assertPodcastManifest,
	getPodcastPublicationBlockers,
	getPublishablePodcastEpisodes,
	isPodcastEpisodePublishable,
	PODCAST_EPISODES,
	PODCAST_SHOW,
} from "../../src/data/podcast.ts";
import {
	assertPodcastContentSignoff,
	getApprovedPodcastEpisodes,
	getPodcastReviewOutputSha256,
} from "../../src/data/podcast-approval.ts";
import {
	PODCAST_AUDIO_DECISIONS,
	validatePodcastAudioDecisionLedgerV1,
} from "../../src/data/podcast-audio-decisions.ts";
import { verifyPodcastDraft, verifyPodcastRelease } from "./verify.mjs";

test("approved identity, route, media path, and measurements are exact", () => {
	const episode = PODCAST_EPISODES[0];
	assert.equal(PODCAST_SHOW.title, "Shots of Rhapsody Podcast");
	assert.equal(episode.slug, "modular-ethics");
	assert.equal(episode.title, "Episode 1: Modular Ethics");
	assert.equal(episode.author, "Tai Song");
	assert.equal(episode.rightsCleared, true);
	assert.equal(
		episode.audio.publicPath,
		"/media/podcast/episode-001-modular-ethics.mp3",
	);
	assert.deepEqual(
		[
			episode.audio.durationSeconds,
			episode.audio.sampleRateHz,
			episode.audio.channels,
			episode.audio.bitrateBps,
			episode.audio.loudnessLkfs,
			episode.audio.truePeakDbfs,
		],
		[1445.784, 48_000, 2, 320_000, -27, -6.9],
	);
	assert.equal(episode.audio.distributionDecision, "retain-current-audio");
	assert.equal(episode.audio.qualityApproved, true);
	assert.deepEqual(PODCAST_AUDIO_DECISIONS.entries, [
		{
			slug: "modular-ethics",
			decision: "retain-current-audio",
			audioSha256:
				"sha256:b4ec04aa9f99b0c52c3bd77123962cd7d7a49b316147bd293ad011698d232dc3",
			reviewer: "Tai Song",
			reviewedAt: "2026-07-26T07:55:35.215Z",
			approval: "passed",
		},
	]);
});

function completeShow() {
	return {
		...PODCAST_SHOW,
		status: "published",
		description: "A first-party audio series from Shots of Rhapsody.",
		explicit: false,
		artwork: { ...PODCAST_SHOW.artwork, approved: true },
	};
}

function completeEpisode() {
	const episode = PODCAST_EPISODES[0];
	return {
		...episode,
		status: "published",
		description: "An approved episode description.",
		author: "Tai Song",
		publishedAt: "2026-07-25T12:00:00.000Z",
		explicit: false,
		guid: "urn:uuid:6f80fb49-6912-4544-8994-1ab5ca4a682d",
		rightsCleared: true,
		audio: {
			...episode.audio,
			distributionDecision: "retain-current-audio",
			qualityApproved: true,
		},
		transcript: null,
	};
}

function reviewedTranscript() {
	return {
		sourcePath: "src/content/podcast/modular-ethics/transcript.html",
		publicPath: "/podcast/modular-ethics/transcript/",
		vttPath: "/podcast/transcripts/modular-ethics.vtt",
		language: "en",
		sha256:
			"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		reviewed: true,
	};
}

function approvedAudioDecision(episode = completeEpisode()) {
	return {
		version: 1,
		entries: [
			{
				slug: episode.slug,
				decision: "retain-current-audio",
				audioSha256: episode.audio.sha256,
				reviewer: "Tai Song",
				reviewedAt: "2026-07-25T12:00:00.000Z",
				approval: "passed",
			},
		],
	};
}

test("the recorded episode remains fail-closed on missing publication metadata", () => {
	const blockers = getPodcastPublicationBlockers(PODCAST_EPISODES[0]);
	assert.ok(blockers.includes("episode-draft"));
	assert.ok(blockers.includes("episode-description-missing"));
	assert.ok(!blockers.some((blocker) => blocker.startsWith("transcript-")));
	assert.ok(!blockers.some((blocker) => blocker.startsWith("audio-")));
	assert.equal(isPodcastEpisodePublishable(PODCAST_EPISODES[0]), false);
	assert.deepEqual(getPublishablePodcastEpisodes(), []);
	assert.deepEqual(getApprovedPodcastEpisodes(), []);
});

test("changing only the episode status cannot bypass publication gates", () => {
	const episode = { ...PODCAST_EPISODES[0], status: "published" };
	assert.ok(
		getPodcastPublicationBlockers(episode).includes(
			"episode-description-missing",
		),
	);
	assert.throws(
		() => assertPodcastManifest([episode]),
		/Published podcast episode is incomplete/u,
	);
});

test("a complete reviewed fixture is eligible without a transcript", () => {
	const show = completeShow();
	const episode = completeEpisode();
	const audioDecisions = approvedAudioDecision(episode);
	assert.deepEqual(
		getPodcastPublicationBlockers(episode, show, audioDecisions),
		[],
	);
	assert.equal(
		isPodcastEpisodePublishable(episode, show, audioDecisions),
		true,
	);
	assert.doesNotThrow(() =>
		assertPodcastManifest([episode], show, audioDecisions),
	);
});

test("a provided podcast transcript must be reviewed", () => {
	const show = completeShow();
	const episode = {
		...completeEpisode(),
		transcript: { ...reviewedTranscript(), reviewed: false },
	};
	assert.ok(
		getPodcastPublicationBlockers(
			episode,
			show,
			approvedAudioDecision(episode),
		).includes("transcript-unreviewed"),
	);
	episode.transcript.reviewed = true;
	assert.deepEqual(
		getPodcastPublicationBlockers(
			episode,
			show,
			approvedAudioDecision(episode),
		),
		[],
	);
});

test("retaining the exact current audio requires a separate hash-bound author approval", () => {
	const show = completeShow();
	const episode = completeEpisode();
	assert.ok(
		getPodcastPublicationBlockers(episode, show, {
			version: 1,
			entries: [],
		}).includes("audio-retain-approval-missing"),
	);
	const stale = approvedAudioDecision(episode);
	stale.entries[0].audioSha256 = `sha256:${"f".repeat(64)}`;
	assert.ok(
		getPodcastPublicationBlockers(episode, show, stale).includes(
			"audio-retain-approval-missing",
		),
	);
	assert.deepEqual(
		getPodcastPublicationBlockers(
			episode,
			show,
			approvedAudioDecision(episode),
		),
		[],
	);
	assert.ok(
		getPodcastPublicationBlockers(
			{
				...PODCAST_EPISODES[0],
				audio: {
					...PODCAST_EPISODES[0].audio,
					distributionDecision: "pending",
				},
			},
			PODCAST_SHOW,
			approvedAudioDecision(episode),
		).includes("audio-decision-pending"),
	);
});

test("a replacement request is non-publishable and imported bytes restart pending", () => {
	const show = completeShow();
	const current = completeEpisode();
	const replacementRequested = {
		...current,
		audio: {
			...current.audio,
			distributionDecision: "replace-from-matching-lossless-master",
			qualityApproved: false,
		},
	};
	assert.ok(
		getPodcastPublicationBlockers(
			replacementRequested,
			show,
			approvedAudioDecision(current),
		).includes("audio-remaster-required"),
	);

	const imported = {
		...current,
		audio: {
			...current.audio,
			sha256: `sha256:${"b".repeat(64)}`,
			byteLength: current.audio.byteLength + 1,
			distributionDecision: "pending",
			qualityApproved: false,
		},
	};
	assert.ok(
		getPodcastPublicationBlockers(
			imported,
			show,
			approvedAudioDecision(current),
		).includes("audio-decision-pending"),
	);

	const retainedReplacement = {
		...imported,
		audio: {
			...imported.audio,
			distributionDecision: "retain-current-audio",
			qualityApproved: true,
		},
	};
	assert.ok(
		getPodcastPublicationBlockers(
			retainedReplacement,
			show,
			approvedAudioDecision(current),
		).includes("audio-retain-approval-missing"),
	);
	assert.deepEqual(
		getPodcastPublicationBlockers(
			retainedReplacement,
			show,
			approvedAudioDecision(retainedReplacement),
		),
		[],
	);
});

test("audio decision records reject inferred or malformed approval", () => {
	assert.deepEqual(
		validatePodcastAudioDecisionLedgerV1({ version: 1, entries: [] }),
		{ version: 1, entries: [] },
	);
	const malformed = approvedAudioDecision();
	malformed.entries[0].reviewedAt = "2026-07-25T12:00:00Z";
	assert.throws(
		() => validatePodcastAudioDecisionLedgerV1(malformed),
		/incomplete/u,
	);
});

test("podcast approval binds audio, artwork, and metadata without a transcript", () => {
	const show = completeShow();
	const episode = completeEpisode();
	const ledger = {
		version: 2,
		entries: [
			{
				slug: episode.slug,
				kind: "podcast",
				sourceSha256: episode.audio.sha256,
				outputSha256: getPodcastReviewOutputSha256(episode, show),
				assetSha256: [episode.audio.sha256, show.artwork.sha256],
				reviewer: "Tai Song",
				reviewedAt: "2026-07-25T12:00:00.000Z",
				accuracy: "passed",
				rights: "passed",
			},
		],
	};
	assert.doesNotThrow(() => assertPodcastContentSignoff(episode, ledger, show));
	ledger.entries[0].outputSha256 = `sha256:${"f".repeat(64)}`;
	assert.throws(
		() => assertPodcastContentSignoff(episode, ledger, show),
		/stale episode metadata/u,
	);
});

test("podcast approval binds an optional transcript when one is present", () => {
	const show = completeShow();
	const episode = { ...completeEpisode(), transcript: reviewedTranscript() };
	const ledger = {
		version: 2,
		entries: [
			{
				slug: episode.slug,
				kind: "podcast",
				sourceSha256: episode.audio.sha256,
				outputSha256: getPodcastReviewOutputSha256(episode, show),
				assetSha256: [
					episode.audio.sha256,
					show.artwork.sha256,
					episode.transcript.sha256,
				],
				reviewer: "Tai Song",
				reviewedAt: "2026-07-25T12:00:00.000Z",
				accuracy: "passed",
				rights: "passed",
			},
		],
	};
	assert.doesNotThrow(() => assertPodcastContentSignoff(episode, ledger, show));
});

test("podcast publication requires a genuine content signoff", () => {
	assert.throws(
		() =>
			assertPodcastContentSignoff(
				completeEpisode(),
				{ version: 2, entries: [] },
				completeShow(),
			),
		/content signoff is missing/u,
	);
});

test("duplicate slugs and audio paths fail closed", () => {
	const episode = PODCAST_EPISODES[0];
	assert.throws(
		() => assertPodcastManifest([episode, episode]),
		/Duplicate podcast slug/u,
	);
});

test("podcast publication timestamps use canonical UTC form", () => {
	const episode = {
		...completeEpisode(),
		publishedAt: "2026-07-25T12:00:00Z",
	};
	assert.throws(
		() => assertPodcastManifest([episode], completeShow()),
		/canonical UTC timestamp/u,
	);
});

test("draft evidence matches the permanent MP3", async () => {
	const result = await verifyPodcastDraft();
	assert.equal(result.audioBytes, 57_831_360);
	assert.equal(
		result.audioSha256,
		"sha256:b4ec04aa9f99b0c52c3bd77123962cd7d7a49b316147bd293ad011698d232dc3",
	);
	assert.equal(result.publishableEpisodes, 0);
	assert.equal(
		result.coverPngSha256,
		"sha256:293125a3959b91fd3f263905c3f67e360fdb0f62d784653d10311486b0008c70",
	);
});

test("complete verification rejects the unreviewed draft", async () => {
	await assert.rejects(
		verifyPodcastRelease(),
		/Podcast publication is incomplete/u,
	);
});

test("podcast verification accepts only the combined first-release target", async () => {
	await assert.rejects(
		verifyPodcastRelease({ release: "v1.1.0" }),
		/Unsupported podcast release target/u,
	);
});

test("the native player never preloads audio", async () => {
	const source = await readFile(
		new URL(
			"../../src/components/podcast/PodcastPlayer.astro",
			import.meta.url,
		),
		"utf8",
	);
	assert.match(source, /<audio controls preload="none">/u);
	assert.match(source, /byteLength \/ 1024 \*\* 2/u);
	assert.match(source, /Rights and permissions/u);
	assert.doesNotMatch(source, /autoplay/u);
});
