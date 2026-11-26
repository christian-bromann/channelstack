/**
 * What the email reference agents answer, written once: scripted, from an email's subject and its
 * first line, so tests can rely on what they say.
 */
export function scriptedAnswer(subject: string, text: string): string {
  const first =
    text
      .split("\n")
      .find((line) => line.trim() !== "" && !line.startsWith(">"))
      ?.trim() ?? "";
  if (/invoice/i.test(text)) return "Your invoice is attached to your account page.";
  if (/refund/i.test(`${subject} ${text}`)) return "Your refund was sent today; it arrives in 3 to 5 days.";
  return `Thanks for your email about "${subject}". You wrote: ${first}`;
}
