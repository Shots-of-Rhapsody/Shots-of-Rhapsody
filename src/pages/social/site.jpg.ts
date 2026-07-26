import path from "node:path";
import type { APIRoute } from "astro";
import sharp from "sharp";
import { SOCIAL_IMAGE_QUALITY } from "../../utils/image-policy";

const WIDTH = 1200;
const HEIGHT = 630;
const repositoryRoot = process.cwd();
const markPath = path.resolve(repositoryRoot, "public", "mark.svg");
const fontPath = path.resolve(
	repositoryRoot,
	"node_modules",
	"@fontsource-variable",
	"noto-serif",
	"files",
	"noto-serif-latin-wght-normal.woff2",
);

async function textLayer(
	text: string,
	width: number,
	height: number,
	color: string,
) {
	return sharp({
		text: {
			text: `<span foreground="${color}" font_weight="650">${text}</span>`,
			font: "Noto Serif",
			fontfile: fontPath,
			width,
			height,
			align: "left",
			rgba: true,
		},
	})
		.png()
		.toBuffer();
}

export const GET: APIRoute = async () => {
	const [mark, title, subtitle, rule] = await Promise.all([
		sharp(markPath).resize(176, 176).png().toBuffer(),
		textLayer("Shots of Rhapsody", 720, 96, "#20231f"),
		textLayer(
			"Stories, poems, and reflections by Tai Song",
			720,
			44,
			"#5d5c52",
		),
		sharp({
			create: {
				width: 1000,
				height: 2,
				channels: 4,
				background: "#315f57",
			},
		})
			.png()
			.toBuffer(),
	]);

	const jpeg = await sharp({
		create: {
			width: WIDTH,
			height: HEIGHT,
			channels: 4,
			background: "#f5efdf",
		},
	})
		.composite([
			{ input: rule, left: 100, top: 78 },
			{ input: rule, left: 100, top: 550 },
			{ input: mark, left: 108, top: 227 },
			{ input: title, left: 344, top: 213 },
			{ input: subtitle, left: 344, top: 330 },
		])
		.jpeg({ quality: SOCIAL_IMAGE_QUALITY, mozjpeg: true })
		.toBuffer();

	return new Response(new Uint8Array(jpeg), {
		headers: {
			"Cache-Control": "public, max-age=31536000, immutable",
			"Content-Length": String(jpeg.byteLength),
			"Content-Type": "image/jpeg",
		},
	});
};
