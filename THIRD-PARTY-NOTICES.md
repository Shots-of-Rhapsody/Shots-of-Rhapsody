# Third-party notices

This file records known third-party material and provenance boundaries. It does not replace the license text supplied by any project or package.

## Fuwari

The site is derived from [saicaca/fuwari](https://github.com/saicaca/fuwari), which is distributed under the MIT License. The pinned lineage and review procedure are recorded in [docs/upstream-sync.md](docs/upstream-sync.md). The repository root [MIT License](LICENSE) is retained for the code.

## Fonts

- **Noto Serif** is distributed through the pinned
  `@fontsource-variable/noto-serif` package under the SIL Open Font License
  1.1. Only its Latin variable normal and italic files are built into the
  site. The package contains the complete license and upstream copyright
  notice.

The interface uses small project-authored inline SVG controls rather than an
external icon library. Package versions are pinned in `pnpm-lock.yaml`; consult
each installed package and upstream project for its complete terms and
attribution requirements.

## Draft guide cover

`src/content/posts/guide/cover.jpeg` is referenced only by the unpublished Fuwari guide draft. The draft records its external [Civitai image source](https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/208fc754-890d-4adb-9753-2c963332675d/width=2048/01651-1456859105-(colour_1.5),girl,_Blue,yellow,green,cyan,purple,red,pink,_best,8k,UHD,masterpiece,male%20focus,%201boy,gloves,%20ponytail,%20long%20hair,.jpeg). It is excluded from the production site and is not offered for reuse by this repository.

## Project branding and imagery with separate provenance

The `SR` vector mark in `public/mark.svg` is project branding and is not
offered for reuse under the code license. Legacy files under
`src/assets/images/` and the earlier raster favicon set are project media, not
MIT-licensed code. Earlier repository
attribution records referenced Unsplash, the Pixiv work “星と少女” by Stella,
and an Artaius Midjourney showcase without preserving a reliable file-by-file
mapping. These legacy files are excluded from the public artifact; their
presence in repository history does not grant permission to reuse them.

## Historical podcast player

The player files under `legacy/podcast/` are retained for repository history and excluded from the built site. They are not used to render or play the approved first-party episode. Their presence does not grant permission to reuse the player or its historical metadata.

## Tai Song archive

The eleven manifest-controlled article texts and original hero images are not third-party template assets. Their separate All Rights Reserved status is documented in [CONTENT-LICENSE.md](CONTENT-LICENSE.md).

The 24 nonfiction essays, their verified local heroes, the podcast recording, project-owned artwork, and reviewed transcript are likewise first-party creative material rather than third-party template assets. Their separate All Rights Reserved status is documented in [CONTENT-LICENSE.md](CONTENT-LICENSE.md).
