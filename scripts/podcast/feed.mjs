import {
	assertPodcastManifest,
	isPodcastEpisodePublishable,
} from "../../src/data/podcast.ts";

function escapeXml(value) {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function absoluteUrl(baseUrl, pathname) {
	return new URL(pathname.replace(/^\//u, ""), baseUrl).toString();
}

function assertPermanentFeedOrigin(baseUrl) {
	const parsed = new URL(baseUrl);
	if (
		parsed.protocol !== "https:" ||
		parsed.username !== "" ||
		parsed.password !== "" ||
		parsed.search !== "" ||
		parsed.hash !== ""
	) {
		throw new Error("Podcast feed origin must be a plain HTTPS URL");
	}
	if (parsed.hostname.toLowerCase().endsWith(".github.io"))
		throw new Error(
			"Podcast feed generation requires the permanent custom domain",
		);
	return parsed;
}

export function generatePodcastFeed({ baseUrl, show, episodes }) {
	const origin = assertPermanentFeedOrigin(baseUrl);
	assertPodcastManifest(episodes, show);
	if (show.status !== "published")
		throw new Error("Podcast feed requires a published show");
	if (episodes.length === 0)
		throw new Error("Podcast feed requires at least one episode");
	if (episodes.some((episode) => !isPodcastEpisodePublishable(episode, show)))
		throw new Error("Podcast feed refuses incomplete or unreviewed episodes");
	if (show.description === null || show.explicit === null)
		throw new Error("Podcast feed show metadata is incomplete");

	const seriesUrl = absoluteUrl(origin, "/podcast/");
	const feedUrl = absoluteUrl(origin, show.feedPath);
	const artworkUrl = absoluteUrl(origin, show.artwork.publicPath);
	const items = [...episodes]
		.sort(
			(a, b) =>
				Date.parse(b.publishedAt ?? "") - Date.parse(a.publishedAt ?? ""),
		)
		.map((episode) => {
			if (
				episode.description === null ||
				episode.author === null ||
				episode.publishedAt === null ||
				episode.explicit === null ||
				episode.guid === null ||
				episode.transcript === null
			) {
				throw new Error(`Podcast feed metadata is incomplete: ${episode.slug}`);
			}
			const episodeUrl = absoluteUrl(origin, `/podcast/${episode.slug}/`);
			const transcriptUrl = absoluteUrl(origin, episode.transcript.publicPath);
			const vtt = episode.transcript.vttPath
				? `\n      <podcast:transcript url="${escapeXml(absoluteUrl(origin, episode.transcript.vttPath))}" type="text/vtt" language="${escapeXml(episode.transcript.language)}" />`
				: "";
			return `    <item>
      <title>${escapeXml(episode.title)}</title>
      <link>${escapeXml(episodeUrl)}</link>
      <guid isPermaLink="false">${escapeXml(episode.guid)}</guid>
      <pubDate>${escapeXml(new Date(episode.publishedAt).toUTCString())}</pubDate>
      <description>${escapeXml(episode.description)}</description>
      <itunes:author>${escapeXml(episode.author)}</itunes:author>
      <itunes:explicit>${episode.explicit}</itunes:explicit>
      <itunes:episode>${episode.episodeNumber}</itunes:episode>
      <itunes:episodeType>${escapeXml(episode.episodeType)}</itunes:episodeType>
      <itunes:duration>${escapeXml(episode.audio.duration)}</itunes:duration>
      <enclosure url="${escapeXml(absoluteUrl(origin, episode.audio.publicPath))}" length="${episode.audio.byteLength}" type="${escapeXml(episode.audio.mimeType)}" />
      <podcast:transcript url="${escapeXml(transcriptUrl)}" type="text/html" language="${escapeXml(episode.transcript.language)}" />${vtt}
    </item>`;
		})
		.join("\n");

	return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0">
  <channel>
    <title>${escapeXml(show.title)}</title>
    <link>${escapeXml(seriesUrl)}</link>
    <description>${escapeXml(show.description)}</description>
    <language>${escapeXml(show.language)}</language>
    <itunes:author>${escapeXml(show.author)}</itunes:author>
    <itunes:explicit>${show.explicit}</itunes:explicit>
    <itunes:type>episodic</itunes:type>
    <itunes:image href="${escapeXml(artworkUrl)}" />
    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml" />
${items}
  </channel>
</rss>
`;
}
