export {};

declare global {
	interface Window {
		pagefind?: {
			search: (query: string) => Promise<{
				results: Array<{ data: () => Promise<SearchResult> }>;
			}>;
			options: (options: Record<string, unknown>) => Promise<void>;
		};
	}
}

interface SearchResult {
	url: string;
	meta: { title: string };
	excerpt: string;
}
