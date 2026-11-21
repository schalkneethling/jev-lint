// What a labeller is asked to confirm must read the same whether or not the tool agreed. Most rules'
// messages already do. Where a message names the model's reading, gives advice, or reveals which path
// decided it, the claim is stated here from the facts alone. Both the human label bench
// (`sample.ts`) and the panel of model labellers (`scripts/panel/draw.ts`) show these.
export interface Claimed {
  rule: string;
  message: string;
  checked: Record<string, unknown>;
  facts: Record<string, string>;
}

const CLAIMS: Record<string, (j: Claimed) => string> = {
  // The rule's message names the model's reading of the label, which for an unreported item came out as
  // 'asks for an email value, but the input is type="email"': a claim nobody made.
  "label-input-type": (j) => `Field "${j.checked.label ?? j.checked.placeholder}" has type="${j.facts.type}", and that type does not suit what the field asks for.`,
  // The rule's own message ends "Say why, or remove it", which is advice to an author rather than something
  // a labeller can call true or false.
  // Two messages, one for a handler holding a comment and one for a handler holding nothing, would tell a
  // labeller how the tool read it. One wording, stated from the facts, for both. The field was called
  // `comment_in_empty_catch` in samples drawn before the lines around the handler became part of the candidate.
  "swallowed-error-justified": (j) => {
    const comment = j.checked.comment_in_handler ?? j.checked.comment_in_empty_catch;
    return comment
      ? `Nothing in or around this handler shows why ignoring the error is safe: its only comment is "${comment}".`
      : "Nothing in or around this handler shows why ignoring the error is safe: it holds no comment at all.";
  },
};

export const claimOf = (j: Claimed): string => CLAIMS[j.rule]?.(j) ?? j.message;
