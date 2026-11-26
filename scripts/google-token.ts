/**
 * A Gmail account's refresh token for the live sandbox, written straight into `live.env` (in
 * channelstack's state directory, kept 0600) and never printed. It signs in with the agent's OAuth
 * client (a "Desktop app" client, `CHANNELSTACK_GOOGLE_CLIENT_ID` and
 * `CHANNELSTACK_GOOGLE_CLIENT_SECRET` in that file), on a loopback redirect with PKCE and a checked
 * `state`, for the one scope the agent and the people need: reading, labelling and sending mail.
 *
 *   node scripts/google-token.ts CHANNELSTACK_GOOGLE_REFRESH_TOKEN      # the agent's mailbox
 *   node scripts/google-token.ts CHANNELSTACK_GOOGLE_USER_ANA_TOKEN     # Ana's
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";

import { liveEnvPath, parseLiveEnv, setLiveEnv } from "./lib/live-env.ts";

const SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const variable = process.argv[2] ?? "";
if (!/^CHANNELSTACK_GOOGLE_(REFRESH_TOKEN|USER_[A-Z0-9_]+_TOKEN)$/.test(variable)) {
  throw new Error("Say which variable: CHANNELSTACK_GOOGLE_REFRESH_TOKEN or CHANNELSTACK_GOOGLE_USER_<NAME>_TOKEN");
}
const file = liveEnvPath();
const env = parseLiveEnv(existsSync(file) ? readFileSync(file, "utf8") : "");
const clientId = env.get("CHANNELSTACK_GOOGLE_CLIENT_ID");
const clientSecret = env.get("CHANNELSTACK_GOOGLE_CLIENT_SECRET");
if (!clientId || !clientSecret) {
  throw new Error(`Put CHANNELSTACK_GOOGLE_CLIENT_ID and CHANNELSTACK_GOOGLE_CLIENT_SECRET in ${file} first`);
}

const signIn = new OAuth2Client({ clientId, clientSecret });
const { codeVerifier, codeChallenge } = await signIn.generateCodeVerifierAsync();
const state = randomBytes(16).toString("hex");

const code = await new Promise<{ code: string; redirect: string }>((resolve, reject) => {
  let redirect = "";
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const given = url.searchParams.get("code");
    // An answer to another sign-in than this one isn't taken.
    const ours = url.searchParams.get("state") === state;
    response.end(given && ours ? "Signed in: you can close this tab." : "Not this sign-in's answer.");
    server.close();
    if (given && ours) resolve({ code: given, redirect });
    else if (!ours) reject(new Error("Google's answer didn't carry this sign-in's state"));
    else reject(new Error(`Google answered ${url.searchParams.get("error") ?? "without a code"}`));
  });
  server.listen(0, "127.0.0.1", () => {
    redirect = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const link = signIn.generateAuthUrl({
      access_type: "offline",
      // `consent` every time: Google hands out a refresh token only on a consent.
      prompt: "consent",
      scope: [SCOPE],
      redirect_uri: redirect,
      state,
      code_challenge: codeChallenge as string,
      code_challenge_method: CodeChallengeMethod.S256,
    });
    console.log(`Open this, and sign in as the account ${variable} is for:\n\n${link}\n`);
  });
});

const { tokens } = await signIn.getToken({ code: code.code, codeVerifier, redirect_uri: code.redirect });
if (!tokens.refresh_token)
  throw new Error("Google gave no refresh token: remove the app's access in the account, and run this again");
setLiveEnv(file, variable, tokens.refresh_token);
console.log(`Wrote ${variable} to ${file}.`);
