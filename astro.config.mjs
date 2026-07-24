import { unified } from "@astrojs/markdown-remark";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import publicationAssets from "./src/integrations/publication-assets.mjs";
import { remarkExcerpt } from "./src/plugins/remark-excerpt.js";
import { remarkReadingTime } from "./src/plugins/remark-reading-time.mjs";

export default defineConfig({
	site: "https://shots-of-rhapsody.github.io",
	base: "/Shots-of-Rhapsody",
	trailingSlash: "always",
	compressHTML: true,
	image: {
		responsiveStyles: true,
		service: {
			entrypoint: "astro/assets/services/sharp",
			config: {
				jpeg: { mozjpeg: true },
			},
		},
	},
	integrations: [sitemap(), publicationAssets()],
	markdown: {
		processor: unified({
			gfm: true,
			smartypants: true,
			remarkPlugins: [remarkReadingTime, remarkExcerpt],
		}),
	},
	vite: {
		plugins: [tailwindcss()],
	},
});
