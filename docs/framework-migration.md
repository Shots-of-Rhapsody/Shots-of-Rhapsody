# Astro 7 and Tailwind CSS 4 migration record

This repository targets Node.js 24 LTS and pnpm 11.16.0. The framework
baseline is Astro 7.1.3, Svelte 5.56.7, Tailwind CSS 4.3.3, Biome 2.5.5, and
TypeScript 5.9.3. Exact versions that define the supported migration baseline
are pinned in `package.json`; the lockfile is generated only with the declared
pnpm release.

The migration follows Astro's official
[version 6](https://docs.astro.build/en/guides/upgrade-to/v6/) and
[version 7](https://docs.astro.build/en/guides/upgrade-to/v7/) upgrade guides,
plus Tailwind's official [version 4 upgrade
guide](https://tailwindcss.com/docs/upgrade-guide). Collections use Astro's
Content Layer `glob()` loader. Directory `index.md` entries keep the directory
route, ordinary files keep their path-derived route, and an explicit source
slug wins. The migration test scans the complete 15-file post inventory and
fails if two files resolve to the same route ID or any of the 11 manifest
routes disappears.

The unified Markdown processor remains explicit so GFM, SmartyPants, and the
existing remark/rehype plugins do not inherit changed framework defaults.
`compressHTML` also remains explicit. To compare a pre-migration build with a
candidate build, retain the baseline `dist` directory and run:

```sh
pnpm verify:semantic -- <baseline-dist> dist
```

The comparator checks route equality and normalized document structure while
excluding opaque Astro hydration IDs, generated asset hashes, CSS classes,
inline styles, and runtime scripts. Browser and accessibility verification is
therefore still required for visual and interaction behavior.

## Security substitutions and temporary overrides

The selected direct releases include security-patched `@swup/astro`, `sharp`,
`markdown-it`, and `sanitize-html` versions. Unused `@rollup/plugin-yaml` was
removed. The pnpm build-script policy allows only required native/tool builds
and denies Swup's nonessential donation script.

Two exact transitive overrides in `pnpm-workspace.yaml` currently remove known
advisories from stale parent ranges:

- `picomatch@2.3.1` to `2.3.2`;
- `serialize-javascript@4.0.0` to `7.0.5`, used only by Swup's historical
  Microbundle build chain.

These overrides are not permanent API contracts. Remove each one after its
owning dependency selects a patched range, but only after the full audit,
build, semantic comparison, and browser suite pass without it. Pagefind is
held at 1.4.0 because the committed release verifier validates that reviewed
fragment format; a Pagefind upgrade requires a separate verifier fixture and
regression review.
