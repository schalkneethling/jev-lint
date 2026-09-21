// Does Score hold up? Page profiles and budgets need degrees, not yes-or-no classes. Each probe lists
// items from worst to best; the question is whether Jev's scores come back in that order and
// spread across the scale rather than bunching at the ends.
import { score, TypeSafeClient } from "@typesafe-ai/sdk";
import { MODEL } from "../src/engine/client.ts";

const client = new TypeSafeClient({ defaultModel: MODEL });

const probes = [
  {
    idea: "error message actionability",
    field: "message",
    instructions: "`message` is an error shown to an end user of a website. How well does it help the user recover?",
    levels: [
      "Cryptic: an error code, a stack trace, or technical jargon the user cannot interpret.",
      "Vague: says that something failed, but not what.",
      "Says what went wrong in plain language, but not what the user can do about it.",
      "Says what went wrong in plain language and tells the user what to do next.",
    ],
    worstToBest: [
      "Error: ECONNRESET at TLSSocket.onHangUp (node:_tls_wrap:1625:19)",
      "Error 500",
      "Something went wrong.",
      "An error occurred while processing your request. Please try again later.",
      "Your card was declined.",
      "We couldn't save your changes because you're offline.",
      "Your card was declined. Check the card number and expiry date, or try a different card.",
      "We couldn't save your changes because you're offline. Reconnect and select Save again; your edits are still here.",
    ],
  },
  {
    idea: "alt text usefulness",
    field: "alt",
    instructions: "`alt` is the alt text of a photograph in a news article. How well would it serve a reader who cannot see the image?",
    levels: [
      "Useless: a file name, a placeholder word, or empty of meaning.",
      "Names the general subject only.",
      "Describes the subject and what is happening.",
      "Describes the subject, what is happening, and the detail that makes the image relevant to a story.",
    ],
    worstToBest: [
      "DSC_0042.jpg",
      "photo",
      "A protest",
      "People at a protest",
      "Protesters holding signs march down a city street",
      "Hundreds of protesters holding 'Save our library' signs march past the closed Carnegie branch in the rain",
    ],
  },
  {
    idea: "form instruction clarity",
    field: "instruction",
    instructions: "`instruction` is help text under a password field. How clearly does it tell a first-time user what is required?",
    levels: [
      "States no requirement.",
      "Hints that there are requirements without saying what they are.",
      "States some requirements, but leaves others to be discovered by trial and error.",
      "States every requirement concretely, so the user can succeed on the first try.",
    ],
    worstToBest: [
      "Password",
      "Choose a strong password.",
      "Your password must meet our security requirements.",
      "Must be at least 12 characters.",
      "At least 12 characters, with one number and one symbol. Spaces are allowed.",
    ],
  },
];

for (const probe of probes) {
  const results = await Promise.all(
    probe.worstToBest.map(async (text) => {
      const { answers } = await client.systemOne({
        state: { [probe.field]: text },
        questions: { q: score(probe.instructions, probe.levels as [string, string, ...string[]]) },
      });
      return { text, score: answers.q.score, confidence: answers.q.confidence };
    }),
  );
  const inversions = results.flatMap((a, i) => results.slice(i + 1).filter((b) => b.score < a.score - 0.05)).length;
  const pairs = (results.length * (results.length - 1)) / 2;
  console.log(`\n${probe.idea}: ${pairs - inversions}/${pairs} pairs in the expected order (0 to ${probe.levels.length - 1})`);
  for (const r of results) console.log(`  ${r.score.toFixed(2)}  conf ${r.confidence.toFixed(2)}  ${r.text.slice(0, 95)}`);
}
