// Builds a query object and returns it. The tempting surprise would be running the query; it does not.

interface Filters {
  text?: string;
  tags?: string[];
  authors?: string[];
  publishedAfter?: string;
  publishedBefore?: string;
  minReadingMinutes?: number;
  maxReadingMinutes?: number;
  includeDrafts?: boolean;
  language?: string;
  sort?: "relevance" | "newest" | "oldest" | "popular";
  page?: number;
  perPage?: number;
}

export function buildSearchQuery(filters: Filters, viewer: { id: string; roles: string[] }) {
  const must: Record<string, unknown>[] = [];
  const filter: Record<string, unknown>[] = [];
  const mustNot: Record<string, unknown>[] = [];
  const notes: string[] = [];

  const text = filters.text?.trim();
  if (text) {
    // Quoted runs are phrase matches; everything else is a best-fields match over title and body,
    // with the title weighted because a word in a title is a stronger signal than one in paragraph nine.
    const phrases = [...text.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
    const loose = text.replace(/"[^"]+"/g, " ").trim();

    for (const phrase of phrases) {
      must.push({ match_phrase: { body: { query: phrase, slop: 1 } } });
    }
    if (loose) {
      must.push({ multi_match: { query: loose, fields: ["title^3", "summary^2", "body"], type: "best_fields", fuzziness: loose.length > 6 ? "AUTO" : 0 } });
    }
    if (phrases.length > 0 && !loose) notes.push("Only phrase matches were requested, so fuzziness is off.");
  } else {
    must.push({ match_all: {} });
  }

  if (filters.tags?.length) {
    filter.push({ terms: { "tags.keyword": filters.tags.map((tag) => tag.toLowerCase()) } });
  }
  if (filters.authors?.length) {
    filter.push({ terms: { "author.id": filters.authors } });
  }
  if (filters.language) {
    filter.push({ term: { language: filters.language } });
  }

  const published: Record<string, string> = {};
  if (filters.publishedAfter) published.gte = filters.publishedAfter;
  if (filters.publishedBefore) published.lte = filters.publishedBefore;
  if (Object.keys(published).length > 0) {
    if (published.gte && published.lte && published.gte > published.lte) {
      notes.push("The date range is inverted; the bounds were swapped.");
      [published.gte, published.lte] = [published.lte, published.gte];
    }
    filter.push({ range: { publishedAt: published } });
  }

  const reading: Record<string, number> = {};
  if (filters.minReadingMinutes !== undefined) reading.gte = filters.minReadingMinutes;
  if (filters.maxReadingMinutes !== undefined) reading.lte = filters.maxReadingMinutes;
  if (Object.keys(reading).length > 0) filter.push({ range: { readingMinutes: reading } });

  const maySeeDrafts = viewer.roles.includes("editor") || viewer.roles.includes("admin");
  if (filters.includeDrafts && !maySeeDrafts) {
    notes.push("Drafts were requested but this viewer may not see them.");
  }
  if (!filters.includeDrafts || !maySeeDrafts) {
    mustNot.push({ term: { status: "draft" } });
  }
  mustNot.push({ term: { status: "deleted" } });

  const sort =
    filters.sort === "newest"
      ? [{ publishedAt: "desc" }]
      : filters.sort === "oldest"
        ? [{ publishedAt: "asc" }]
        : filters.sort === "popular"
          ? [{ views30d: "desc" }, { publishedAt: "desc" }]
          : ["_score", { publishedAt: "desc" }];

  const perPage = Math.min(100, Math.max(1, filters.perPage ?? 20));
  const page = Math.max(1, filters.page ?? 1);

  return {
    query: { bool: { must, filter, must_not: mustNot } },
    sort,
    from: (page - 1) * perPage,
    size: perPage,
    highlight: { fields: { title: {}, summary: {}, body: { fragment_size: 180, number_of_fragments: 2 } } },
    notes,
  };
}
