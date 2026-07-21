import {
	assertPlainObject,
	assertSafeJsonNumbers,
	ContractError,
} from "./contract.js";

const SCRIPT_PATTERN = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu;

function getQuotedAttribute(attributes, name) {
	const pattern = new RegExp(
		`(?:^|[\\t\\n\\f\\r ])${name}[\\t\\n\\f\\r ]*=[\\t\\n\\f\\r ]*(?:"([^"]*)"|'([^']*)')`,
		"giu",
	);
	const values = [];
	for (const match of attributes.matchAll(pattern)) {
		values.push(match[1] ?? match[2]);
	}
	if (values.length > 1) {
		throw new ContractError(
			`script#__NEXT_DATA__ has duplicate ${name} attributes`,
		);
	}
	return values[0];
}

export function extractNextDataPost(html) {
	if (typeof html !== "string") {
		throw new ContractError("page.html must decode as UTF-8 text");
	}

	const candidates = [];
	for (const match of html.matchAll(SCRIPT_PATTERN)) {
		const attributes = match[1];
		if (getQuotedAttribute(attributes, "id") !== "__NEXT_DATA__") continue;
		const type = getQuotedAttribute(attributes, "type");
		if (type?.toLowerCase() !== "application/json") {
			throw new ContractError(
				'script#__NEXT_DATA__ must declare type="application/json"',
			);
		}
		candidates.push(match[2]);
	}

	if (candidates.length !== 1) {
		throw new ContractError(
			`Expected exactly one script#__NEXT_DATA__[type=application/json], found ${candidates.length}`,
		);
	}

	let nextData;
	try {
		nextData = JSON.parse(candidates[0]);
	} catch (error) {
		throw new ContractError("script#__NEXT_DATA__ contains invalid JSON", {
			cause: error,
		});
	}

	const root = assertPlainObject(nextData, "__NEXT_DATA__");
	const props = assertPlainObject(root.props, "__NEXT_DATA__.props");
	const pageProps = assertPlainObject(
		props.pageProps,
		"__NEXT_DATA__.props.pageProps",
	);
	const post = assertPlainObject(
		pageProps.post,
		"__NEXT_DATA__.props.pageProps.post",
	);
	assertSafeJsonNumbers(post);
	return post;
}

export function decodeUtf8(buffer, label = "page.html") {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
	} catch (error) {
		throw new ContractError(`${label} is not valid UTF-8`, { cause: error });
	}
}
