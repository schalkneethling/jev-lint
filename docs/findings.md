# Findings

Spike run on 2026-09-19 against `jev-1.13.0`. All numbers come from `pnpm eval`,
`scripts/chunk-experiment.ts`, `scripts/probe-css-js.ts`, and linting three real pages.

## Summary

Semantic linting with Jev works, and it is cheap enough to run on every commit. The shape that works is
narrow: **code extracts one small candidate, Jev makes one judgement about it, code decides what to report.**
The one serious trap is batching many candidates into a single state.

## 1. Isolate every candidate

The first design put all of a rule's candidates for a file into one state (`{ candidates: [...] }`) and
pointed each question at `candidates[i]`. It passed the fixtures and failed on a real page. On the Hacker
News front page (198 links) every answer collapsed to p ≈ 0.55, for "More" and for a full story title alike.

`scripts/chunk-experiment.ts` measures drift from the one-candidate-per-request baseline on that page:

| Candidates per state | Requests | Input tokens | Mean \|Δp\| | Reported/not-reported flips |
| -------------------- | -------- | ------------ | ----------- | --------------------------- |
| 1 (baseline)         | 153      | 67,158       | 0           | 0 / 198                     |
| 2                    | 86       | 53,760       | 0.050       | 6 / 198                     |
| 4                    | 49       | 48,169       | 0.072       | 12 / 198                    |
| 8                    | 25       | 42,139       | 0.110       | 19 / 198                    |
| 16                   | 12       | 37,695       | 0.183       | 36 / 198                    |
| 32                   | 6        | 36,159       | 0.266       | 71 / 198                    |
| 64                   | 3        | 35,391       | 0.327       | 103 / 198                   |

Drift rises with every doubling, and batching saves at most about half the tokens. A request costs roughly
260 tokens of overhead plus 180 per question (instructions and criteria); the candidate itself is tiny. This matches two
entries on TypeSafe's jaggedness page: indirection, and large state full of irrelevant detail.

Decision: `--isolation candidate` is the default. Identical candidates are sent once per run and answers are
cached on disk per (model, state, question), which removes most of the request overhead on real pages.

The fixtures did not catch this because each fixture file holds fewer than ten candidates. Small fixtures
measure prompt quality. They say nothing about behaviour at page scale.

## 2. Fixture results

`pnpm eval --isolation candidate`, default thresholds unless the rule overrides them. `alt-text-quality` and
`aria-label-justified` are the decomposed versions described in §7:

| Rule                        | Recall | False positives | Mean p (bad) | Mean p (good) |
| --------------------------- | ------ | --------------- | ------------ | ------------- |
| `alt-text-quality`          | 7/7    | 0/5             | 0.93         | 0.03          |
| `aria-label-justified`      | 8/8    | 0/7             | 0.98         | 0.06          |
| `class-implies-element`     | 8/8    | 0/10            | 0.99         | 0.00          |
| `control-type-intent`       | 7/7    | 0/7             | 1.00         | 0.05          |
| `heading-describes-section` | 3/3    | 0/4             | 0.93         | 0.05          |
| `label-input-type`          | 8/8    | 0/9             | 0.98         | 0.00          |
| `link-text-purpose`         | 8/8    | 0/9             | 0.96         | 0.17          |

Under `rule` and `file` isolation the same fixtures produced one `review`-level false positive each.

Read these as "the prompts are sound", not as accuracy figures. The same author wrote the fixtures and the
prompts, and 100 candidates is a small sample. The wide gap between the two means is the useful signal: the
answers are rarely near 0.5, so thresholds are not fragile.

## 3. Real pages

| Page                       | Questions | Requests | Input tokens | Cost    | Reported                     |
| -------------------------- | --------- | -------- | ------------ | ------- | ---------------------------- |
| schalkneethling.com (home) | 46        | 46       | 21,899       | $0.0009 | 2 warn, 2 review             |
| A CSS framework's checkout example | 46        | 46       | 24,933       | $0.0011 | 1 error, 1 warn or review    |
| A link aggregator's front page | 465       | 371      | 174,166      | $0.0073 | 73 error, 61 warn, 21 review |

All six rules, cold cache. On the link aggregator, 94 of 465 questions were duplicates answered once.

The link aggregator findings are mostly defensible: "hide", "More", bare timestamps, and bare domains as link
text. Story titles pass.

False positives and what they teach:

- **`label-input-type`: "Expiration" → `type="date"` (p = 0.93).** A card expiry is not a calendar date.
  Literal reading. The fix belongs in the criteria: exclude card expiry from `date`, as postal codes are
  already excluded from `number`.
- **`heading-describes-section`: "Billing address" (p = 0.72).** The content under it is form labels
  ("First name", "Last name"), which read as unrelated prose. The rule should skip sections that are mostly
  form controls, which code can detect.
- **`link-text-purpose` on short navigation labels.** "Get in touch" and "Support" score 0.5 to 0.65. Generic
  text scores above 0.7. The rule now uses stricter thresholds (0.9 / 0.75 / 0.65).
- **`control-type-intent`: "Compare the new plans" (p = 0.59, review).** Found by running every rule over
  another rule's fixtures. Imperative link text reads as an action. Cross-running fixtures is a cheap source
  of negative cases.
- **`class-implies-element` on `.footer-content` inside a real `<footer>`.** The model only sees names. Code
  now records semantic ancestors and descendants and suppresses the finding when the element already exists.

The last one is the general pattern: when a false positive can be explained by a fact the parser already
has, handle it in code instead of adding words to the prompt.

## 4. CSS and JS probes

`scripts/probe-css-js.ts`, 31 hand-written cases, one isolated noul each:

| Idea                                                | Right side of 0.5 | Notes                                     |
| --------------------------------------------------- | ----------------- | ----------------------------------------- |
| CSS class name vs declarations                      | 6/6               | bad ≤ 0.06, good ≥ 0.94                   |
| `.visually-hidden` stays available to screen readers | 3/3               | correct clip pattern only 0.78            |
| Custom property name vs value kind                  | 4/4               |                                           |
| Comment contradicts code (CSS and JS)               | 5/5               | one subtle CSS mismatch at 0.45           |
| Function name vs body                               | 5/5               | side effects in `get*` / `is*` ≤ 0.06     |
| User-facing error message is actionable             | 5/5               |                                           |
| Test title vs assertions                            | 3/3               |                                           |

All seven are worth building. "Retry up to 3 times" above a loop to 5 scored 0.03, better than the
jaggedness page suggests for numbers, but one case proves nothing. Numeric comparisons stay in code.

### ARIA

`scripts/probe-aria.ts`, 28 cases. The probe tests whether ARIA is true, not whether it is valid. Validity is
a spec lookup that axe and html-validate already do exactly.

The first version of the probe asked whether an `aria-label` agrees with the visible text. That framing was
wrong twice over. An `aria-label` on a control with visible text is only justified when it disambiguates
otherwise identical controls, and whether the label contains the visible text (WCAG 2.5.3) is string
containment, not a judgement. The rule became `aria-label-justified`: two checks in code, the existing
`link-text-purpose` judgement, and one new question (does the label add the specific subject), which scored
8/8 with every answer at or beyond 0.05 and 0.97.

The general lesson: before writing a question, ask which parts of it are a lookup or a string comparison.
Here that removed most of the model's work and made the rest sharper.

The one borderline case is an `aria-describedby` hint that is plausible for many fields ("We'll only use
this to send your receipt" on a password field). Across three runs it scored 0.53, just under 0.5, and 0.50: a coin flip, and a live example of the run-to-run variance in §6. See
the ARIA section of the [rule catalog](rule-catalog.md).

## 5. Cost and speed

- About 450 to 550 input tokens per question; output is free. A typical page costs about $0.001, and a
  link-heavy page under $0.01.
- An unchanged file costs nothing on the next run because of the answer cache. In CI, persist
  `.jev-lint-cache/` between runs and only changed candidates are sent.
- The schalkneethling.com home page (46 requests, 8 concurrent) took 8.8 s cold and 2.2 s cached. About 2 s
  of both is Varlock resolving the key from 1Password. The 1,200 requests/minute limit is the ceiling for a
  cold run over a large site.

## 6. Run-to-run variance

Asking the identical question three times without the cache gave p = 0.70, 0.73, and 0.71. Judgements near a
threshold can change severity between cold runs. The answer cache makes a repeated run stable. Thresholds
should sit in the gap between the good and bad distributions, not at the edge of either.

## 7. Atomic questions, composed in code

TypeSafe's [introduction](https://docs.typesafe.ai/introduction#atomic-questions-composed-in-code) says each
question should be a gut-check a knowledgeable person makes in seconds, and that anything weighing several
independent factors should be decomposed and combined in code. Auditing the spike against that found two
problems, both fixed.

**The engine allowed one question per candidate.** A rule now returns a map of questions. They share one
request and one state, cannot see each other's answers, and arrive in `assess` by name. A candidate can also
be `decided` in `select`, in which case it is reported and nothing is asked.

**`alt-text-quality` weighed three independent factors in one Choice.** An alt text can announce "image of"
and repeat the caption at once, and a Choice can only pick one. Decomposed:

| Factor | Before (one Choice) | After |
| --- | --- | --- |
| Opens with "Photo of", "Image of" | p = 0.66, warn | regex in code, p = 1.00, no tokens |
| Repeats the caption | p = 0.93 | own Noul, p = 0.98 |
| File name or placeholder: "IMG_4021.jpg", "image", "screenshot" | p = 0.99 to 1.00 | own Noul, p = 0.97 |
| Placeholder: "hero banner final v2" | p = 0.96 | own Noul, p = 0.63, warn |

Three of four improved or held. The last got worse: inside the Choice, "describes the image" was a competing
option that this text clearly lost to, while an absolute Noul finds "hero banner final v2" only moderately
file-like. This is the Choice-is-relative, Noul-is-absolute distinction from the jaggedness page, met in
practice. Decomposing is right, and each atomic question still needs its own tuning.

**`aria-label-justified` is the first rule built this way**, from two string checks in code and two Nouls:

```
contains visible text?   code   no → error, WCAG 2.5.3, nothing asked
visible text repeated?   code   yes → ambiguous = 1
visible text specific?   Jev    (shared with link-text-purpose) → ambiguous = 1 − noul
label adds the subject?  Jev

p = (1 − ambiguous) + ambiguous × (1 − adds_subject)
     unnecessary       justified but unhelpful
```

8/8 recall and 0/7 false positives on its fixtures. Four of the eight bad cases never reached the model.
The message follows whichever term is larger, so the finding says whether to remove the label or improve it.
Policy lives in that one line of arithmetic and can change without touching a prompt or spending a token,
because the cached answers stay valid.

New false positive from these fixtures: `control-type-intent` reports "Edit shipping address" (p = 0.79) on
a link that goes to an edit page. The label alone cannot separate "go to the edit page" from "edit in
place". Several rules also report the same element ("Click to read more" gets three findings), so grouping
findings per element is worth doing.

## 8. JavaScript and TypeScript, and the first run on real code

Decisions from the design doc, now built: findings carry their evidence and are grouped per element;
JS and TS are read from source through tree-sitter, where a language is a grammar plus one query file
(`src/code/queries/javascript.scm` serves JS, TS, and TSX); rules see functions, comments, and tests, never
a syntax tree.

Fixtures, `pnpm eval --isolation candidate`:

| Rule | Recall | False positives | Mean p (bad) | Mean p (good) |
| --- | --- | --- | --- | --- |
| `comment-describes-code` | 6/6 | 0/6 | 0.72 | 0.17 |
| `comment-gives-reason` | 6/6 | 0/6 | 0.89 | 0.12 |
| `function-name-matches-body` | 6/6 | 0/7 | 0.92 | 0.06 |
| `test-title-matches-body` | 5/5 | 0/5 | 0.97 | 0.05 |

Then jev-lint linted its own source: 33 files, 202 questions, $0.0024. The first run reported **47 elements**.
The fixtures had been perfect. After three fixes it reported **7**, with the fixtures still perfect. None of
the three fixes was a model problem.

| Cause | What happened | Fix | Where |
| --- | --- | --- | --- |
| Extraction | A comment inside a method chain was paired with the bare word `filter`. A file header was paired with the first `import`. | Pair with the whole call; skip file headers | parser |
| Wrong question | "Is this comment true of the code?" cannot be answered for a comment that gives a reason, and good comments mostly give reasons. 21 false reports. | Gate accuracy on a second question: does the comment describe an operation at all | composition |
| Wrong question | "Does it do only what its name says?" is too strict; ordinary functions scored 0.4 to 0.66. | Ask what actually harms a caller: a side effect the name does not suggest | question |
| Thresholds | Real tests assert through helpers and mapped values; they scored 0.58 to 0.74 against 0.97 for wrong tests. | Thresholds in the gap: 0.95 / 0.88 / 0.8 | policy |

Two lessons go beyond these rules.

**Atomic also means independent.** The first gating question was "does the comment state what *this code*
does?". For a stale comment the literal answer is no, so the gate closed on exactly the comments the rule
exists to catch, and recall fell from 6/6 to 0/6. Rephrased about the comment alone ("judge the comment by
itself and ignore any code"), recall returned. A question that mentions another question's subject can
collapse into it.

**Extraction errors look like model errors.** Every `filter` finding read as Jev being wrong about a good
comment. Jev was right about what it was shown. Printing what the extractor sees (`scripts/dump-code.ts`)
should be the first debugging step, before touching a prompt.

What remained is fair. `answersFor` does write to the cache and update run statistics, which its name does
not suggest (p = 0.49, review). The test doubles named `ask` record every request they receive (0.68 to 0.75).

Efficiency: the two comment rules select the same words, so the engine sends each comment once and asks all
three questions side by side. Identical questions about identical words are asked once per run.

## 9. Score, rendered pages, and the axe join

**Score holds up.** `scripts/probe-score.ts` lists items from worst to best on three four-level scales (error
message actionability, alt text usefulness, form instruction clarity). 53 of 53 pairs came back in the
expected order. Scores mostly land on a described level with confidence near 1.0 (0.00, 1.00, 2.00, 2.99) and
between levels for genuinely in-between items (1.24 for "An error occurred… try again later"). It behaves as
an ordered classifier, which is what page profiles and budgets need. It should not be read as a continuous
measurement, as TypeSafe's jaggedness page also says.

**Rendered pages.** A URL is now a lint target. Playwright loads it and jev-lint reads the DOM as users and
axe get it, after scripts have run.

**The axe join is exact.** `--axe full-report.json` reads a report from
[axe-aggregate-reporter](https://github.com/schalkneethling/axe-aggregate-reporter). Each axe node carries a
selector. While the page is open, every selector is resolved with `querySelector` and the element is stamped
with the indexes of its axe results; parse5 reads the stamps back. No HTML strings are compared. A finding
is **valid but false** when an axe rule that checks the form of the same thing (`link-name` for
`link-text-purpose`, `image-alt` for `alt-text-quality`, and so on, in `src/axe/report.ts`) passed on that
element.

First run, 8 pages of schalkneethling.com, cold cache: 550 questions, 390 requests, 176,927 tokens, $0.0074.
38 elements reported, **29 findings valid but false**: all link text that axe's `link-name` approved because
it is non-empty ("What I want to exist", "Get in touch", "here"-style prose links).

Two more false-positive classes surfaced, and both were again fixed in code, not in a prompt:

- `control-type-intent` reported prose links such as "showModal function" and "Dialog (Modal) Pattern" as
  actions (p above 0.9). A link with a real destination navigates whatever its text says, and code knows
  the destination. The rule now only asks about links that go nowhere (`#`, empty, `javascript:`). That
  also retires the "Edit shipping address" false positive from section 7. 91 reported elements became 54.
- `class-implies-element` reported `.theme-switch-icon`, which is `aria-hidden` and sits inside a `<label>`.
  Hidden elements are now skipped, and a "button-like" name is satisfied by any interactive relative
  (`button`, `a`, `label`, `input`, `select`, `summary`). 54 became 38.

Secrets: `@initOp(cacheTtl=8h)` keeps the 1Password approval to once per working day. A run now starts in
about 3 seconds with no prompt.

## 10. The first real report was mostly noise

The first published report on schalkneethling.com listed 38 elements and called 29 findings "valid but
false". Its author read it and called it noise, correctly. 33 of the findings were `link-text-purpose`
reporting post titles ("What if..."), tags ("testing"), and phrases such as "you can download a free copy
here". A uniform cluster from one rule is a miscalibrated question, not a discovery, and should have been
read that way before publishing.

After four changes the same 8 pages produce **one finding, and it is real**: the post "Understanding local()
in @font-face" carries the description of a different post ("Learn how to build a responsive profile
page…"), on its blog card and in its own `<meta name="description">`. p = 0.96. Valid HTML, passes axe,
invisible to any linter.

| Change | Before | After |
| --- | --- | --- |
| **Ask for the defect, not the virtue.** "Does this text name the specific page, resource, or action?" became "Is this text made up only of filler words that could sit on any link?" | 33 reports | 2 at review |
| **Judge in context, as WCAG 2.4.4 does.** Second question: is the link text an item of the kind its heading announces (a tag under "Tags")? p = filler × (1 − item under heading). "click here" under "Pricing" still fails. | 2 | 0 |
| **Shape the state, do not grow it.** A heading over a list was paired with the first post's excerpt. The state now says "A list of 120 items. The first 5 are: …". | "Browse all posts" p = 0.62 to 0.88 | not reported |
| **Thresholds in the measured gap.** Indirect titles over on-topic content reach 0.66; mismatches start at 0.81. | 4 at review | 0 |

Fixtures held at full recall and zero false positives throughout, which again shows what fixtures written
by the prompt author are worth. On the link aggregator the rewritten rule still reports "More" (0.97) and the bare
timestamps (about 0.92), which are fair, plus three usernames near 0.6, which are not.

### How much state

`scripts/state-experiment.ts` varies how many words of a section accompany its heading, over the fixtures
plus five labelled real headings:

| Words sent | Lowest bad | Highest good | Gap | Highest good is |
| --- | --- | --- | --- | --- |
| 10 | 0.83 | 0.76 | 0.07 | Browse all posts |
| 20 | 0.80 | 0.81 | −0.01 | Browse all posts |
| 40 | 0.81 | 0.88 | −0.07 | Browse all posts |
| 80 | 0.82 | 0.66 | 0.16 | Because I Want It to Exist |

More words did not help steadily; at 40 words the rule could not separate good from bad at all. The
troublemaker was a heading over a list, where any prefix of the text is one item and looks off topic. The
fix was a different kind of state, which the parser supplies. TypeSafe's
[State](https://docs.typesafe.ai/concepts/state) page gives the test: state is "the material you would
present to a panel of experts before asking them to make a judgment", in an object whose names keep "their
relationships clear". From that:

1. **Perceptual parity.** Send what the affected person perceives when the judgement matters: a screen
   reader user in a list of links gets the text and the heading above it, not the `href`.
2. **Shape over size.** Prefer a fact the parser can state ("a list of 120 items") to more raw text.
3. **Names that state the relationship.** `heading_above_link`, `content_under_heading`,
   `caption_shown_with_image`, not `heading`, `section_start`, `visible_caption`.
4. **Withhold the answer key.** Whatever code will compare against (`type`, `href`, the tag) stays out.
5. **Measure it.** State size is a parameter with an optimum, not a dial to turn up.

The HTML report now also shows, per rule, how many candidates were examined and how many were reported
(1 of 166 headings, 0 of 328 links), so a short report is distinguishable from a tool that looked at nothing.

## 11. A third-party page

First run on a site neither of us wrote: 118 questions, $0.0021, nine findings. Read critically, one was a
real defect scored too low, one was overstated, and one was noise. All three fixes were facts code already had.

| Finding | Verdict | Fix |
| --- | --- | --- |
| Six cards each carry `aria-label="Card link"` (p = 0.52, review) | Real, and under-scored. Jev only half-recognised "Card link" as filler. | Code counts destinations per link name. A name shared by links to different places is ambiguous whatever it says: the heading rescue is dropped and the evidence needed is halved, p = 1 − (1 − filler) × 0.5. Now 0.81, reported once with all six destinations, and the hint quotes the card's own title. |
| An `aria-label` that repeats the link's visible text, the product name, (p = 1.00, error) | Overstated. An exact repeat changes nothing a user hears. | Decided in code at review level. |
| A `<div>` with thirty Tailwind classes "looks like an `<article>`" (0.51) | Noise. Utility classes say how an element looks, never what it is. | Elements whose classes are mostly utility syntax are skipped. |

The shared-name fact then found two more things unprompted: "Get started" goes to `/guide/getting-started`
in the hero and to `/guide` further down, and on schalkneethling.com/projects 13 links are all named "View
project →". The second is the textbook case for an `aria-label`, which `aria-label-justified` would accept.

Final report for that page: 1 error, 2 warnings, 1 review, on 4 elements.

## 12. Two ways to make a request smaller

Reading the literal JSON sent for one image raised two questions: does the `candidate` wrapper earn its
place, and why is a question about a caption sent for an image that has none?

### The wrapper around a single candidate

In `candidate` isolation the state is `{ candidate: { alt, image_file_name, … } }` and every rule names a
field as `` `candidate.alt` ``. The wrapper is left over from the batched design of §1, where several
candidates shared one state and needed an index. With one candidate per request it is pure indirection,
which the [jaggedness page](https://docs.typesafe.ai/model-jaggedness/jev-1.13) lists as a weakness and the
[State](https://docs.typesafe.ai/concepts/state) page argues against.

Rules no longer write these paths. `questions` receives a `ref` that quotes a field the way the state in use
names it, so the same rule runs under both shapes and over the indexed states that `rule` and `file`
isolation still need. `scripts/state-shape-experiment.ts` then asks both shapes cold in one execution.

The fixtures cannot separate them. Both shapes kept full recall and zero false positives on all 11 rules;
each cell is wrapped first, flat second:

| Rule | mean p (bad) | mean p (good) | smallest bad-to-good gap |
| --- | --- | --- | --- |
| `alt-text-quality` | 0.95 / 0.96 | 0.03 / 0.03 | 0.71 / 0.71 |
| `aria-label-justified` | 0.98 / 0.98 | 0.07 / 0.06 | 0.73 / 0.72 |
| `class-implies-element` | 0.99 / 1.00 | 0.01 / 0.00 | 0.95 / 0.97 |
| `comment-describes-code` | 0.68 / 0.70 | 0.18 / 0.14 | 0.02 / 0.15 |
| `comment-gives-reason` | 0.90 / 0.88 | 0.12 / 0.11 | 0.66 / 0.55 |
| `control-type-intent` | 1.00 / 1.00 | 0.01 / 0.01 | 0.98 / 0.99 |
| `function-name-matches-body` | 0.92 / 0.93 | 0.06 / 0.06 | 0.69 / 0.66 |
| `heading-describes-section` | 0.91 / 0.91 | 0.04 / 0.04 | 0.68 / 0.69 |
| `label-input-type` | 0.97 / 0.98 | 0.00 / 0.00 | 0.79 / 0.85 |
| `link-text-purpose` | 0.94 / 0.94 | 0.04 / 0.04 | 0.74 / 0.73 |
| `test-title-matches-body` | 0.96 / 0.95 | 0.06 / 0.06 | 0.87 / 0.86 |

66,857 input tokens wrapped against 65,524 flat, 2.0% less. Every difference in the table is inside the
run-to-run variance of §6. (In this cold run wrapped missed one `comment-describes-code` case at p = 0.49
against a 0.5 threshold, which is what a 0.02 gap means: that rule sits on its threshold whatever the state
looks like.)

Real input decided it. Each input was judged three times: wrapped, wrapped again as a control for variance,
and flat.

| Input | Candidates | Reported, wrapped | Flips, control | Flips, flat | Input tokens, wrapped → flat |
| --- | --- | --- | --- | --- | --- |
| 8 pages of schalkneethling.com, `--axe` | 537 | 4 | 0 | 0 | 259,020 → 254,344 |
| The documentation site from section 11 | 47 | 4 | 0 | 0 | 27,440 → 26,966 |
| Link aggregator front page, `link-text-purpose` | 152 | 25 | 0 | 0 | 84,557 → 83,198 |
| this repo's own source | 241 | 12 | 2 | 4 | 102,452 → 100,489 |

736 candidates of HTML: not one changed status. The repo's own source, judged by the four code rules, changed
four, all of them new `review`-level reports, and it did so twice (a first pair of runs flipped two). The
control shows the size of the noise: two flips, one in each direction, all four values between 0.45 and 0.53.

One flip is not noise. `test-title-matches-body` on "tests are found by runner name, with title and callback"
scored 0.23 wrapped and 0.82 and 0.84 in two flat runs. The mechanism is visible in the sentence: the code
rules name their fields `title`, `body`, `name`, `code`, and `comment`, so "`` `title` `` is a test's title
and `` `body` `` is the test code" reads as prose about a title and a body, while `` `candidate.title` ``
can only be a field. The HTML rules were untouched because §10 already forced their names to state a
relationship: `heading_above_link` and `caption_shown_with_image` are nobody's ordinary words.

Decision: keep the wrapper. 2% of the tokens is not worth a reproducible 0.6 swing, and the wrapper is what
makes a field reference unmistakable when the field is called `body`. The flag and the experiment script
stay, because this is a per-model-version measurement and the next version has to be asked again.

### Not asking what code already knows

`alt-text-quality` asked whether the alt text repeats the caption for every image and dropped the answer when
there was no caption. It was a deliberate speculative question: at the time `questions` could not see the
candidate. It can now, and it returns only the questions `assess` will read. Two more were the same shape:
`link-text-purpose` ignores the heading question for a link with no heading above it and for a name shared by
several destinations, and `aria-label-justified` ignores the filler question when code has already found the
visible text repeated. The field goes with the question: an image with no caption sends no
`caption_shown_with_image: null`.

| Input | Questions before | After |
| --- | --- | --- |
| Link aggregator front page | 373 | 221 |
| the fixtures | 287 | 230 |
| this repo's own source | 308 | 308 |

41% of the link aggregator questions were about a heading that was not there. The repo's source is all code rules,
which have nothing conditional, so it pays nothing and saves nothing.

Nothing reported changed, because every omitted answer was one that was multiplied by zero or ignored. The
same three inputs report what §10 and §11 report: one error on schalkneethling.com, and 1 error, 2 warnings
and 1 review on the documentation site. The missing answer arrives in `assess` as `undefined`, and TypeScript knows which
ones can be missing: building the map with a conditional spread makes exactly those properties optional, and
`AnswersFor` carries the optionality through to the answer.

`alt-text-quality`'s question ids now read as predicates (`is_placeholder`, `repeats_caption`). Ids are never
sent to the model; they only appear in `--evidence`, JSON, and HTML reports.

## 13. When do a Noul's criteria earn their tokens?

TypeSafe's Noul page says the instruction is enough for most questions and criteria are for a subtle
boundary between yes and no. Every Noul here had criteria, by habit. `scripts/criteria-experiment.ts` removes
them from one question at a time and re-runs the rule's fixtures cold. "Gap" is the lowest bad case minus
the highest good case.

| Question | Gap with → without | Recall without | Verdict |
| --- | --- | --- | --- |
| `describes_behaviour` (comment) | 0.07 → −0.40 | 1/6 | essential |
| `only_restates` (comment) | 0.66 → 0.21 | 4/6 | essential |
| `on_topic` (heading) | 0.72 → 0.51 | 2/3 | keep |
| `surprising_side_effect` (function) | 0.68 → 0.43 | 6/6 | keep |
| `is_filler` (link) | 0.74 → 0.50 | 9/9 | keep |
| `visible_text_is_filler` (aria-label) | 0.69 → 0.46 | 8/8, one new false positive | keep |
| `adds_subject` (aria-label) | 0.70 → 0.54 | 8/8 | keep |
| `is_placeholder` (alt) | 0.74 → 0.59 | 7/7 | keep |
| `checks_what_title_claims` (test) | 0.88 → 0.81 | 5/5 | **removed** |
| `repeats_caption` (alt) | 0.74 → 0.73 | 7/7 | **removed** |
| `accurate` (comment) | 0.07 → 0.12 | 6/6 | **removed**; slightly better without |

`is_item_under_heading` is never asked by the fixtures, so it is unmeasured and keeps its criteria.

For us "most" runs the other way: eight of eleven questions need their criteria, two of them to work at all.
That follows from what this tool is. A question with a plain boundary is usually one a deterministic linter
could already answer; what is left for Jev is the subtle part. The three that lost their criteria are the
three plain comparisons: do two texts say the same thing, does the code do what the comment says, do the
assertions check what the title says. On the repo's own source, removing those three changed no candidate's
reported status (the control run changed one) and saved 5% of input tokens.

Predicting this by eye did not work. Before measuring, `on_topic` was on the "probably unnecessary" list
and cost a third of the rule's recall when removed.

## 14. Six more rules

Chosen from the catalog by evidence: four had passed a probe, one would have caught the real defect found
in section 10 directly, and one fills a gap ESLint leaves open.

| Rule | Fixtures (recall, false +) | First real input |
| --- | --- | --- |
| `description-matches-page` | 3/3, 0/3 | Reports the copied description on the `local()` post at 0.95; the WebDev Bench post passes. |
| `autocomplete-matches-label` | 7/7, 0/7 | A popular CSS framework's checkout example has no `autocomplete` at all: 11 fields reported, each with the exact token. "Expiration" is read as `cc-exp`, the field `label-input-type` had mistaken for a date. |
| `alert-is-urgent` | 5/5, 0/4 | A government portal announces "Thank you for your feedback" with `role="alert"` (0.97). |
| `aria-hidden-hides-content` | 5/5, 0/3 | Nothing true found yet. |
| `describedby-describes` | 4/4, 0/4 | No real page tested had a wrong description. |
| `swallowed-error-justified` | 5/5, 0/4 | The code tested had no empty `catch`. Validated on fixtures only. |

Every lesson from the earlier sections repeated itself within the hour:

- **Classify, then compare.** `describedby-describes` first asked "is this description about something other
  than this field?". A phone-number hint on a password field scored 0.13: it is a format hint, and a format
  hint "applies to a field". Now the label and the description are each classified alone, neither question
  seeing the other text, and code computes how likely the two kinds differ. The miss went to a catch, and the
  mean on bad cases from 0.73 to 0.89.
- **False positives were facts code had.** A large code host's sign-in page has `{{ message }}` in a `role="alert"`, which is an unrendered
  template slot. Its hidden tooltip is referenced by `aria-labelledby`, which exposes it. `onEnd` and
  `attributeChangedCallback` are named for when they run, so a side effect is their job. "CVV" was read as
  `cc-number` only because `cc-csc` was not among the options. None of these needed a prompt change.
- **Criteria, measured:** `is_urgent` needs them badly (gap 0.70 to 0.08, two false positives without),
  `is_needed` and `gives_reason` need them, `describes_another_page` does not (0.90 to 0.87) and lost them.

Seventeen rules: full recall and no false positives on 101 bad and 94 good fixture candidates. As before,
that says the prompts are sound and nothing about accuracy in the wild.

## 15. React: the HTML rules read JSX

Asked to lint a real React component
(an open-source site's `guide.tsx`, 238 lines),
jev-lint fared badly, and the problem was coverage rather than noise. The file is almost all JSX and the
extractor saw four functions. Two labelled buttons, a dialog, and the headings were invisible, because the
HTML rules only read HTML. Its one report was a false positive: `Snippet`, a component, "has a side effect
its name does not suggest".

`src/code/jsx.ts` now turns JSX into the element shape the HTML rules already read, using the same
tree-sitter parse. Every JS or TS file is read twice: as code, and for its markup. `className` and `htmlFor`
become `class` and `for`; markup inside `{items.map(...)}` and `{open && ...}` is read; a component keeps its
own name as the tag, so it matches no rule and its children are still seen. Anything computed at run time
(`{step.title}`, `aria-label={copied ? "Copied" : "Copy"}`) becomes a dynamic marker, and the engine drops
every candidate whose words contain it: judging half a label would be guessing.

| Input | Result |
| --- | --- |
| `guide.tsx` | 0 findings. Nearly all of its text is dynamic, so there was little to judge, and the `Snippet` report is gone. |
| `fixtures/jsx/Checkout.tsx`, 13 planted defects | 12 found with file:line, including inside `.map()` and `&&`. The × button with `aria-label="Close"` is correctly left alone. |

The thirteenth, a wrong heading, was skipped: its section contains `{item.name}`, so the candidate was
dropped as dynamic. Conservative by design, and a lost catch.

Two fixes came out of reading the component by eye. A capitalised function is a component or constructor,
named for what it is, so `function-name-matches-body` skips it. And "×" is an icon made of text: WCAG 2.5.3
is about text a person could say aloud, so `aria-label-justified` only counts visible text containing a
letter or digit, where before it would have reported `aria-label="Close"` for not containing "×".

Not handled yet: a conditional between two stated strings could be judged once per branch; props passed to
a component (`<Button label="Click here">`) are not read because the rule cannot know what the prop
becomes; and Vue, Svelte, and Astro templates need their own grammars.

## 16. A corpus from the wild

Everything before this section rests on about six sites and fixtures written by the prompt author. The
corpus replaces that. `scripts/corpus/fetch.ts` takes a seeded random sample of the Tranco top million,
a third from each of three rank bands (top 1k, 1k to 100k, 100k to 1M), keeps pages that declare English,
and renders the home page plus one form page found by following a contact, sign-in, or checkout link.
axe runs in the same visit and its results are stamped onto the saved DOM.

Seed 1: **138 pages**, 102 home and 36 form. To get them, 92 sites were skipped for not declaring English,
150 for failing to load, 10 for having too little text, and 9 as unsuitable. The suitability check is a Jev
question: a keyword list let an adult site through whose title was slang in another language.

### Prevalence, before any judging

`scripts/corpus/prevalence.ts` counts candidates with the parser alone. A perfect rule for a construct that
occurs on one page in a hundred is worth little, and this is free to find out.

| Situation | Pages with it | Candidates |
| --- | --- | --- |
| `link-text-purpose` | 100% | 17,939 |
| `class-implies-element` | 100% | 13,950 |
| `alt-text-quality` | 95% | 3,909 |
| `heading-describes-section` | 86% | 1,483 |
| idea: same-origin link, promise against destination | 78% | 6,726 |
| `label-input-type` | 77% (97% of form pages) | 355 |
| `description-matches-page` | 72% | 99 |
| `aria-label-justified` | 62% | 2,039 |
| `control-type-intent` | 50% | 264 |
| `aria-hidden-hides-content` | 47% | 412 |
| `autocomplete-matches-label` | 39% (67% of form pages) | 163 |
| idea: field with both a label and a placeholder | 39% | 126 |
| idea: fieldset with a legend | 9% (22% of form pages) | 24 |
| `alert-is-urgent` | 4% | 7 |
| idea: table with header cells | 4% | 7 |
| `describedby-describes` | 1% | 3 |

`describedby-describes` and `alert-is-urgent` barely occur on home and form pages; they belong to application
screens this corpus does not reach. Tables and legends are too rare here to prioritise. Link promise against
destination has the most candidates of any idea. `class-implies-element` is a third of all questions.

### The first judging run

40,623 judgements, 26,760 requests, 16.7M tokens, **$0.70**, 27 minutes at a paced 1,000 requests a minute.
5,916 were reported, about 15%, which is too many to be true. Reading the reports rule by rule, before
asking anyone to label them, found four systematic faults. None was the model's.

| Rule | What went wrong | Fix | Effect |
| --- | --- | --- | --- |
| `aria-label-justified` | "The label must contain the visible text" was decided in code at p = 1. Most of 739 errors were cards whose link text is a title plus a paragraph, labelled with the title: a cloud provider's product cards, labelled with the product name. The label's words are on screen. | Four containment cases. A label that is part of the text is fine. A label with unrelated wording gets a question: do both mean the same thing. A label that extends the text is reported only when it adds nothing. | 976 errors to 186 |
| `label-input-type` | Search boxes with `type="text"`. | `text` and `search` accept the same values; either satisfies either. | 109 errors to 30 |
| `heading-describes-section` | News headlines that link to their article, judged against the bylines and related links under them; headings paired with cookie-notice text. | A headline that is a link needs prose under it to be judged. Consent-manager markup is skipped. | 85 reports to 36 |
| `aria-hidden-hides-content` | Closed dialogs and collapsed accordion panels. They are hidden from sight too, which is correct. | The renderer stamps aria-hidden elements that are not visible either (`checkVisibility`, zero size, off canvas). Only the browser knows this. | needs a re-render of the corpus |

Also: "Image of…" is a redundancy, so it is now decided at review level, not as an error; and
`description-matches-page` no longer reads paragraphs in consent UI, navigation, footers, or forms.

Real finds the run made: `alt="alt"` and `alt="Missing alt text value"` on a large cloud provider's home page; `<a href="#">Zoom In</a>` on
a map; "No more previous content" announced as an alert; "Read more" and "Learn more" leading to six
different places on one page; forms without a single `autocomplete` token. And 901 controls whose
`aria-label` repeats their visible text exactly, which says something about how labels get added.

### Re-reading without asking

`--cache-only` judges from the answer cache and counts what it cannot answer instead of guessing. After the
fixes the whole corpus was re-judged in **6 seconds for $0**: 39,674 judgements, 5,013 reported, 503 left
unjudged because their question or their words changed. Policy and extraction changes are free to evaluate;
only a changed question or changed words cost anything.

### Labelling

`scripts/corpus/sample.ts` draws, per rule, up to 8 reports across severities and 5 unreported judgements
(those nearest the threshold, plus random ones), 126 items in all. They are loaded into a label bench that
shows the claim, the element, the words the model saw, and what code established, and hides the probability
and whether the tool reported it. `scripts/corpus/score.ts` turns the labels into precision and recall per
rule. `aria-hidden-hides-content` is left out of this round until the corpus is re-rendered.

**No accuracy figure exists yet.** That is what the labels are for.

## 17. The first blind labels

126 judgements from the corpus, labelled by someone who is not the prompt author, without seeing the
probability or whether the tool reported them. Up to 8 reports and 5 non-reports per rule, so every figure
here is a small sample. "Recall" is a lower bound: the non-reports lean towards near-threshold cases.

| Rule | Precision | Precision, error + warn | Recall | After the fixes below, same labels |
| --- | --- | --- | --- | --- |
| `autocomplete-matches-label` | 8/8 | 8/8 | 8/8 | unchanged |
| `link-text-purpose` | 7/7 | 5/5 | 7/10 | unchanged |
| `alert-is-urgent` | 3/3 | 3/3 | 3/3 | unchanged |
| `alt-text-quality` | 8/8 | 6/6 | 8/13 | 12/12 and 12/13 |
| `control-type-intent` | 8/8 | 6/6 | 8/13 | 13/13 and 13/13 |
| `label-input-type` | 7/8 | 5/5 | 7/10 | unchanged; recall understated, see below |
| `class-implies-element` | 5/8 | 4/6 | 5/7 | unchanged |
| `heading-describes-section` | 3/6 | 3/5 | 3/4 | 3/5; never an error now |
| `aria-label-justified` | **3/8** | **1/6** | 3/4 | 4/5 and 4/4 |
| `description-matches-page` | **3/8** | **1/6** | 3/4 | not validated, see below |

The last column flatters the fixes, because they were made in response to these labels. A fresh sample from
another seed is the honest test.

What the labels taught, rule by rule:

- **`aria-label-justified`, 38%.** "7" labelled "7 Comments" and "No" labelled "No, give us constructive
  feedback" were reported as adding nothing. The question asked whether the label adds "the specific
  subject" and listed items, articles, records, and sections; read literally, a unit or a consequence is
  none of those. Rewritten to ask for the defect: are the extra words only filler. A raw URL appended to
  the text counts as filler, which the labeller's answers asked for.
- **`description-matches-page`, 38%.** True and false were interleaved from 0.29 to 0.79. On a home page
  the description is a statement about the brand and the content is whatever comes first. The rule now
  judges only pages whose `h1` sits inside an `<article>` or that declare `og:type` article, which leaves
  almost nothing in this corpus. **The corpus has no article pages**, and that is where the rule's one real
  find came from. It stays unvalidated until the corpus has them.
- **`control-type-intent`.** All 13 sampled `href="#"` links were defects, including five the rule had let
  pass because "Legend" and "Weight Bars" do not sound like actions. Code already knew the link goes
  nowhere. The answer now can only excuse a link (p = 1 − P(navigates)), and review starts at 0.25.
- **`alt-text-quality`.** All five non-reports at 0.33 to 0.39 were real placeholders ("Map",
  "instagram icon", "Mobile 2 - Dark"). Review now starts at 0.3.
- **`heading-describes-section`.** Above 0.7 the labels did not separate (true at 0.94, 0.87, 0.80; false at
  0.91, 0.85, 0.78). Whether a heading fits is partly taste, so the rule no longer raises errors. A bug also
  surfaced: `<noscript>` is parsed as raw text, so its markup was quoted as content.
- **`class-implies-element`, 63%.** Mixed throughout. One "false" was a finding pointing the right way at the
  wrong element ("it should actually be a nav").

**The bench had a flaw of its own.** For an unreported `label-input-type` item the claim read 'asks for an
email value, but the input is type="email"', which the labeller reasonably called true. Two of that rule's
three misses are this artefact. A claim must read the same whether or not the tool agreed; `sample.ts` now
states that rule's claim from the facts alone.

Two notes from the labeller are policy, not accuracy: `type="search"` is the right type for a search box
(the overnight change stopped reporting `type="text"` there), and "Departure" and "Arrival" should be
`type="date"` (scored 0.36 and 0.46: the right direction, under-confident).

`score.ts --against <judgements>` re-scores the same labels against a later run by joining on rule, page,
and the words judged, so a fix can be checked in a minute without new labels.

## 18. Truncation limits, measured

Every place the rules cut text had its limit set for thrift. Jev allows 32k tokens of state, the project
was nowhere near it, and the one earlier measurement (section 10) had shown more context helping. So each
limit was measured: how often it bites, with no model at all, and then what changes when it is widened.
All limits now live in `src/rules/limits.ts`; `scripts/truncation-experiment.ts` varies one at a time, cold,
with the current value asked twice as the control for run-to-run variance.

**The code limit was hiding a rule's whole purpose.** `function-name-matches-body` exists to find a side
effect the name does not suggest. On five realistic long functions whose side effect comes late (a redirect
2,100 characters in, a charge and a cancellation at the end of 4,600), with five matched clean functions:

| Characters of body sent | Recall | False positives | Mean p, bad | Mean p, good |
| --- | --- | --- | --- | --- |
| 1,500 (the old limit) | 0/5 | 0/5 | 0.12 | 0.09 |
| 3,000 | 3/5 | 0/5 | 0.60 | 0.09 |
| 6,000 | 5/5 | 0/5 | 0.90 | 0.07 |
| no limit | 5/5 | 0/5 | 0.90 | 0.07 |

At 1,500 a function that charges a card looked exactly like clean code. The limit is now 6,000, which covers
every function in this repo (longest 5,785) and in a real TypeScript project, for 4% more tokens. On 162 real
functions here, one changed status, against three in the control run. The old comment on `clip` said a
name's promise "is usually broken early or not at all". That was a guess, and it was wrong.

**The heading limit needed widening, and no limit at all was worse.** Where a section opens with a quote, a
byline, or "in this section we will look at", the topic only appears after word 80:

| Words of section sent | Recall | False positives | Mean p, bad | Mean p, good |
| --- | --- | --- | --- | --- |
| 80 (the old limit) | 0/3 | 0/5 | 0.34 | 0.22 |
| 160 | 1/3 | 0/5 | 0.61 | 0.07 |
| 240 | 3/3 | 0/5 | 0.88 | 0.08 |
| no limit | 3/3 | 0/5 | 0.92 | 0.08 |

On 654 real corpus headings, 240 words reported nothing new. But with no limit a genuine mismatch, a
"Crosswords" heading over a football photo caption, fell from 0.86 to 0.71 and out of the report: later
paragraphs dilute the judgement of what a heading introduces. That is TypeSafe's "irrelevant state hurts",
seen directly, and it is why the limit is 240 and not infinity. Sections that open on topic and drift
later stayed unreported at every value, which is the right answer: the opening is what a reader skims.

**Five limits stayed.** Two never bite (`alert-is-urgent` and `describedby-describes`: the longest corpus
text was under 40 words). Three bite often and change nothing: the 60 words of page content bite 92% of
the time and moved no candidate; 40 words of hidden text bite 17% and moved the mean by 0.008; naming 5,
20, or all list items moved two of 572 candidates where the control moved two.

| Limit | How often it bites | Decision |
| --- | --- | --- |
| code, 1,500 characters | 5 to 11% of functions here; none in the other project | **6,000** |
| section under a heading, 80 words | 7% of 1,287 corpus headings | **240** |
| list items named, 5 | half of all lists | unchanged: no effect |
| hidden text, 40 words | 17% | unchanged: no effect |
| page content, 60 words | 92% | unchanged: no effect |
| alert message, field description, 40 words | never | unchanged |

A limit is a parameter with an optimum. It should be found by measuring, in both directions.

## 19. A second corpus, with article pages

The first labels were followed by fixes scored against the same labels, which flatters them, and
`description-matches-page` had nothing to be tested on. Seed 2 is the honest test: a fresh sample of the
same list, fetched with the visibility stamp, and with a third kind of page.

**Finding articles without reading words.** `fetch.ts --articles` looks for an article from each home
page by structure only: the site's own feed, teaser cards (a heading link inside an `<article>`),
headings that are links, then deep links in `main`. A page is kept when it matches what the rule itself
requires (an `h1` inside `<article>`, or `og:type=article`) and has prose: three paragraphs of 15 words,
200 words in all. A candidate that fails is usually the index above an article, so its teasers get one
more hop. About one kept site in four yields an article; the run ended with 43, not the 60 asked for.

| band | home | form | article |
| --- | --- | --- | --- |
| top 1k | 30 | 13 | 8 |
| 1k to 100k | 30 | 14 | 17 |
| 100k to 1m | 30 | 14 | 18 |

174 pages from 128 domains. Three pages were dropped by hand after the run (two borderline topics, one
spun content-farm page that alone produced 12% of all `link-text-purpose` reports); the re-judge came
from the cache. On article pages `description-matches-page` has a candidate on 79% (34 of its 45
candidates), against 9% of home pages, so the rule can now be measured.

**Judging.** 49,524 judgements, 5,954 reported (12%), none unjudged; the live run cost $0.84 for 20M
tokens in 33 minutes. One lesson from the fetcher: a step with no timeout of its own (`page.evaluate`
around an in-page `fetch`) parked every worker behind feeds that never answered. Every wait now has a
deadline.

**What the reports show, before any labels.** No rule was changed, so the labels test what is committed.

1. `aria-label-justified` reports 80% of its candidates. 1,235 of its 1,341 reviews are decided by code
   at a fixed 0.45 with no judgement involved: 732 labels that repeat the visible text exactly (case
   differences included) and 503 labels that do not contain it. The 129 errors and warnings, the part
   Jev judged, are buried under them. This is a reporting-policy question, not a prompt question.
   Decision: merge in the report. An assessment may name a `pattern`, worded for any number of elements;
   findings of one rule that share a pattern in one file become one finding at the first place, listing
   every other. Judgements stay per element, so measurement is unchanged. The rule's 1,470 reports on
   102 pages become 373.
2. `aria-hidden-hides-content` reports 68%, piled between 0.4 and 0.6. With invisible content stamped
   out, what remains is visible duplication: the option list of a custom select, repeated marquee
   copies, a mobile and a desktop copy of one menu or price, text inside product mock-ups. The rule
   checks for the same words near the element, not elsewhere on the page.
3. Third-party accessibility overlays trip several rules at once. Half of `alert-is-urgent`'s reports
   are one overlay's toolbar buttons inside an assertive live region. Decision: keep them. Unlike consent
   text, an overlay's controls are what a user meets, so the finding stands, but the page's author cannot
   edit it. `locOf` now marks any element inside an overlay and the finding carries the fact
   `third-party widget: accessibility overlay`: 53 reports on 9 pages here.
4. `class-implies-element` still reads names with nothing in them: hashed CSS-module classes, utility
   strings that slip past the filter when an id is present, and consent-manager markup.
5. One widget, dozens of reports. A currency picker built from `<a href="#">` is one defect reported 34
   times by `control-type-intent`. The engine has no notion of a repeated component within a page.
6. Articles bring captions. 17 `alt-text-quality` reports, 15 of them errors, are "alt repeats the
   visible caption", on two sites. Decision: an error. Alt text says what the image shows and a caption
   adds context; they do different jobs, and the finding now says so.
7. `heading-describes-section` reports 1% of 1,714 headings and no errors. After round one the risk has
   moved from precision to recall. It also judged a heading that was only punctuation.
8. A domain list is not a site list: one company appeared under three sampled domains with near-identical
   forms, and three domains carried spun variants of one article.

The blind sample is 145 items (8 reported and 5 unreported per rule where they exist), drawn round-robin
across page kinds as well as severities so that every rule is seen on home, form, and article pages.
`aria-hidden-hides-content` is included for the first time.

## 20. The second blind labels

145 items from the second corpus, labelled blind by the same person, with no rule changed between the
first labels' fixes and this sample. This is the honest figure the first round could not give.

| Rule | Precision | Precision (error + warn) | Recall (lower bound) | First round |
| --- | --- | --- | --- | --- |
| `alt-text-quality` | 8/8 | 6/6 | 8/11 | 8/8 |
| `control-type-intent` | 8/8 | 6/6 | 8/12 | 8/8 |
| `alert-is-urgent` | 6/7 | 6/7 | 6/10 | 3/3 |
| `label-input-type` | 6/7 | 4/5 | 6/8 | 7/8 |
| `aria-label-justified` | 5/8 | 4/6 | 5/5 | 3/8 |
| `link-text-purpose` | 5/8 | 4/6 | 5/7 | 7/7 |
| `autocomplete-matches-label` | 5/8 | 4/5 | 5/6 | 8/8 |
| `description-matches-page` | 3/5 | 2/3 | 3/3 | 3/8 |
| `class-implies-element` | 3/7 | 3/5 | 3/4 | 5/8 |
| `aria-hidden-hides-content` | 3/8 | 2/5 | 3/4 | not labelled |
| `heading-describes-section` | 2/8 | 0/2 | 2/4 | 3/6 |
| `describedby-describes` | none reported | | 0/3 | not labelled |

Over all rules: 54 of 82 reports were right (66%), and 41 of 56 errors and warnings (73%).

**Two rules held at 8/8 on a fresh sample**, `alt-text-quality` and `control-type-intent`: both ask a
narrow question about very few words. `aria-label-justified` improved from 3/8 to 5/8, which is what the
rewritten question was for. Rules that were perfect on the first sample (`link-text-purpose`,
`autocomplete-matches-label`) were not on the second: eight items is too few to call a rule perfect.

**Most disagreements are facts code holds, not misjudgements.** Read one by one:

- `link-text-purpose`: two of three false reports are phone numbers on `tel:` links. The destination is
  the number; code knows the scheme.
- `aria-label-justified`: an image link whose only "visible text" is the image's alt. The label names the
  card on purpose. `text()` counts alt as visible text, which is right for an accessible name and wrong here.
- `aria-hidden-hides-content`: `aria-hidden` on an `<svg>` whose `<title>` was read as hidden content; a
  decorative HTML mock-up; text that is exposed next to the hidden copy under the same link.
- `heading-describes-section`: four of six false reports are headings over a form or a dialog, where the
  "content" sent was option lists and field labels ("Country* United States Canada Afghanistan…").
- `autocomplete-matches-label`: search boxes and a disabled calculator field, neither asking for the
  user's own data.
- `label-input-type`: a one-time-code box ("Digit 6"). A code is not a quantity, like a postal code.
- `describedby-describes`: all three misses are descriptions that repeat the label ("Last *" described
  by "Last"). The rule asks whether the description is about another field; repetition is a different
  defect, and a string comparison finds it.
- `alert-is-urgent`: the misses are "Field is required" messages at 0.22 to 0.32. The labeller would not
  announce them assertively; the model thinks a validation error is urgent. This one is a judgement
  boundary, and the criteria should say which side validation messages fall on.

The remaining false reports are judgement: marketing copy under a form's heading, part-of names from CSS
modules (`Header_subtitle__x`), a meta description that fits its page.

**Fixes, and what they score.** Code only, except two criteria: `tel:` and `mailto:` links showing their
own number or address are left alone; a control whose only visible text is an image's alt is not a
candidate for `aria-label-justified`; `aria-hidden` on an `<svg>` is skipped; a heading over two or more
form fields is skipped, as is one with no letters; search boxes and fields nobody can type into are not
asked for an autocomplete token, which gained `address-level1` and `address-level2` (its hint had
offered `street-address` for a city, and `none` when "none" won); a numeric `inputmode` on a text field
excuses "number"; a description that repeats its label is decided in code. The two criteria: a
validation note on one field is not urgent, and a call-to-action heading fits content that leads to the
action.

Two first attempts were wrong and the labels caught both: dropping `<select>` options from all text
hid the hidden option lists `aria-hidden-hides-content` had rightly reported, and "any field under the
heading" silenced a phone number used as a heading over a search box.

Against the same labels, which flatters: 59 of 75 reports right (79%, from 66%). `alert-is-urgent` 10/11
with recall 10/10 (from 6/7 and 6/10), `label-input-type` 6/6, `link-text-purpose` 5/6,
`describedby-describes` 2/2. `heading-describes-section` now reports 2 of its 13 labelled items, one
right: it is close to silent, and partly a matter of taste. `class-implies-element` (3/7) and
`aria-hidden-hides-content` (3/7) are unchanged in kind: their false reports are judgement, not facts.
A third sample of 55 unseen items, for the eight rules that changed, is the test of these numbers.

## 21. Working rules for writing a Jev lint

−1. Ask for the defect, not the virtue. "Is this specific enough?" has no boundary and a literal reader
   fails everything; "is this only filler?" is bounded. When one rule produces a uniform cluster of
   findings on real input, suspect the question before believing the result.
0. First strip out everything that is a lookup, a count, a pattern, or a string comparison. Ask Jev only
   what is left, one atomic judgement per question, and combine the answers in code.
1. One candidate per request. Give it named fields, not raw markup.
2. Withhold what the model must not lean on: the `href` in `link-text-purpose`, the input `type` in
   `label-input-type`. Compare against the withheld fact in code.
3. Prefer "Jev classifies, code compares" (`label-input-type`) over "Jev, is this wrong?". It produces a
   suggested fix for free.
4. Put boundary cases in the criteria ("nav-item is not a nav", "postal code is not a number").
5. Every rule returns a violation probability. The engine owns the thresholds, so tuning never touches a
   prompt.
6. Tune thresholds on real pages. Fixtures only show that a prompt is sound.
7. Make each question independent: it must not mention what another question judges.
8. When a finding looks wrong, print what the extractor produced before changing the prompt.
9. Dogfood early. Fixtures written by the prompt author pass; real code does not.
10. Criteria are for a subtle boundary. Measure whether each one earns its tokens
    (`scripts/criteria-experiment.ts`); do not predict it.
11. Do not ask a question whose answer you already know you will not read. Leave the field it was about
    out of the state too.
12. Read a rule's reports on real pages before measuring them. A rule that reports most of its candidates
    has an extraction or policy fault, and labelling noise wastes the labeller.
13. Ask what only the browser knows (visibility, computed role) at render time and stamp it on the DOM.
14. Where code already knows the element is wrong, let the model's answer only excuse it, never be
    required to condemn it.
15. A claim shown to a labeller must read the same whether or not the tool agreed with it.
16. Truncate by measurement, never for thrift: first count how often a limit bites, then widen it and
    watch both recall and what gets diluted. More context can lose a finding as easily as find one.
17. Pin the model version. Thresholds are tuned against it.
18. Eight right out of eight is not a perfect rule. Score every fix on a sample it has not seen.

## Open questions

- A labelled set from real sites, written by someone other than the prompt author, to get honest precision.
- Inline suppression comments and a baseline file, which any real linter needs.
- User-defined rules from a config file: `{ select, ask, failWhen, threshold }`. This is the most novel use,
  and nothing found here blocks it.
- Adversarial content. State is not treated as hostile, so linting untrusted HTML could be steered.
  That is acceptable for linting your own code and not for gating third-party content.
