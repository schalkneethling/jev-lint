# Instructions for confirming jev-lint findings

jev-lint narrows a codebase to a short list of places worth a look. Jev sees the candidate's own words (a
function, a test, a comment and the code under it) and never the rest of the file, so about three findings
in ten are something a reviewer wants raised ([findings §32](findings.md)). The rest are settled by a fact
that sits elsewhere: an enclosing `describe`, a sibling function, a framework's behaviour.

A model that can open files can settle them. There are two ways to have one do it.

## Built in: `--verify`

```bash
pnpm exec varlock run -- node src/cli.ts path/to/project --experimental --verify
```

`--verify` hands the findings to a second reader and reports only those it confirms, each with the reader's
reason. The reader is Claude Code run without a terminal (`claude --print`), so Claude Code must be
installed and signed in; it needs no API key of its own. How it works:

```
Jev's findings ──► batches of up to 20 ──► reader ──► true and worth raising? ──► yes: reported, with the reason
                   (each with ±150 lines            (may open other files)        no:  left out, listed under
                    of its file's source)                                              "rejected" in the JSON report
```

- **The source is in the prompt.** Each batch carries the 150 lines on either side of every finding. In a
  trial without it, a reader that had the tools to open files answered twenty findings without opening one.
- **The reader can only read.** It gets three tools (read a file, search file contents, list files) and is
  confined to the linted directory, because the project it reads is untrusted input.
- **Nothing is dropped without a verdict.** When the reader fails or skips a finding, the finding is
  reported as Jev left it and the summary counts it as not verified.
- **Verdicts are cached** in `.jev-lint-cache/verdicts`, keyed by the finding and its file's source. A verdict
  that turned on a different file does not notice that file changing; `--no-cache` asks again.
- `--verify-model haiku`, with or without `--verify` beside it, uses the cheaper reader. Through `--verify` it scored as well as Sonnet (see below).
- The exit status is 1 only when a finding that is still reported is an error.

## By hand: your own coding agent

Write a JSON report and hand it to the agent with the reader's instructions,
[src/engine/verify-instructions.md](../src/engine/verify-instructions.md), which are the same ones `--verify` sends:

```bash
pnpm exec varlock run -- node src/cli.ts path/to/project --experimental --format json --output jev-findings.json
```

`--output` matters here: when the run exits with status 1, Varlock prints a line to standard output that
would otherwise end up inside the JSON.

The report is `{ "elements": [...], "stats": {...} }`. Each element has `file`, `line`, `column`, `snippet`
and a list of `findings`, each with `rule`, `severity`, `probability`, `message` and `checked` (the exact
words Jev was shown). Tell the agent not to lean on `probability` or `severity`: they say how sure Jev was of
words it read out of context, and in three blind rounds they did not separate right reports from wrong ones.

## What to expect

`--verify` was run once over the third and fourth corpora (969 files, 180 findings with `--experimental`), and
what it kept was scored against the blind panel's labels for the 159 findings the panel had labelled
([findings §33](findings.md)):

| Reader | Findings with panel labels | Kept | Kept and right by the panel | Of the panel's 56 right findings, kept |
| --- | --- | --- | --- | --- |
| None | 159 | 159 | 56 (35%) | 56 |
| `--verify` (Sonnet) | 159 | 53 | 45 (85%) | 45 (80%) |
| `--verify --verify-model haiku`, first run | 159 | 61 | 50 (82%) | 50 (89%) |
| `--verify --verify-model haiku`, second run | 159 | 56 | 48 (86%) | 48 (86%) |

The Sonnet run took about a minute per corpus and Claude Code put its cost at about $2 for both. Each Haiku
run cost between $0.05 and $0.13 for both. On these corpora Haiku was right as often as Sonnet and kept more
of the right findings, which is not what the by-hand trial below found, where the Haiku agent was right on
71%. The difference between the two set-ups is that `--verify` puts the source in the prompt. Read the 85% with two
cautions. The instruction that a duplicate finding is decided on its own merits was added after a first run
on these same corpora showed the reader rejecting duplicates, so the number is not from unseen data. And
it is one run: a first run of the fourth corpus kept 15 and a second kept 19.

Before `--verify` existed, coding agents were handed the report by hand.

Measured on 187 reports from two corpora no rule was tuned against, and scored against two blind labellers
(one Opus, one Fable) who had read the same files ([findings §32](findings.md)):

| Reader | Kept | Kept and right by the labellers | Of the 57 right reports, kept |
| --- | --- | --- | --- |
| None | 187 | 57 (30%) | 57 |
| Haiku | 75 | 53 (71%) | 53 (93%) |
| Sonnet | 44 | 40 (91%) | 40 (70%) |

Those readers were coding agents handed the report by hand. Hand an agent a few dozen findings at a time:
agents given about 100 each gave one shared sentence as the reason for most rejections, which suggests they
skimmed.

`--min-probability <p>` makes the list longer by reporting, for review, everything Jev scored at `p` or
above. In one trial at 0.25 that was six times the reading for about a third more kept findings, so the
default thresholds are the better starting point.
