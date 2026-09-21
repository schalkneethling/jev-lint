# Jev as a conditional

Status: **proposal**. Nothing here is built. It sketches how a classification can decide what the linter
does next, and what has to be true so that a wrong branch is never silent.

## Why

Today every rule is one round: code selects candidates, Jev classifies each once, code combines the answers.
Code decides every branch, and where code cannot know, it guesses with a pattern: `/search/` for "is this a
search box", a name regex for "is this an event handler", a comment's first word for "is this a directive".
Each of those is a classification wearing a regex.

A request costs about 260 tokens of overhead plus about 180 per question (findings §1). At $0.042 per million
input tokens, a thousand extra classifications cost about two cents, and the answers are cached by
(model, state, question) like every other. Asking is cheap enough to be an `if`.

## Two kinds of branch

They are different tools, and most cases are the first.

**The branches share their state: ask them all at once.** Questions in one request run in parallel and
cannot see each other; output is free. Send the router and every branch's question together, and let code read
the branch that applies. One round trip, and the unused answers cost only their question text.

**The branch changes the state: ask again.** A second request is warranted only when the first answer
decides what to extract, how much of it to send, or which classes exist. "This comment describes behaviour"
changes nothing about the state. "This classification is uncertain, so fetch the whole function instead of
its first lines" does.

## Three constructs

### 1. A router: one shared classification, read by several rules

`comment-describes-code` carries its own gate today (`describes_behaviour`), `comment-gives-reason` asks what
is nearly its inverse (`only_restates`), and a regex of first words filters out directives, TODOs and licence
headers before either. One Choice can serve all three purposes, and any later comment rule.

```ts
// Proposal. `defineRouter` does not exist yet.
export const commentKind = defineRouter({
  id: "comment-kind",
  target: "code",
  select: (doc) => commentCandidates(doc),
  question: (ref) =>
    choice(`${ref("comment")} is a comment in source code. What kind of comment is it?`, {
      gives_reason: "It says why the code is the way it is: a constraint, a trade-off, a bug being worked around.",
      describes_behaviour: "It says what the code under it does or returns.",
      todo: "It records work still to be done.",
      disabled_code: "It is code that has been commented out.",
      other: "None of the above: a licence header, a section divider, a directive for a tool, or anything else.",
    }),
});
```

A rule names the router it reads, and gets the whole distribution, not just the winning class:

```ts
export default defineCodeRule({
  id: "comment-describes-code",
  route: commentKind,
  // Asked in the same request as the router, because the state is the same.
  questions: (ref) => ({ accurate: noul(`… Is what ${ref("comment")} says true of ${ref("code")}?`) }),
  // Soft: the router's probability is carried, so a router that is 60% sure costs 40% of p, not the finding.
  assess: ({ accurate }, candidate, route) => ({
    p: route.probabilities.describes_behaviour * (1 - accurate.noul),
    message: `…`,
  }),
});
```

`route` is typed from the router's classes, so `route.probabilities.describes_behavior` (a typo) is a compile
error, and a `switch (route.choice)` is checked for exhaustiveness. This is the point of treating Jev as a
classification engine with a typed schema as its return type: the branch is as safe as one over an enum.

### 2. A predicate inside `select`

Where extraction itself needs a classification, `select` may ask:

```ts
// Proposal. `select` is synchronous today; this makes it async and hands it `classify`.
select: async (doc, { classify }) => {
  const fields = textInputs(doc);
  const kinds = await classify(fields, (ref) => ({
    is_search: noul(`${ref("label")}, ${ref("placeholder")} and ${ref("name")} describe one form field. Is it a search box?`),
  }));
  return fields.filter((_, i) => (kinds[i]?.is_search.noul ?? 0) < 0.5).map(toCandidate);
},
```

This is a **hard** branch: a field classified as a search box is never seen again. It is allowed only under
the rules in the next section.

### 3. Widen on uncertainty

More context dilutes a classification as often as it helps (findings §18), so the default state stays small.
When the answer lands in the uncertain band, the rule may supply a wider candidate and be asked once more:

```ts
// Proposal. `meta.clipped` and `wholeBody` stand for facts the extractor would have to record.
widen: (candidate, answers) =>
  answers.surprising_side_effect.noul > 0.4 && answers.surprising_side_effect.noul < 0.6 && candidate.meta!.clipped === "yes"
    ? { ...candidate, data: { ...candidate.data, body: wholeBody(candidate) } }
    : undefined,
```

One widening per candidate, never a loop. The finding records both answers.

## What keeps a branch honest

A misrouted candidate vanishes: recall drops and no report shows it. So:

1. **Every router has an `other` class**, and `other` falls through to the rule's default path. A router may
   narrow what is asked; it may not be the only reason something is dropped.
2. **Soft by default.** Where branches share state, carry the probability into `assess`. Go hard only when the
   state must change, or in `select`, and then only above a threshold the router has earned (see 4).
3. **The branch is evidence.** A finding lists the route taken and its probability beside the other
   measurements. `RunStats` counts candidates a hard branch removed, per router, so a jump is visible.
4. **A router is scored like a rule.** It gets its own rows in the label bench ("this comment describes what
   the code does": yes, no, cannot tell), its own precision and recall, and the same test as any rule: do its
   probabilities rank right above wrong? A router that fails it is removed, and the rules fall back to `other`.
5. **Cache-only still works.** A missing router answer leaves the candidate unclassified and counted, exactly
   as a missing rule answer does.

## Engine changes

- `Rule.route?: Router` and a third argument to `assess`. The engine adds the router's question to each of the
  rule's candidate requests; identical (state, question) pairs are already asked once per run and cached, so
  two rules reading one router over the same words pay for it once. This requires the rules to build the same
  state for the same comment, which `commentCandidates` already guarantees.
- `select` may return a promise, and receives `{ classify }`, a function over the same `ask`, cache, in-flight
  de-duplication and pacing as `run` uses. No second client.
- `Rule.widen?` runs after the first answers, at most once.
- `Classification` gains `route?: { router: string; choice: string; probability: number }`; `Finding` shows it;
  `RunStats` gains `routedAway: { [router: string]: number }`.

## First prototype

The comment router, on the code corpus: it replaces two ad-hoc gates with one shared classification, the
corpus supplies candidates by the thousand, and the label bench can score the router on its own rows. It
exercises the soft, shared-state path. `widen` comes second, on `function-name-matches-body`, where the 6,000
character clip is the known pressure point. The `select` predicate comes last: it is the only hard branch,
and it should wait until a router has shown that its probabilities rank.
