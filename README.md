# jev-lint

A spike exploring semantic linting with [Jev](https://docs.typesafe.ai/), TypeSafe's System One model.
It reports problems that depend on what words mean, which pattern-matching linters cannot see:

```
fixtures/html/label-input-type/bad/form.html
  11:7     error  Field "Postal code" asks for a free text value, which suggests type="text", but the input is type="number".  label-input-type p=1.00

fixtures/html/link-text-purpose/bad/generic.html
  6:62     error  Link text "click here" does not describe where the link goes.  link-text-purpose p=0.98
```

HTML (nine rules) and JavaScript/TypeScript (ten rules) are implemented. CSS is probed and catalogued.

Three of the JS/TS rules run by default. The other seven are opt-in: a blind panel of labellers called
fewer than half of their errors and warnings right on code they were not tuned against. See
[Which rules run](#which-rules-run).

- [docs/findings.md](docs/findings.md): what worked, what did not, cost, and the rules of thumb that came out of it.
- [docs/rule-catalog.md](docs/rule-catalog.md): rule ideas with their status.
- [Design doc](https://claude.ai/code/artifact/063b1959-d80e-4620-916a-7c822cebfcb2): what is novel here, the question families, and the decisions taken.

It is for developers and coding agents, run from a command or in CI. A finding therefore carries what
was checked and why it was reported, so the reader can act without repeating the classification. Fixing is out of scope.

```
  10:43    <a href="/blog/1" aria-label="Read more link">Read more</a>
    error  aria-label "Read more link" does not tell this "Read more" control apart from the others; name what it applies to.
           The nearest heading is "Postgres migration".
           jev   visible_text_specific: 0.02
           jev   adds_subject: 0.03
           code  controls_with_same_visible_text: 3
```

## How it works

```
file → parser → rule.select()    small candidates with source locations; code decides what it can
              → rule.questions() atomic Nouls and Choices per candidate, one request each; a question
                                 code knows is moot for this candidate is not asked
              → Jev              probabilities, cached on disk
              → rule.assess()    combines the answers with facts code withheld into one violation probability
              → thresholds       error / warn / review
              → report           findings grouped per element, with evidence
```

Parsers do as much as they can. HTML goes through parse5, from a file or from a page rendered by Playwright.
JSX in a JS or TS file is read into the same element shape, so every HTML rule also runs on React source and
reports `file:line`; anything computed at run time is marked and never classified.
With `--axe`, each finding also says what axe concluded about the same element; when axe passed the form
of something whose meaning fails, the finding is marked **valid but false**. JS and TS go through tree-sitter, where a
language is a grammar plus one query file (`src/code/queries/javascript.scm`); rules read functions,
comments, and tests, never a syntax tree, so another language needs no new rules. Jev is asked only what
is left, and rules that classify the same words share one request.

A rule is one file in `src/rules/html/` or `src/rules/code/`. The contract is in `src/engine/types.ts`.

## Setup

Requires Node 24, pnpm, the 1Password CLI (`op`) with desktop app integration, and a TypeSafe API key.
[Varlock](https://varlock.dev) reads the key from 1Password at run time as declared in `.env.schema`, so it
is never written to disk. Change the `op://` reference there to point at your own item.

```sh
pnpm install
pnpm exec varlock load   # confirms the key resolves
```

1Password answers only while the machine is unlocked, and a run needs the key only when it starts. For
several live steps in a row, chain them in one process so that one unlock covers them all:

```sh
pnpm exec varlock run -- sh scripts/live-all.sh   # classifies both code corpora, measures recall, lints the demo, runs the fixtures
```

## Use

```sh
pnpm lint path/to/project              # every HTML, JS and TS file under a directory
pnpm lint page.html --rule link-text-purpose --rule alt-text-quality
pnpm lint https://example.com          # a rendered page, through Playwright
pnpm lint --axe full-report.json       # every page in an axe-aggregate-reporter report, joined per element
pnpm lint src --format html --output report.html
pnpm lint src --evidence               # show Jev's measurements and code's facts under each finding
pnpm lint src --format json            # for coding agents and CI: elements → findings → checked, measurements, facts
pnpm lint page.html --no-cache
pnpm lint page.html --isolation rule   # batch candidates; less accurate, see findings
pnpm lint path/to/project --changed            # only what overlaps uncommitted changes
pnpm lint path/to/project --since origin/main  # only what changed since the branch left main, as a pull request shows it
pnpm lint path/to/project --since origin/main --format github   # annotations on the pull request, from a GitHub Actions job
pnpm lint path/to/project --experimental       # also run the opt-in rules
pnpm lint path/to/project --min-probability 0.3 # a longer list, for a second reader to confirm
pnpm lint path/to/project --verify             # keep only what a second reader confirms after reading the file
pnpm lint path/to/project --baseline jev-lint-baseline.json   # only findings the baseline does not record
```

Exit code 1 when any finding is an error.

Jev answers with a probability and cannot say what the code does instead of what the words claim. So a
finding about a function, a comment or a test shows the code the words were compared with, a few lines of
it, under the message. `--verify` goes further: the second reader's reason names the code that decided it.

```
  9:8      function listItems
    error  The documentation of "listItems" says something the function does not do: "Returns every item in the cart, including items that are out of stock."
           The function: return cart.items.filter((item) => item.inStock);
           confirmed  The doc says out-of-stock items are included, but `listItems` filters on `item.inStock`.
```

`path/to/project` need not be this repository. The config file and its ignore globs are read from the first
directory given; changed lines are read from each directory given.

### Which rules run

| Rule | Default | What it reports |
| --- | --- | --- |
| `function-name-matches-body` | opt-in | A `get…`, `is…`, `parse…` or similar function with a side effect its name does not suggest, or one named for an answer that returns none. |
| `test-title-matches-body` | opt-in | A test whose assertions do not check what its title claims. |
| `doc-matches-function` | yes | A comment directly above a function (JSDoc or not) whose summary says something the function does not do. |
| `test-assertions-can-fail` | yes, no Jev | A test that asserts only constants, or whose assertions all sit inside an `if`. |
| `boolean-name-holds-boolean` | yes, no Jev | A variable named `is…`, `has…`, `should…`, `can…`, `was…` or `did…` that plainly holds a string, number, object or array. |
| `comment-describes-code` | opt-in, experimental | A comment that states something the code it heads contradicts. |
| `swallowed-error-justified` | opt-in, experimental | An empty `catch` or `.catch(() => {})` with nothing nearby showing why that is safe. |
| `error-message-matches-guard` | opt-in, experimental | A thrown message that does not match the condition that throws it. |
| `test-title-matches-body-next` | opt-in, experimental | A rewrite of the test rule that reads the enclosing `describe` titles. |
| `doc-matches-function-next` | opt-in, experimental | A rewrite of the doc rule that sends the whole doc comment, its `@param` and `@returns` text included. |

A rule is in the default set when a blind panel of labellers has called its errors and warnings right at
the thresholds it ships with, or when it reports only what the parser decides for certain
([findings §25 and §28](docs/findings.md)).
An opt-in rule joins it the same way.
Three blind rounds on code that no rule was tuned against have not put any rule there
([findings §31 and §32](docs/findings.md)). Pooled over those rounds, the best three rules
(`test-title-matches-body`, its rewrite, and `doc-matches-function-next`) were right on 47 to 48% of their
errors and warnings, and one rule's score swung from 17% to 75% between corpora, so no single round decides
a rule. `doc-matches-function` stays in the default set on 2 of 5. Treat every report as a place to look,
and see [Confirming findings with a second reader](#confirming-findings-with-a-second-reader).
`--experimental` runs them all; `--rule <id>` runs one; a config file can turn any of them on.

### Confirming findings with a second reader

Jev reads a candidate's own words and never the rest of the file, so a finding is a place to look, not a
verdict: on code no rule was tuned against, about three in ten are something a reviewer wants raised. A
model that can read the file settles most of the rest, and `--verify` runs one:

```bash
pnpm lint path/to/project --experimental --verify
```

`--verify` hands each finding, with the source around it, to Claude Code run without a terminal
(`claude --print`, read-only tools, Sonnet unless `--verify-model` names another model), and reports only the
findings that reader calls true and worth raising, each with its reason. Claude Code must be installed and
signed in. A finding the reader could not answer is still reported, and counted as not verified.

On two corpora with blind panel labels, Jev alone was right on 56 of 159 findings (35%); `--verify` kept 53,
of which 45 were right (85%), and kept 45 of the 56 right ones. One instruction was added after a first
run on the same corpora, so that is not a number from unseen data.
[docs/verify-findings.md](docs/verify-findings.md) has how it works, the cautions, and how to hand the
findings to your own coding agent instead.

### Changed lines only

`--changed` and `--since <ref>` classify only the candidates whose lines overlap a change. A candidate's
lines are everything its words come from: a comment and the code it heads, a whole function, a whole test.
So a comment is classified again when the code under it changes, which is exactly when it goes stale.
Unchanged files are not read, and untracked files count as changed in full.

### Switching a finding off

```ts
// jev-lint-disable-next-line function-name-matches-body -- pruning stale carts on read is deliberate
function isEmpty(cart) {
  return checkAndPrune(cart);
}

const isLarge = size > 20 ? "large" : ""; // jev-lint-disable-line

/* jev-lint-disable comment-describes-code */   // the whole file
```

A directive goes where the finding is reported: above a function's declaration (or its doc comment), above
a comment, above a `try`. Rule ids are separated by commas; with none, every rule is switched off. Text
after ` -- ` is the reason. A directive must open its comment, and one whose rule list cannot be read (ids
separated by spaces, a reason without ` -- `) is ignored. In HTML the same directives go in `<!-- -->`.

### Adopting it on an existing project

```sh
pnpm lint path/to/project --write-baseline path/to/project/jev-lint-baseline.json   # record today's findings
pnpm lint path/to/project --baseline path/to/project/jev-lint-baseline.json         # from then on: only new ones
```

A finding is identified by its rule, its file, and the words that were classified, not by its line. Moving
code keeps it in the baseline. Changing the comment, the name, or the body takes it out, because a finding
about words that have changed is a new finding. File paths are relative to the baseline file, so keep it in
the project. `--write-baseline` records a full run and refuses `--changed`, `--since`, `--rule` and
`--cache-only`, which would each record only part of one.

### Config file

`jev-lint.config.ts` (or `.mts`, `.mjs`, `.js`) in the directory being linted, or `--config <file>`.
Everything in it is optional. [examples/demo](examples/demo) has one that uses all four fields.

```ts
// `defineConfig` only adds type checking. Import it by path from this checkout, or export a plain object.
import { defineConfig } from "../jev-lint/src/config.ts";

export default defineConfig({
  // Never linted. Globs are relative to the linted directory.
  ignore: ["vendor/**", "**/*.generated.ts"],

  // Conventions of this codebase, given to Jev as facts by the rules that can use them.
  conventions: ["get* functions may cache their result on the object they are given."],

  // Built-in rules: "off", "on" for an opt-in rule, or thresholds of your own.
  rules: {
    "comment-describes-code": "on",
    "test-title-matches-body": { error: 0.97 },
  },

  // Your own rules: one yes/no classification over something the parser already extracts.
  custom: [
    {
      id: "test-title-names-behaviour",
      on: "tests",
      ask: "{title} is the title of an automated test. Does the title name a specific behaviour of the code under test?",
      criteria: { true: "It says what the code does or should do in some situation.", false: 'It names no behaviour: "works", "test 1", or only a function name.' },
      reportWhen: "no",
      message: 'Test title "{title}" does not say what behaviour is being tested.',
    },
  ],
});
```

A custom rule names the fields it asks about in braces, and only those fields are sent.

| `on` | Fields |
| --- | --- |
| `functions` | `name`, `body`, `documentation`, `parameters` |
| `comments` | `comment`, `code` |
| `tests` | `title`, `suite`, `body` |
| `guards` (an `if` that only throws, or `assert(check, "message")`, whose condition is the check negated) | `condition`, `error_message` |
| `catches` (an ignored error) | `code_that_can_fail`, `comment_in_handler`, `comment_above`, `statement_before`, `statement_after` |

`where: { name: /^use[A-Z]/ }` narrows a rule in code before anything is asked. `reportWhen: "no"` reports
when the answer is no. A full rule built with `defineCodeRule` can go in `custom` too.

### A house style is one finding

When five or more functions share a prefix in one run and at least half of them are reported (four of five
`get…` functions mutate their argument), `function-name-matches-body` reports them once per file at review level
and says so: that is a convention to declare under `conventions`, or a habit to change, and not five defects.

```sh
pnpm test        # offline unit tests
pnpm eval        # live: precision and recall per rule against fixtures/, per isolation mode
pnpm typecheck
```

### Measuring a rule

Fixtures written by a rule's author show that a prompt is sound and nothing more. A rule is measured on
code nobody here wrote, by labellers who do not know what the tool concluded:

```sh
pnpm corpus:classify --corpus corpus-code              # live: every rule over the corpus, every classification kept
pnpm panel:draw --round 4 --corpus corpus-code         # a blind sample, never repeating words an earlier round drew
# hand each items-<n>.json to model labellers with scripts/panel/labeller.md (one Opus, one Fable per chunk)
pnpm panel:score --round 4 --corpus corpus-code        # precision per rule, per labeller and by consensus
pnpm panel:recall --corpus corpus-code                 # how many independently found defects were reported
pnpm panel:gold --corpus corpus-code                   # per rule: do its probabilities rank a real defect above an unflagged candidate?
```

The panel is a faster stand-in for the human label bench, and stricter than it: an item counts as right
only when both labellers say the claim is true and that a reviewer would want it raised.
`node scripts/panel/reselect.ts` scores a change to what a rule selects, or to its thresholds, without
asking Jev anything. `panel:gold` needs no labelling at all: it uses the defects reviewers found by reading
(`scripts/panel/miner.md`, each put to a second reviewer following `verifier.md` and kept unless refuted) as
positives and
everything else they read as negatives, so it can be rerun
after every change to a question.

Where things stand: over three corpora that nothing was tuned against, a blind panel called 56 of 161
errors and warnings right (35%), and no rule that asks Jev reached half. What Jev does reliably is narrow:
15,560 candidates in 1,527 files became 532 reports for about $0.55, and a reader who opens the file settles
those. [Findings §31 and §32](docs/findings.md).

`fixtures/<html|code>/<rule-id>/bad/` holds files in which every candidate should be reported, and `good/` files in
which none should.
