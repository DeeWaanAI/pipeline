/**
 * Smart Compression Layer — Episodic Memory Manager (Standard Tier)
 *
 * Keyword-based retrieval (no embeddings, no vector DB).
 * Fast (<10ms), offline-capable, good enough for 80% of cases.
 * Pro Designer tier will upgrade to sentence-transformers embeddings.
 */

export interface Episode {
  id: string;
  promptKeywords: string[];
  summary: string;
  timestamp: string;
}

// English stop words + common Chinese particles
const STOP_WORDS = new Set([
  // English
  "the","a","an","is","are","was","were","be","been","being","have","has","had",
  "do","does","did","will","would","could","should","may","might","must","shall",
  "can","need","to","of","in","for","on","with","at","by","from","as","into",
  "through","during","before","after","above","below","between","out","off","over",
  "under","again","further","then","once","here","there","when","where","why","how",
  "all","each","few","more","most","other","some","such","no","nor","not","only",
  "own","same","so","than","too","very","just","and","but","if","or","because",
  "until","while","this","that","these","those","it","its","what","which","who",
  "whom","whose","me","my","mine","you","your","yours","he","him","his","she",
  "her","hers","we","us","our","ours","they","them","their","theirs","i",
  // Chinese
  "的","了","在","是","我","有","和","就","不","人","都","一","一个","上","也",
  "很","到","说","要","去","你","会","着","没有","看","好","自己","这","那",
  "吗","吧","呢","啊","哦","嗯","对","让","还","可以","给","把","被","从",
  "与","及","而","或","但","因为","所以","如果","虽然","而且","然后","之",
  "关于","对于","根据","通过","随着","由于","为了","除了","经过","向","往",
  "用","以","为","比","跟","同","让","叫","管","连","任","每","各","该",
  "此","本","们","地","得","着","过","吗","吧","呢","啊","哦","嗯","哈",
]);

function extractKeywords(text: string): string[] {
  const cleaned = text
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff\s]/g, " ") // Keep English words + Chinese chars
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));

  // Deduplicate
  return [...new Set(cleaned)];
}

function countMatches(queryWords: string[], episodeWords: string[]): number {
  return queryWords.filter((w) => episodeWords.includes(w)).length;
}

/**
 * Retrieve up to `maxResults` episodes relevant to the current query.
 * Sorted by keyword overlap score, then recency.
 */
export function retrieveEpisodes(
  currentQuery: string,
  episodes: Episode[],
  maxResults = 2
): Episode[] {
  const queryWords = extractKeywords(currentQuery);
  if (queryWords.length === 0 || episodes.length === 0) return [];

  return episodes
    .map((ep) => ({
      ep,
      score: countMatches(queryWords, ep.promptKeywords),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.ep.timestamp.localeCompare(a.ep.timestamp))
    .slice(0, maxResults)
    .map(({ ep }) => ep);
}

/**
 * Create a new episode from the completed prompt + polisher output.
 */
export function createEpisode(
  prompt: string,
  polisherOutput: string,
  existingEpisodes: Episode[]
): Episode {
  return {
    id: `ep-${Date.now()}-${existingEpisodes.length}`,
    promptKeywords: extractKeywords(prompt),
    summary: `Q: ${prompt.substring(0, 120)} | A: ${polisherOutput.substring(0, 200)}`,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Keep only the newest `maxEntries` episodes.
 */
export function rotateEpisodes(
  episodes: Episode[],
  maxEntries = 50
): Episode[] {
  if (episodes.length <= maxEntries) return episodes;
  return episodes
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, maxEntries);
}

/**
 * Serialize episodes array to JSON string for Gitee storage.
 */
export function serializeEpisodes(episodes: Episode[]): string {
  return JSON.stringify(episodes, null, 2);
}

/**
 * Parse episodes from JSON string.
 */
export function parseEpisodes(json: string): Episode[] {
  try {
    const parsed = JSON.parse(json) as Episode[];
    if (Array.isArray(parsed)) return parsed;
  } catch { /* ignore */ }
  return [];
}
