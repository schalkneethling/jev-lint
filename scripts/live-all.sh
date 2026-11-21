#!/bin/sh
# Everything that needs Jev, in one process, so that the API key is resolved once.
#
#   pnpm exec varlock run -- sh scripts/live-all.sh [out-dir]
#
# The key comes from 1Password, which only answers while the machine is unlocked, and a run needs it only
# at the start. Chaining the steps here means one unlock is enough for all of them, even if the screen
# locks again while they run. Every answer is cached, so a step that is repeated later costs nothing.
#
# Each step writes its own log to the out-dir and the script carries on if one fails: a rate limit on the
# second corpus must not lose the first.
out="${1:-live-logs}"
mkdir -p "$out"
step() {
  name="$1"; shift
  echo "== $name"
  if "$@" > "$out/$name.log" 2>&1; then echo "   ok"; else echo "   FAILED, see $out/$name.log"; fi
}

# 1. Every rule, experimental ones included, on the corpus the rules were shaped against.
step classify-corpus-code node scripts/corpus/classify.ts --corpus corpus-code
cp corpus-code/classifications.json corpus-code/classifications-live.json 2>/dev/null

# 2. The same on the corpus nothing has been tuned against.
step classify-corpus-code-2 node scripts/corpus/classify.ts --corpus corpus-code-2
cp corpus-code-2/classifications.json corpus-code-2/classifications-live.json 2>/dev/null

# 3. Recall against the defects reviewers found by reading, per corpus.
step recall-corpus-code node scripts/panel/mined-recall.ts --corpus corpus-code --misses
step recall-corpus-code-2 node scripts/panel/mined-recall.ts --corpus corpus-code-2 --misses

# 3b. The same defects as a gold set: does each rule's probability rank a flagged candidate above an unflagged one?
step gold-corpus-code node scripts/panel/gold.ts --corpus corpus-code
step gold-corpus-code-2 node scripts/panel/gold.ts --corpus corpus-code-2

# 4. The demo project: default rules, every rule, and every rule with an empty config in place of its own
#    (no conventions, no ignore glob, no rules switched on, no custom rule).
step demo-default node src/cli.ts examples/demo --evidence
step demo-experimental node src/cli.ts examples/demo --experimental --evidence
step demo-no-config node src/cli.ts examples/demo --experimental --evidence --config scripts/empty.config.ts

# 5. The author's fixtures: a prompt that fails these is broken, whatever the corpus says.
step eval-fixtures node scripts/eval.ts --isolation candidate

echo "done"
