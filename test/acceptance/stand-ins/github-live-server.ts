// A whole server, run from source, whose GitHub is live against a stand-in for GitHub's API: the
// App installed on an org of the stand-in's, with every repository. For the acceptance tests that a
// step live mode can't do skips its test: nothing reaches GitHub, and no credential is real.
import { homeDir } from "../../../server/src/core/home/index.ts";
import { start } from "../../../server/src/serve.ts";
import { githubStub } from "../../../server/test/github-live-stub.ts";

const github = githubStub();
// A person whose token the test has (`CHANNELSTACK_GITHUB_USER_<LOGIN>_TOKEN`) is in the org, and
// acts as themselves.
for (const [name, token] of Object.entries(process.env)) {
  const login = /^CHANNELSTACK_GITHUB_USER_(.+)_TOKEN$/.exec(name)?.[1];
  if (login && token) github.person(login.toLowerCase().replaceAll("_", "-"), { token });
}
const running = await start({
  version: "0.0.0",
  home: homeDir(),
  portless: false,
  port: 0,
  serverFile: undefined,
  seed: 1,
  logLevel: "warn",
  webhooks: {},
  env: {
    ...process.env,
    CHANNELSTACK_GITHUB_APP_ID: String(github.app.id),
    CHANNELSTACK_GITHUB_PRIVATE_KEY: github.privateKey,
    CHANNELSTACK_LIVE_GITHUB_ORGS: github.org,
  },
  platforms: { fetch: github.fetch, apiBase: { github: github.url } },
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    running.stop().then(() => process.exit(0));
  });
}
