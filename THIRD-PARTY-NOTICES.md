# Third-party notices

This file records known third-party material and provenance boundaries. It does not replace the license text supplied by any project or package.

## Fuwari

The site is derived from [saicaca/fuwari](https://github.com/saicaca/fuwari), which is distributed under the MIT License. The pinned lineage and review procedure are recorded in [docs/upstream-sync.md](docs/upstream-sync.md). The repository root [MIT License](LICENSE) is retained for the code.

## Fonts

- **Roboto** is distributed through `@fontsource/roboto` under the SIL Open Font License 1.1. Its package includes the license and upstream copyright notice.
- **JetBrains Mono** is distributed through `@fontsource-variable/jetbrains-mono` under the SIL Open Font License 1.1. Its package includes the license and upstream copyright notice.

## Icon data

- The Font Awesome 6 icon-set packages used through Iconify (`@iconify-json/fa6-brands`, `fa6-regular`, and `fa6-solid`) identify the icon data license as CC BY 4.0.
- `@iconify-json/material-symbols` identifies the Material Symbols icon data license as Apache 2.0.

Package versions are pinned in `pnpm-lock.yaml`; consult each installed package and upstream project for its complete terms and attribution requirements.

## Draft guide cover

`src/content/posts/guide/cover.jpeg` is referenced only by the unpublished Fuwari guide draft. The draft records its external [Civitai image source](https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/208fc754-890d-4adb-9753-2c963332675d/width=2048/01651-1456859105-(colour_1.5),girl,_Blue,yellow,green,cyan,purple,red,pink,_best,8k,UHD,masterpiece,male%20focus,%201boy,gloves,%20ponytail,%20long%20hair,.jpeg). It is excluded from the production site and is not offered for reuse by this repository.

## Project imagery with separate provenance

Files under `src/assets/images/` and `public/favicon/` are project media, not MIT-licensed code. Earlier repository attribution records referenced Unsplash, the Pixiv work “星と少女” by Stella, and an Artaius Midjourney showcase without preserving a reliable file-by-file mapping. Until that mapping is reviewed, these files must not be treated as reusable third-party assets or as covered by the root MIT License.

## Unpublished legacy podcast bundle

The byte-preserved files under `legacy/podcast/` are retained for repository history and are excluded from the built site. No file-specific license or complete media provenance is asserted here. Their presence does not grant permission to publish or reuse the audio, artwork, player, or metadata.

## Tai Song archive

The eleven manifest-controlled article texts and original hero images are not third-party template assets. Their separate All Rights Reserved status is documented in [CONTENT-LICENSE.md](CONTENT-LICENSE.md).
