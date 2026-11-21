# Rule catalog

Ideas for semantic lints over HTML, CSS, and JavaScript, and how each maps onto Jev. A semantic lint earns
its place only where a deterministic linter cannot decide, because the answer depends on what words mean.

Every rule has the same shape:

1. **Code extracts** a small candidate with a parser and gives it named fields.
2. **Jev classifies** one narrow thing about it: a Noul (does a condition hold), a Choice (which one of a closed
   set), or a Score (where on an ordered scale).
3. **Code decides**: compares with facts it withheld, applies thresholds, reports `file:line:col`.

Status: **built** (in `src/rules`, measured in [findings.md](findings.md)) · **probed** (passed a small live
probe in `scripts/probe-css-js.ts` or `scripts/probe-aria.ts`) · **idea** (untested) · **poor fit** (do not build).

Risk refers to [Jev's documented jaggedness](https://docs.typesafe.ai/model-jaggedness). Rules are tuned against `jev-1.14.0`.

A built JS/TS rule is **default** when a blind panel has called its errors and warnings right at its shipped
thresholds on code it was not tuned against, or it reports only what the parser decides. Every other built
rule is **opt-in**: the panel called fewer than half of its errors and warnings right (findings §31).
"Experimental" marks an opt-in rule that is a rewrite still being worked on.

## HTML

| Rule | Catches | Code extracts | Jev classifies | Code decides | Status |
| --- | --- | --- | --- | --- | --- |
| `alt-text-quality` | alt that is a file name, a placeholder, announces "image of", or repeats the caption | alt, file name, figcaption; the "image of" opening is a regex, decided in code | two Nouls: `is_placeholder`; `repeats_caption`, asked only of an image that has one | p = the larger of the two | built |
| `link-text-purpose` | "click here", "more", bare timestamps; raw URLs decided in code | accessible name and the heading above the link; `href` withheld | two Nouls: is the text only filler; is it an item of the kind the heading announces | p = filler × (1 − item under heading) | built |
| `control-type-intent` | links that go nowhere and perform actions (`<a href="#">Delete</a>`) | only links with a placeholder `href`; a real destination means navigation, decided in code | Choice: navigates / performs action / unclear | p = P(performs action) | built |
| `label-input-type` | "Email" with `type="text"`, "Postal code" with `type="number"` | label, placeholder, name; `type` withheld | Choice over value kinds | p = 1 − P(option matching the actual `type`); suggests the right type | built |
| `class-implies-element` | `<div class="site-header">`, `<span class="btn">` | class and id; semantic ancestors and descendants withheld | Choice over semantic elements, or none | p = 1 − P(none); suppressed when that element already wraps or sits inside it | removed: see below |
| `heading-describes-section` | template leftovers, headings that no longer match their content | heading, first 80 words under it | Noul: is the content about the heading's topic | p = 1 − noul; lenient thresholds | removed: see below |
| `autocomplete-matches-label` | "Email" without `autocomplete="email"`, or with the wrong token (WCAG 1.3.5) | label, placeholder, name (shares its request with `label-input-type`); the token withheld | Choice over 17 personal-data purposes, or none | compare with the actual token; the hint names the right one | built |
| `description-matches-page` | a meta description copied from another page or left over from a template | description, title, h1, first 60 words of the main paragraphs | Noul: is the description about a different subject | high p reports | built |
| `button-text-is-action` | buttons labelled "OK", "Yes", "Here" | button text | Noul: does the text name the action | low p reports | idea |
| `placeholder-as-label` | placeholder carries the only instruction for a field | placeholder, label presence (code) | Noul: is this placeholder an instruction or label rather than an example value | only when code finds no label | idea |
| `lang-mismatch` | `lang="en"` on German content | text sample; `lang` withheld | Choice over a closed language list | compare with `lang` | idea; risk: English is the primary training language |
| `error-text-actionable` | inline validation text that blames or says nothing | text of `[role=alert]`, `.error`, `aria-describedby` targets | Noul | low p reports | idea; same classification was probed for JS strings |

### Removed after two rounds of blind labels

`heading-describes-section` was right on 5 of 14 labelled reports and its probability did not separate
right from wrong: false at 0.91 and 0.85, true at 0.72, real defects unreported at 0.70. Whether "Raise
the bar" fits the copy under it is taste, and a linter should not report taste. The defects it did find
(consent text under a heading, "Footer Column 2", a phone number as a heading) are extraction facts that
belong to other checks.

`class-implies-element` was right on 8 of 15, again with no separation (false at 0.99, true at 0.45). It
classified names alone, but whether a `<div>` should be a `<nav>` depends on what it contains and what it does
on the page. A successor would describe the element's contents (links only? one control? repeated on
every page?) and ask what that is, with the name as one field among several. It was also the costliest
rule: about 19,000 candidates per corpus.

## ARIA

ARIA has two halves. Whether it is *valid* is a lookup in the spec: which roles exist, which attributes a
role allows, which children it requires, which roles are redundant on which elements. axe and html-validate
do that exactly, and Jev adds nothing. Whether it is *true* depends on meaning, and no existing linter checks
it: ARIA overrides what assistive technology announces, so a wrong value is worse than none.

In every rule below, code resolves the references first (`aria-labelledby` and `aria-describedby` ids, text
content, the element's role) and Jev sees only the resolved strings.

| Rule | Catches | Code extracts | Jev classifies | Status |
| --- | --- | --- | --- | --- |
| `aria-label-justified` | an `aria-label` on a control that already has visible text, where it is not needed or does not help | visible text, aria-label, how many controls on the page share that visible text | see below | built |
| `aria-label-usable` | `aria-label="button"`, `"icon"`, `"click"`, a class name | aria-label | Noul: does it name an action or destination | probed 5/5 |
| `aria-hidden-hides-content` | `aria-hidden="true"` around an error, price, or instruction | text of the outermost hidden element; skipped in code when the same text is exposed nearby, the element is referenced by `aria-labelledby`/`aria-describedby`, or it sits in a control named by `aria-label` | Noul: is this information a user needs | removed: the answer depends on run-time behaviour (findings §21) |
| `alert-is-urgent` | `role="alert"` or `aria-live="assertive"` on greetings, cookie notices, result counts | static text of the live region; unrendered template slots skipped | Noul: urgent enough to interrupt | built; only sees text present in the markup |
| `describedby-describes` | `aria-describedby` pointing at unrelated text after a refactor | field label, resolved description | two Choices, each seeing one text: what the label asks for; what kind of field the description was written for. Code compares. | built |
| `role-matches-purpose` | `role="button"` on something labelled like a destination, `role="tab"` outside anything tab-like | role, label, sibling roles | Choice over a short role list | idea; overlaps `control-type-intent` |
| `landmark-label-distinct` | two `<nav>` regions whose labels do not tell them apart in meaning ("Menu", "Navigation") | labels of same-role landmarks, pairwise | Noul: would a user know which is which | idea; exact duplicates are a deterministic check |

`aria-label-justified` starts from the position that an `aria-label` should not sit on a control with visible
text unless it makes otherwise identical controls unambiguous, such as several "Read more" links. Three
steps, and only the last two involve Jev:

1. **Code.** The `aria-label` must contain the visible text (WCAG 2.5.3, label in name), or voice control
   users cannot activate the control by saying what they see. String containment; report as an error.
2. **Is an override justified?** Only when the visible text is ambiguous. Code counts controls sharing the
   same visible text. If it is unique, the `link-text-purpose` classification decides whether it is generic. Unique
   and specific visible text means the `aria-label` should be removed.
3. **Does it disambiguate?** Noul: does the `aria-label` add the specific subject the visible text leaves
   out. "Read more about the Postgres migration" scores 0.97; "Read more link" scores 0.04.

The message for a justified, working label can still suggest the sturdier alternatives: visually hidden
text inside the control, or `aria-labelledby` pointing at the control and its heading.

Poor fit: allowed and required attributes, required owned elements, `aria-controls` and `aria-owns` id
integrity, `tabindex` order, focus management, and anything that only exists after JavaScript runs.

## CSS

Parser: postcss. Convert numeric representations to words in code before asking. Jev is weak on hex colours
and on comparing numbers, so send `blue`, not `#00f`, and never ask it which of two lengths is larger.

| Rule | Catches | Code extracts | Jev classifies | Code decides | Status |
| --- | --- | --- | --- | --- | --- |
| `class-name-matches-declarations` | `.text-red { color: blue }`, `.is-visible { display: none }` | selector, declarations with colours named | Noul: do the declarations do what the name promises | low p reports; only for utility-like single-class selectors | probed 6/6 |
| `visually-hidden-is-accessible` | `.sr-only { display: none }`, which hides content from screen readers too | selector matched by name in code, declarations | Noul | low p reports | probed 3/3; a deterministic check for `display: none` does most of this |
| `custom-property-kind` | `--color-primary: 1.5rem` | name; value kind computed in code (colour, length, time, font, …) | Choice: what kind of value does this name promise | compare with the computed kind | probed 4/4 as a Noul; the Choice form is better |
| `comment-contradicts-rule` | a comment describing behaviour the rule below it does not have | comment, the following rule | Noul: does the comment describe the code | low p reports; lenient thresholds | probed 5/5, one subtle case at 0.45 |
| `magic-value-explained` | `z-index: 9999`, `margin-top: -3px` without a reason | code finds the magic value and the nearest comment | Noul: does the comment explain why this value | only when a magic value exists | idea |
| `bem-element-belongs` | `.card__sidebar-nav-link` that is not part of a card | block, element, sibling element names | Noul: is the element plausibly a part of the block | low p reports | idea; likely noisy |
| `state-class-naming` | team convention: state classes read as states (`is-open`), not actions (`open-it`) | class names touched by JS or in `:is()` | Noul against a convention written in plain language | per team | idea |

## JavaScript

Parser: tree-sitter, one query file for JS, TS, and TSX. Keep candidates to one function, one comment and its statement, or one string.
A whole module is too much state, and anything needing data flow across functions needs more hops than Jev
handles well.

| Rule | Catches | Code extracts | Jev classifies | Code decides | Status |
| --- | --- | --- | --- | --- | --- |
| `function-name-matches-body` | `getUser` that deletes, `isReady` that loads and returns nothing | name and body, only for names that promise an answer (`get…`, `is…`, `parse…`), outside test files and object literals; a body that cannot act is skipped; "returns no value" is the parser's fact | two Nouls: would a caller who read only the name be surprised by a side effect; does the body change something that outlives the call, apart from producing its answer | p = √(surprised × own consequence), and the first answer alone for a function that returns nothing; p ≥ 0.8 warns; a name that promises a value and returns none is held at review at least; a `calc…` or `check…` that returns nothing is skipped; a prefix most of whose functions are reported becomes one house-style finding | built; opt-in (5 of 14 right over rounds 4 to 6) |
| `comment-describes-code` | stale comments | comment and the section it heads (to the next comment, or the whole body when it opens one); directives, API docs, commented-out code, comments above declarations, and unparsed code skipped in code | the `comment-kind` Choice; two Nouls: is something specific contradicted; does the code do what it says | p = P(makes a claim) × contradicted × (1 − accurate) | built; experimental (the earlier version: 2 of 26 right) |
| `test-title-matches-body` | a title copied from another test; a title whose behaviour no assertion touches | title and callback of `it` / `test` calls that hold an assertion; hooks skipped | Noul: do the assertions check what the title claims | reports only from p ≥ 0.88 | built; opt-in (14 of 29 right over rounds 4 to 6) |
| `error-message-actionable` | "Something went wrong", raw error codes, blaming tone | string literals in `throw`, toast, and alert calls | Noul, or a Score from cryptic to actionable | low p reports | probed 5/5 |
| `ui-string-style-guide` | strings that break the team's voice and tone guide | user-facing strings; the guide in the criteria | one Noul per guideline | per team | idea |
| `boolean-name-polarity` | `const disabled = isEnabled(user)` | name, initialiser | Noul: does the name mean the same as the expression, not its opposite | low p reports | idea; risk: negation and indirection |
| `swallowed-error-justified` | an empty `catch` or `.catch(() => {})` with nothing nearby showing why it is safe | the handler's comment, the code that can fail, the statements around it, and the enclosing function or test; skipped: a `try` that assigns an outer variable (it keeps its fallback), test files, and `try { module.exports = … } catch {}` | Choice: reason stated / evident from code / costs nothing / nothing | p = P(nothing) | built; experimental (8 of 26 right over rounds 4 to 6) |
| `test-title-matches-body-next` | the same as `test-title-matches-body` | also the enclosing `describe` titles | two Nouls and a Choice: does the title name an outcome at all; do the assertions check something else; how the test relates to its title (checks it / different subject / too weak / opposite / no claim) | p = names outcome × √(checks something else × (different subject + too weak)); warns from 0.8 | built; experimental (14 of 30 right over rounds 4 to 6) |
| `doc-matches-function-next` | the same as `doc-matches-function`, and a `@param` or `@returns` description at odds with the code | the whole doc comment, the parameter list, name, body | Noul: is something specific contradicted; Choice: does the comment describe behaviour, explain, or neither; code: a `@param` that names a parameter the function does not take | p = contradicted × P(describes), raised when a documented parameter does not exist; warns from 0.8, reviews from 0.5; licence headers and bodies that only return a constant are skipped | built; experimental (8 of 17 right over rounds 4 to 6) |
| `doc-matches-function` | a doc comment copied from a sibling function, or left behind when the body changed | the comment directly above a function, JSDoc or not (its prose before the first tag), name, body; stubs, notes, and "use X instead" summaries skipped | two Nouls: is something specific contradicted; is the summary accurate | p = contradicted × (1 − accurate) | built; default (7 reports among the 410 functions with a JSDoc block; plain comments above functions not yet classified) |
| `error-message-matches-guard` | `if (!user.email) throw new Error("name is required")`; "Must be greater than 500" under `x >= 500` | an `if` whose only consequence is a throw with a literal message, or an `assert(check, "message")`; guards of one function sharing a message joined; enclosing conditions and earlier early exits sent as what must hold; the condition's numeric bound read in code and withheld | two Nouls: does the message state a requirement; does the condition contradict it. A Choice, where code has a bound: which kind of limit the message states | p = the larger of requirement × contradicts and the probability of a limit that differs from the code's | built; experimental (the first version: 0 of 5 right by a panel, AUC 0.91 on seven defects) |
| `test-assertions-can-fail` | `assert.ok(true)`; every assertion inside an `if` | assertion statements read from the tree | nothing | constant assertions are a warning, all-conditional ones a review | built; default; code only |
| `boolean-name-holds-boolean` | `const isBot = id ? user.jid : ""` | variables named `is…`/`has…`/`should…`/`can…`/`was…`/`did…` whose value is a literal string, number, object, array, or a conditional with such a branch | nothing | reported from code | built; default; code only |
| `locale-entry-matches-key` | `flushdb: "Database backup"` in a translation file | one key and value from an object literal in a locale file | Choice: same meaning / different meaning / name too vague | p = P(different meaning) | idea; 6 real cases among the 184 kept defects of findings §26, 1,793 candidates |
| `documented-type-matches-default` | `@property {boolean} [clonesMin] Minimum number of clones` with default `0` | a documented type, its description, and the default value | code compares type with default; Choice on how many kinds of value the description names | per case | idea; 2 real cases |
| `todo-quality` | `// TODO fix` with no owner, reason, or condition | comment text | Noul against the team's TODO convention | per team | idea |
| `log-may-leak-sensitive` | `console.log(user.password)` | identifiers and property names passed to log calls | Noul per identifier: does this name suggest a secret or personal data | high p reports | idea |
| `jsdoc-param-meaning` | `@param userId` described as "the user's email" | param name, description | Noul | low p reports | idea |

## Cross-language and team conventions

- **User-defined rules.** Built: `{ id, on, ask, criteria, reportWhen, message, thresholds, where }` under
  `custom` in a config file, where `ask` is a convention in plain language ("Does this test title name the
  behaviour being tested?") and `on` picks what the parser already extracts: functions, comments, tests,
  guards, or ignored errors. This is what TypeSafe's use-case map describes, and no existing linter offers
  it. Not built: a Choice, more than one question per rule, or an extraction of the user's own.
- **Hook names vs behaviour.** `data-*` attributes and `js-*` classes whose names promise one behaviour while
  the handler bound to them does another. Needs cross-file extraction in code first.
- **Docs vs code.** README examples and option tables that contradict the actual option names and defaults.

## Poor fit

| Idea | Why not | Do instead |
| --- | --- | --- |
| Colour contrast, specificity, selector depth | arithmetic | compute in code |
| "Too many" of anything: nesting, parameters, `!important` | counting | count in code |
| Breakpoint consistency, spacing scale adherence | numeric comparison | compare in code; ask Jev only about the explaining comment |
| Unused variables, unreachable code, type errors | exact analysis already exists | ESLint, TypeScript |
| Data flow across functions or files | multi-hop indirection | static analysis, or a reasoning model on escalation |
| Writing the fix: better alt text, a better name | generation | pass `review` findings to a generative model |
| Classifying a whole file in one request | large state loses accuracy; see findings §1 | one candidate per request |
| Linting untrusted third-party markup as a gate | state can steer the answer | treat results as advisory |
