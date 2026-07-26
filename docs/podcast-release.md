# Podcast release boundary

The repository contains one verified recording, but no podcast episode is
approved for publication. The podcast manifest is intentionally fail-closed:
the show and episode are drafts, the transcript is not human-reviewed, the
audio requires a lossless-master quality decision, the cover awaits visual
approval, and no audio file or podcast feed is emitted in the built site.

The audio decision is separate from general content signoff. The manifest is
currently `pending`, and the versioned decision ledger is empty. Retaining the
existing MP3 requires a genuine Tai Song record in
`provenance/reviews/podcast-audio-decisions-v1.json` bound to that exact audio
SHA-256; tooling must never create that record automatically.

`retain-current-audio` means only the bytes currently named in the manifest;
it is not a permanent waiver for Episode 1. The
`replace-from-matching-lossless-master` value is an explicit, non-publishable
request. After replacement bytes and their measured metadata are imported,
the importer must reset the decision to `pending` and `qualityApproved` to
`false`. Tai Song may then approve those new exact bytes by adding a separate
`retain-current-audio` ledger record. The prior hash-bound approval cannot
authorize a replacement.

Episode 1 belongs to the combined v1.0.0 launch alongside the 11 existing
works and 24 approved Medium essays. There is no earlier writing-only release
or separate later podcast rollout: the combined release remains blocked until
all 35 written works and Episode 1 satisfy their respective accuracy, rights,
presentation, and publication gates.

## Current evidence

- Permanent tracked source:
  `public/media/podcast/episode-001-modular-ethics.mp3`
- Exact byte length: `57,831,360`
- SHA-256:
  `b4ec04aa9f99b0c52c3bd77123962cd7d7a49b316147bd293ad011698d232dc3`
- Intended permanent public path:
  `/media/podcast/episode-001-modular-ethics.mp3`
- Intended feed path: `/podcast/feed.xml`
- Cover source:
  `src/assets/podcast/shots-of-rhapsody-podcast-cover.svg`
- Opaque 3000 by 3000 PNG:
  `src/assets/podcast/shots-of-rhapsody-podcast-cover.png`
- PNG SHA-256:
  `293125a3959b91fd3f263905c3f67e360fdb0f62d784653d10311486b0008c70`
- Measured audio: MPEG-1 Layer III, 48 kHz, two-channel stereo, 320 kbps,
  `00:24:05.784`, integrated loudness `-27.00` LUFS, true peak `-6.90` dBTP.
- The MP3 contains no embedded title, artist, or album tags. Legacy player
  labels are not part of the audio bytes and will not be imported.

- A privately retained 96 kHz, 16-bit stereo PCM candidate was compared with
  the MP3. Its central program aligns closely, but its opening, ending,
  duration, and mastering differ. It is therefore related source evidence,
  not the authoritative lossless final master, and must not be used to
  regenerate the MP3. A future remaster requires a lossless source matching
  the approved final edit and a new complete listening review.

The exact Git blob now lives at its permanent ASCII-only path. The build
integration removes it from draft artifacts and permits those bytes only when
the approved episode route exists. It must not be duplicated, recompressed,
linked from a public page, or added to an RSS enclosure while the manifest
reports any publication blocker.

## Required release sequence

1. Retain the confirmed recording and distribution rights in a genuine
   `ContentSignoffV2` record. For a podcast record, `sourceSha256` is the
   approved audio hash, `outputSha256` is the deterministic review-envelope
   hash covering show, episode, audio, transcript, artwork, and rights metadata,
   and `assetSha256` lists audio, artwork, then transcript hashes in that order.
2. Inspect the exact MP3 with a pinned, checksum-verified media utility. Record
   codec, duration, sample rate, channels, bitrate, integrated loudness, and
   true peak without changing the source bytes.
3. Produce and human-review an equivalent transcript with speaker labels and
   meaningful non-speech audio. Publish accessible HTML; add a reviewed WebVTT
   file when timed text is available.
   `pnpm podcast:review` verifies the exact local machine drafts without
   writing. `pnpm podcast:review --write` creates one ignored, time-linked
   worksheet and refuses to overwrite it. Neither command changes publication
   state, review status, or signoff data.
4. Approve the show description, episode description, explicit-content values,
   publication date, immutable GUID, and cover artwork. The publication date
   is the UTC calendar date intended for the combined v1.0.0 production
   dispatch, encoded at midnight UTC immediately before the candidate is
   frozen. If the first successful deployment occurs on a later UTC date,
   update the date, freeze a new candidate, and repeat the affected metadata
   and presentation review; never backdate a failed release.
5. Export an opaque 3000 by 3000 RGB JPEG or PNG from the committed SVG source.
   Do not replace the SVG mark with generated artwork.
6. Reverify the single tracked MP3 at its permanent ASCII-only path. Never
   duplicate it or reuse that enclosure URL for different bytes.
7. Prepare and test the RSS 2.0 feed privately, but do not expose it or add
   feed-discovery metadata until the custom domain is established. The first
   public enclosure identity must not depend on the temporary host name.
   `scripts/podcast/feed.mjs` is the offline generator; it rejects temporary
   `github.io` origins and incomplete episodes and writes no public file.
8. Update the publication-asset allowlist and site verifier in the same release
   change so an accidental draft or unrelated binary still fails the build.
9. Test the deployed file over HTTPS with `HEAD`, initial/middle/suffix byte
   ranges, browser seeking, full-download hashing, cache validators, and the
   actual `Content-Type`. Validate the public feed in Apple Podcasts Connect
   before directory submission.
10. Perform keyboard, screen-reader, 320 CSS-pixel reflow, 200 percent text
    resize, and transcript review before enabling Podcast navigation in the
    combined v1.0.0 candidate.
11. Bind the final built routes and shared renderer to Tai Song's genuine
    `PresentationSignoffV2` for `v1.0.0`; the built podcast verifier checks its
    hashes and reviewed-commit ancestry without creating the record.

## Player and hosting policy

The episode page uses the browser's native `<audio controls>` element with
`preload="none"`, an adjacent transcript link, and a direct MP3 download.
There is no autoplay or custom player JavaScript.

GitHub Pages is suitable only for this low-traffic pilot after production proves
that `HEAD` and byte-range requests work. GitHub documents a 1 GB published-site
limit and a soft 100 GB monthly bandwidth limit, and Git LFS cannot serve Pages
sites. Reassess storage and delivery before Episode 2.

Primary references:

- [WHATWG HTML media](https://html.spec.whatwg.org/multipage/media.html)
- [W3C transcript guidance](https://www.w3.org/WAI/media/av/transcripts/)
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/)
- [RSS 2.0 specification](https://www.rssboard.org/rss-specification)
- [Apple podcast RSS requirements](https://podcasters.apple.com/support/823-podcast-requirements)
- [Apple audio requirements](https://podcasters.apple.com/support/893-audio-requirements)
- [Podcasting 2.0 transcript tag](https://podcasting2.org/docs/podcast-namespace/tags/transcript)
- [RFC 9110 range requests](https://www.rfc-editor.org/rfc/rfc9110.html)
- [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)
- [GitHub LFS limitations](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-git-large-file-storage)

## Local verification

Podcast boundary tests and the draft verifier run in normal CI. Complete
publication verification remains intentionally fail-closed until the reviewed
transcript, final audio quality decision, approved metadata, and content
signoff exist.

```powershell
pnpm test:future-content
pnpm podcast:review
pnpm podcast:verify
pnpm podcast:verify --require-complete
pnpm exec astro check
pnpm build
pnpm podcast:verify --require-complete --with-built
```

Pinned local tool archives and model hashes are recorded in
`scripts/podcast/toolchain.json`; those tools are not runtime or deployment
dependencies.

Passing checks confirm only that the draft stays unpublished and its recorded
source bytes remain unchanged. They do not approve the episode, create a human
transcript, clear rights, validate production delivery, or authorize directory
submission.
