import { safeFetchPage, ResearchError } from './safeFetch.js';
import { extractPage } from './extract.js';
import { generateSuggestions, activeProvider } from './generate.js';

export { ResearchError };

/** Fetch -> extract -> generate. Page text is used for this request only and is never stored. */
export async function analyzeUrl(url, count, { fetcher = safeFetchPage, provider } = {}) {
  const fetched = await fetcher(url);
  const page = extractPage(fetched.text);
  if (!page.title && !page.headings.length && page.text.length < 80) {
    throw new ResearchError('empty_content', 'That page has too little readable text to analyse. It may be built with scripts that require a browser.');
  }
  const prov = provider || activeProvider();
  const { suggestions, provider: used } = await generateSuggestions(page, count, prov);
  if (!suggestions.length) throw new ResearchError('empty_content', 'Not enough distinct topics were found on that page to build suggestions.');
  const ai = used !== 'template';
  return {
    source: { url: fetched.url, final_url: fetched.finalUrl, title: page.title, analyzed_at: new Date().toISOString(), truncated: fetched.truncated },
    mode: ai ? 'ai' : 'template',
    provider: used,
    requested: count,
    suggestions,
    notes: [
      ...(suggestions.length < count ? [`Only ${suggestions.length} distinct topic${suggestions.length === 1 ? '' : 's'} could be found on that page, so ${suggestions.length} suggestion${suggestions.length === 1 ? ' is' : 's are'} shown.`] : []),
      ai ? 'Written by an AI model from the page content. Check every claim before you publish.'
        : 'No AI service is configured, so these suggestions are built from the page’s own headings and keywords. They are a starting point, not finished copy.',
      'Keywords are suggestions based on the page text. No search-volume, ranking or competition data is used.',
    ],
    page_keywords: page.keywords.slice(0, 12),
  };
}
