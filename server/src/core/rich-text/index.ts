/**
 * `RichText`, the text a test writes for a person (`api/common.d.ts`): `@name` mentions the person
 * or app with that name, and `@@` is a literal `@`. Each driver turns the pieces into its
 * platform's own mention (`<@U…>` in Slack, a profile link in Linear, a mention object in Notion).
 */
export type RichTextPiece = { text: string } | { mention: string; name: string };

/**
 * Split `RichText` at its mentions. `lookup` names the id of whoever has a name; a name nobody has
 * stays text, as it was typed. A sentence may end right after the name: "@my-agent." mentions "my-agent".
 */
export function richTextPieces(text: string, lookup: (name: string) => string | undefined): RichTextPiece[] {
  const pieces: RichTextPiece[] = [];
  const push = (piece: string) => {
    if (piece === "") return;
    const last = pieces.at(-1);
    if (last && "text" in last) last.text += piece;
    else pieces.push({ text: piece });
  };
  let from = 0;
  for (const match of text.matchAll(/@@|@([A-Za-z0-9][A-Za-z0-9._-]*)/g)) {
    push(text.slice(from, match.index));
    from = match.index + match[0].length;
    const name = match[1];
    if (name === undefined) {
      push("@");
      continue;
    }
    let found = false;
    for (let end = name.length; end > 0 && !found; end--) {
      const id = lookup(name.slice(0, end));
      if (id === undefined || /[A-Za-z0-9]/.test(name.slice(end, end + 1))) continue;
      pieces.push({ mention: id, name: name.slice(0, end) });
      push(name.slice(end));
      found = true;
    }
    if (!found) push(match[0]);
  }
  push(text.slice(from));
  return pieces;
}
