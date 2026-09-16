/**
 * Tokenisation and query expansion for the lexical retriever.
 *
 * The one real weakness of lexical search is vocabulary mismatch: a guest asks
 * about "swimming", the knowledge base says "pool". Embeddings solve that at the
 * cost of an API call per turn, non-deterministic tests and no offline mode.
 * For a knowledge base this size, a curated hospitality synonym set closes the
 * same gap for free -- and unlike an embedding model, it is inspectable and
 * every expansion can be justified in review.
 */

const STOPWORDS = new Set([
  'a', 'about', 'an', 'and', 'any', 'are', 'as', 'at', 'back', 'be', 'been', 'being', 'both', 'but',
  'by', 'can', 'could', 'did', 'do', 'does', 'each', 'even', 'for', 'from', 'get', 'give', 'go',
  'going', 'got', 'had', 'has', 'have', 'having', 'he', 'her', 'here', 'his', 'how', 'i', 'if', 'in',
  'into', 'is', 'it', 'its', 'just', 'know', 'like', 'make', 'many', 'may', 'me', 'might', 'more',
  'most', 'much', 'must', 'my', 'need', 'no', 'not', 'now', 'of', 'on', 'only', 'or', 'other', 'our',
  'out', 'over', 'own', 'please', 'same', 'say', 'shall', 'she', 'should', 'so', 'some', 'somewhere',
  'still', 'such', 'take', 'tell', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these',
  'they', 'this', 'to', 'too', 'under', 'up', 'us', 'very', 'want', 'was', 'we', 'were', 'what',
  'when', 'where', 'which', 'who', 'why', 'will', 'with', 'would', 'you', 'your', 'am',
]);

const NUMBER_WORDS: Record<string, string> = {
  one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8',
  nine: '9', ten: '10', couple: '2',
};

/**
 * Bidirectional concept clusters. Every token in a cluster expands to the whole
 * cluster, so the mapping never has to be written twice.
 *
 * Words are kept out of clusters when they carry two unrelated senses. "close"
 * is the cautionary example: grouping it with "nearby" made "what time does the
 * spa close" retrieve the list of nearby attractions.
 */
const SYNONYM_CLUSTERS: string[][] = [
  ['pool', 'swimming', 'swim', 'poolside'],
  ['gym', 'fitness', 'workout', 'exercise', 'treadmill'],
  ['spa', 'massage', 'therapy', 'wellness'],
  ['wifi', 'internet', 'network', 'online', 'connectivity'],
  ['breakfast', 'buffet', 'morning', 'brunch'],
  ['restaurant', 'dining', 'food', 'eat', 'meal', 'cuisine', 'dinner', 'lunch'],
  ['bar', 'drinks', 'alcohol', 'cocktail', 'beer', 'wine', 'pub'],
  ['cancellation', 'cancel', 'refund', 'refundable'],
  ['checkin', 'arrival', 'arrive'],
  ['checkout', 'departure', 'depart', 'vacate'],
  ['price', 'cost', 'rate', 'charge', 'fee', 'tariff', 'expensive', 'cheap'],
  ['tax', 'gst', 'vat'],
  ['airport', 'shuttle', 'transfer', 'pickup', 'flight'],
  ['metro', 'train', 'subway', 'station'],
  ['parking', 'park', 'valet', 'car', 'vehicle'],
  ['child', 'children', 'kid', 'kids', 'infant', 'baby', 'toddler'],
  ['pet', 'dog', 'cat', 'animal'],
  ['smoking', 'smoke', 'cigarette', 'vape'],
  ['accessible', 'wheelchair', 'disabled', 'accessibility', 'mobility', 'handicap'],
  ['laundry', 'wash', 'washing', 'dryclean', 'ironing', 'clothes'],
  ['luggage', 'baggage', 'bags', 'suitcase', 'storage'],
  ['doctor', 'medical', 'sick', 'ill', 'hospital', 'medicine'],
  ['tv', 'television'],
  ['ac', 'aircon', 'airconditioning', 'cooling'],
  ['room', 'rooms', 'accommodation', 'suite'],
  ['pay', 'payment', 'card', 'upi', 'cash'],
  ['nearby', 'near', 'around', 'attractions', 'sightseeing'],
  ['meeting', 'conference', 'boardroom', 'business'],
  ['event', 'party', 'celebration', 'wedding', 'banquet'],
  ['available', 'availability', 'vacancy', 'book', 'booking', 'reserve', 'reservation'],
  ['id', 'identification', 'passport', 'aadhaar', 'document'],
  ['quiet', 'noise', 'noisy', 'loud'],
  ['contact', 'phone', 'call', 'email', 'reach'],
];

const SYNONYMS: Map<string, string[]> = (() => {
  const map = new Map<string, string[]>();
  for (const cluster of SYNONYM_CLUSTERS) {
    for (const term of cluster) {
      map.set(term, cluster.filter((t) => t !== term));
    }
  }
  return map;
})();

/** Naive singularisation. Deliberately conservative: never touch short words or `ss`. */
function singularise(token: string): string {
  if (token.length <= 3) return token;
  if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith('ses') || token.endsWith('xes') || token.endsWith('ches') || token.endsWith('shes')) {
    return token.slice(0, -2);
  }
  if (token.endsWith('ss')) return token;
  if (token.endsWith('s')) return token.slice(0, -1);
  return token;
}

/**
 * Split text into raw word pieces, before stopwords are removed.
 *
 * Hyphenated words emit both the joined form and the parts, so "check-in" in the
 * knowledge base matches "checkin", "check in" and "check-in" from a guest.
 */
function rawWords(text: string): string[] {
  const normalised = text.toLowerCase().replace(/[‘’']/g, '');
  const matches = normalised.match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) ?? [];
  const out: string[] = [];
  for (const match of matches) {
    if (match.includes('-')) out.push(match.replace(/-/g, ''), ...match.split('-'));
    else out.push(match);
  }
  return out;
}

function normaliseToken(word: string): string[] {
  const out: string[] = [];
  const numeric = NUMBER_WORDS[word];
  if (numeric) out.push(numeric);
  out.push(singularise(word));
  return out;
}

/** Index terms for a document, or the literal content terms of a query. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const word of rawWords(text)) {
    if (STOPWORDS.has(word)) continue;
    out.push(...normaliseToken(word));
  }
  return out;
}

/**
 * Query-side tokens, including adjacent word pairs joined together.
 *
 * Guests split compound words that the knowledge base writes as one: "work out"
 * for workout, "check out" for checkout, "wi fi" for wifi. Forming bigrams
 * before stopwords are removed recovers those -- "check out" survives even
 * though "out" is a stopword on its own. A joined pair that means nothing simply
 * scores zero, so this is cheap insurance rather than a source of noise.
 */
export function queryTokens(text: string): string[] {
  const words = rawWords(text);
  const out = new Set(tokenize(text));
  for (let i = 0; i < words.length - 1; i += 1) {
    const joined = `${words[i]}${words[i + 1]}`;
    if (joined.length <= 24) out.add(singularise(joined));
  }
  return [...out];
}

/**
 * Query-side expansion. Applied to the guest question only, never to documents:
 * expanding both sides would blur every fact into every other one.
 */
export function expandQuery(tokens: string[]): string[] {
  const expanded = new Set(tokens);
  for (const token of tokens) {
    for (const synonym of SYNONYMS.get(token) ?? []) {
      for (const t of tokenize(synonym)) expanded.add(t);
    }
  }
  return [...expanded];
}
