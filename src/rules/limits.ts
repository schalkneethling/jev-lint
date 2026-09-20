/**
 * How much of a candidate's text reaches the model. Jev allows 64k tokens per request and 32k for the
 * state, so none of these is near a hard limit: each is a judgement about where more words stop helping.
 * They live here, read at `select` time, so `scripts/truncation-experiment.ts` can vary one and re-select
 * in the same process without a forked copy of the rule. Nothing else writes them, so a normal run is
 * exactly what these defaults say.
 */
export const limits = {
  /**
   * Characters of code sent with the name, title, or comment it is judged against (`rules/code/shared.ts`).
   * The old 1,500 hid the defect `function-name-matches-body` exists to find: on five long functions whose
   * surprising side effect came after character 1,500, recall was 0/5 at 1,500 and 5/5 at 6,000, with the
   * mean on bad cases at 0.12 against 0.90 and no false positive on five matched clean functions. Long test
   * bodies moved the same way (mean 0.34 to 0.85). 6,000 covers every function measured in this repo (longest
   * 5,785) and in a real TypeScript project, and costs 4% more input tokens on this repo's own source.
   */
  codeChars: 6000,
  /**
   * Words of the content under a heading (`heading-describes-section`). 7% of the corpus's 1,287 headings
   * carry more than 80 words. Where a section opens with a quote, a byline, or "in this section we will
   * look at", the topic only appears after word 80: recall on those was 0/3 at 80 words, 1/3 at 160 and 3/3
   * at 240, with no false positive on matched sections at any value. Unbounded is worse than 240, not better:
   * it dropped a real mismatch from 0.86 to 0.71. On 654 real corpus headings, 240 reports nothing new and
   * two fewer borderline reviews, against one flip in the control run.
   */
  headingSectionWords: 240,
  /**
   * List items named when the content under a heading is a list (`heading-describes-section`). 25% of corpus
   * headings are summarised as a list and half of those lists hold more than five items, but naming 20 of
   * them, or all of them, moved two of 572 candidates where the control moved two: no measured effect.
   */
  headingListItems: 5,
  /**
   * Words of the text inside an `aria-hidden` element (`aria-hidden-hides-content`). It bites often, on 17%
   * of 412 corpus candidates, and changes nothing: mean p moved from 0.445 to 0.453 between 40 words and no
   * limit, and the status changes (14 in the control, 27 to 38 at wider values) are this rule's candidates
   * sitting on the 0.4 review threshold, in both directions at once.
   */
  hiddenTextWords: 40,
  /** Words of a live region's message (`alert-is-urgent`). Never truncated a corpus candidate: the longest was 36 words. */
  alertMessageWords: 40,
  /** Words of the text an `aria-describedby` points at (`describedby-describes`). Never truncated a corpus candidate; the longest was 38 words. */
  fieldDescriptionWords: 40,
  /**
   * Words of the page's own paragraphs, compared with its meta description (`description-matches-page`).
   * Truncates 11 of 12 corpus candidates and is still the right size: from 60 words to the whole page not one
   * candidate changed status and the mean moved 0.012. Whether a description is about another subject is
   * settled by the first paragraph.
   */
  pageContentWords: 60,
};

export type LimitName = keyof typeof limits;

/**
 * Runs `body` with one limit replaced, then restores it. `Infinity` means no truncation at all.
 * Only the experiment uses this; it is not concurrency-safe and is not meant to be.
 */
export async function withLimit<T>(name: LimitName, value: number, body: () => Promise<T>): Promise<T> {
  const previous = limits[name];
  limits[name] = value;
  try {
    return await body();
  } finally {
    limits[name] = previous;
  }
}
