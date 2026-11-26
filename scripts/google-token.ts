/**
 * A Gmail account's refresh token for the live sandbox, written straight into
 * `~/.channelstack/live.env` (or `$CHANNELSTACK_HOME/live.env`, kept 0600) and never printed.
 * It signs in with the agent's OAuth client (a "Desktop app" client, `CHANNELSTACK_GOOGLE_CLIENT_ID`
 * and `CHANNELSTACK_GOOGLE_CLIENT_SECRET` in that file), on a loopback redirect, for the one scope
 * the agent and the people need: reading, labelling and sending mail.
 *
 *   node scripts/google-token.ts CHANNELSTACK_GOOGLE_REFRESH_TOKEN      # the agent's mailbox
 *   node scripts/google-token.ts CHANNELSTACK_GOOGLE_USER_ANA_TOKEN     # Ana's
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

import { OAuth2Client } from "google-auth-library";

const SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const variable = process.argv[2] ?? "";
if (!/^CHANNELSTACK_GOOGLE_(REFRESH_TOKEN|USER_[A-Z0-9_]+_TOKEN)$/.test(variable)) {
  throw new Error("Say which variable: CHANNELSTACK_GOOGLE_REFRESH_TOKEN or CHANNELSTACK_GOOGLE_USER_<NAME>_TOKEN");
}
const file = join(process.env.CHANNELSTACK_HOME || join(homedir(), ".channelstack"), "live.env");
const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
const value = (name: string) =>
  lines
    .find((line) => line.startsWith(`${name}=`))
    ?.slice(name.length + 1)
    .replace(/^"|"$/g, "");
const clientId = value("CHANNELSTACK_GOOGLE_CLIENT_ID");
const clientSecret = value("CHANNELSTACK_GOOGLE_CLIENT_SECRET");
if (!clientId || !clientSecret) {
  throw new Error(`Put CHANNELSTACK_GOOGLE_CLIENT_ID and CHANNELSTACK_GOOGLE_CLIENT_SECRET in ${file} first`);
}

const code = await new Promise<{ code: string; redirect: string }>((resolve, reject) => {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const given = url.searchParams.get("code");
    response.end(given ? "Signed in: you can close this tab." : "No code in the answer.");
    server.close();
    if (given) resolve({ code: given, redirect });
    else reject(new Error(`Google answered ${url.searchParams.get("error") ?? "without a code"}`));
  });
  let redirect = "";
  server.listen(0, "127.0.0.1", () => {
    redirect = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const auth = new OAuth2Client({ clientId, clientSecret, redirectUri: redirect });
    // `consent` every time: Google hands out a refresh token only on a consent.
    const link = auth.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: [SCOPE] });
    console.log(`Open this, and sign in as the account ${variable} is for:\n\n${link}\n`);
  });
});

const auth = new OAuth2Client({ clientId, clientSecret, redirectUri: code.redirect });
const { tokens } = await auth.getToken(code.code);
if (!tokens.refresh_token)
  throw new Error("Google gave no refresh token: remove the app's access in the account, and run this again");
const kept = lines.filter((line) => line !== "" && !line.startsWith(`${variable}=`));
writeFileSync(file, `${[...kept, `${variable}=${tokens.refresh_token}`].join("\n")}\n`, { mode: 0o600 });
chmodSync(file, 0o600);
console.log(`Wrote ${variable} to ${file}.`);
