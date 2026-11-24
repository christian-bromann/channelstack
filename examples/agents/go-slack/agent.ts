/**
 * Starts the Go reference agent's image in Docker with what `channelstack env --proxy` printed, the
 * way a developer runs a Go agent in proxy mode: the proxy's address as it is (the container shares
 * the host's network), and the CA bundle mounted, since Go reads `SSL_CERT_FILE` only on Linux.
 * Only the bundle file is mounted: the CA's private key, next to it, never enters the container.
 * The scripts start it like any reference agent (`node agent.ts`, with `PORT`); stopping it stops
 * the container.
 */
import { spawn, spawnSync } from "node:child_process";

const IMAGE = "channelstack-go-slack:local";
const { SSL_CERT_FILE, PORT } = process.env;
if (!SSL_CERT_FILE || !PORT)
  throw new Error("Start the Go agent with what `channelstack env --proxy` prints, and PORT");

const name = `channelstack-go-slack-${process.pid}`;
/** Names only: Docker reads each value from this process's environment, so no token is on a command line. */
const passed = ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET", "PORT", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"];
const container = spawn(
  "docker",
  [
    "run",
    "--rm",
    "--name",
    name,
    "--network",
    "host",
    "--volume",
    `${SSL_CERT_FILE}:/etc/channelstack/bundle.pem:ro`,
    "--env",
    "SSL_CERT_FILE=/etc/channelstack/bundle.pem",
    ...passed.flatMap((variable) => ["--env", variable]),
    IMAGE,
  ],
  { stdio: "inherit" },
);
container.on("exit", (code) => process.exit(code ?? 1));

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    spawnSync("docker", ["rm", "--force", name], { stdio: "ignore" });
    process.exit(0);
  });
}
