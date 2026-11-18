// Wraps text written by someone outside the system in a tag, so a model can tell it apart from its
// instructions. Tags of the same name inside the text are removed, and the opening bracket of any
// tag that the removal joins back together is escaped, so the text cannot close the wrapper early.
// Both are single passes: the time grows with the length of the text, whatever it contains.
export function wrapUntrusted(text: string, tag = "message"): string {
  const tags = new RegExp(`</?${tag}\\b[^<>]*>`, "gi");
  const rebuilt = new RegExp(`<(?=/?${tag}\\b)`, "gi");
  const content = text.replaceAll(tags, "").replaceAll(rebuilt, "&lt;");
  return `<${tag}>\n${content}\n</${tag}>`;
}
