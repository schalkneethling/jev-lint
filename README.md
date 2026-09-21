# jev-lint

A spike exploring semantic linting with [Jev](https://docs.typesafe.ai/), TypeSafe's System One model.
It reports problems that depend on what words mean, which pattern-matching linters cannot see:

```
fixtures/html/label-input-type/bad/form.html
  11:7     error  Field "Postal code" asks for a free text value, which suggests type="text", but the input is type="number".  label-input-type p=1.00

fixtures/html/link-text-purpose/bad/generic.html
  6:62     error  Link text "click here" does not describe where the link goes.  link-text-purpose p=0.98
```

HTML (nine rules) and JavaScript/TypeScript (five rules) are implemented. CSS is probed and catalogued.

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
```

Exit code 1 when any finding is an error.

```sh
pnpm test        # offline unit tests
pnpm eval        # live: precision and recall per rule against fixtures/, per isolation mode
pnpm typecheck
```

`fixtures/<html|code>/<rule-id>/bad/` holds files in which every candidate should be reported, and `good/` files in
which none should.
