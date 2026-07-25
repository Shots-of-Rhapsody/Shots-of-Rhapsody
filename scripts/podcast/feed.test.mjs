import assert from "node:assert/strict";
import test from "node:test";
import { PODCAST_EPISODES, PODCAST_SHOW } from "../../src/data/podcast.ts";
import { generatePodcastFeed } from "./feed.mjs";

function approvedFixture() {
	const show = {
		...PODCAST_SHOW,
		status: "published",
		description: "Stories and reflections in audio.",
		explicit: false,
		artwork: { ...PODCAST_SHOW.artwork, approved: true },
	};
	const episode = {
		...PODCAST_EPISODES[0],
		status: "published",
		description: "A reviewed description & introduction.",
		publishedAt: "2026-08-01T12:00:00.000Z",
		explicit: false,
		audio: {
			...PODCAST_EPISODES[0].audio,
			loudnessLkfs: -16,
			truePeakDbfs: -1,
			qualityApproved: true,
		},
		transcript: {
			sourcePath: "src/content/podcast/modular-ethics/transcript.html",
			publicPath: "/podcast/modular-ethics/transcript/",
			vttPath: "/podcast/transcripts/modular-ethics.vtt",
			language: "en",
			sha256: `sha256:${"a".repeat(64)}`,
			reviewed: true,
		},
	};
	return { show, episode };
}

test("private feed generator emits immutable enclosure and transcript metadata", () => {
	const { show, episode } = approvedFixture();
	const feed = generatePodcastFeed({
		baseUrl: "https://shots-of-rhapsody.example/",
		show,
		episodes: [episode],
	});
	assert.match(feed, /<rss version="2\.0"/u);
	assert.match(
		feed,
		/<guid isPermaLink="false">urn:uuid:6f80fb49-6912-4544-8994-1ab5ca4a682d<\/guid>/u,
	);
	assert.match(
		feed,
		/<enclosure url="https:\/\/shots-of-rhapsody\.example\/media\/podcast\/episode-001-modular-ethics\.mp3" length="57831360" type="audio\/mpeg" \/>/u,
	);
	assert.match(feed, /type="text\/html" language="en"/u);
	assert.match(feed, /type="text\/vtt" language="en"/u);
	assert.match(feed, /A reviewed description &amp; introduction\./u);
});

test("feed generator refuses temporary hosting and draft episodes", () => {
	const { show, episode } = approvedFixture();
	assert.throws(
		() =>
			generatePodcastFeed({
				baseUrl: "https://shots-of-rhapsody.github.io/Shots-of-Rhapsody/",
				show,
				episodes: [episode],
			}),
		/permanent custom domain/u,
	);
	assert.throws(
		() =>
			generatePodcastFeed({
				baseUrl: "https://shots-of-rhapsody.example/",
				show,
				episodes: [{ ...episode, status: "draft" }],
			}),
		/incomplete or unreviewed/u,
	);
});
