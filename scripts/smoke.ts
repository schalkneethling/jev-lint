import { noul, TypeSafeClient } from "@typesafe-ai/sdk";

const client = new TypeSafeClient({ defaultModel: "jev-1.13.0" });
const { answers, usage, model } = await client.systemOne({
  state: { link: { text: "click here", href: "/pricing" } },
  questions: {
    descriptive: noul(
      "Does `link.text`, read on its own without `link.href`, tell a user where the link goes or what it does?",
    ),
  },
});

console.log(model, answers.descriptive.noul, usage);
