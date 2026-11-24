import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { connect, createServer } from "node:tls";

import { afterEach, describe, expect, test } from "vitest";

import { caDir, type Leaf, loadCa, rotateCa, signLeaf } from "./index.ts";

const HOSTS = ["slack.com", "files.slack.com", "api.github.com", "api.linear.app", "api.notion.com"];
const homes: string[] = [];
const home = () => {
  const dir = mkdtempSync(join(tmpdir(), "channelstack-ca-"));
  homes.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A real TLS handshake: a server with `leaf`, a client that trusts only `ca` and asks for `host`. */
async function handshake(leaf: Leaf, ca: string, host: string): Promise<string> {
  const server = createServer({ cert: leaf.cert, key: leaf.key }, (socket) => socket.end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await new Promise<string>((resolve) => {
      const socket = connect({ host: "127.0.0.1", port, servername: host, ca: [ca] }, () => {
        socket.end();
        resolve("trusted");
      });
      // OpenSSL says which check failed in the message; Node gives no code for this one.
      socket.on("error", (error) => resolve(error.message));
    });
  } finally {
    server.close();
  }
}

/** The CA's private key, as only a test may read it. */
const caKey = (dir: string) => (JSON.parse(readFileSync(join(caDir(dir), "ca.json"), "utf8")) as { key: string }).key;

describe("exit check 6.3: the CA is contained", () => {
  test("a certificate the CA issues for a routed host is trusted by a client that trusts the CA", async () => {
    const ca = await loadCa(home(), HOSTS);
    expect(await handshake(await ca.issue(["slack.com", "api.github.com"]), ca.cert, "slack.com")).toBe("trusted");
    expect(await handshake(await ca.issue(["api.github.com"]), ca.cert, "api.github.com")).toBe("trusted");
  });

  test("the name constraints reject a certificate for any host outside the routed list, even one signed with the CA's key", async () => {
    const dir = home();
    const ca = await loadCa(dir, HOSTS);
    const key = caKey(dir);
    for (const outside of ["example.com", "github.com", "evil-slack.com", "slack.com.evil.example", "notion.so"]) {
      const forged = await signLeaf({ cert: ca.cert, key }, [outside]);
      expect(await handshake(forged, ca.cert, outside)).toBe("permitted subtree violation");
    }
    // A routed name next to one outside: the whole certificate is refused.
    const mixed = await signLeaf({ cert: ca.cert, key }, ["slack.com", "example.com"]);
    expect(await handshake(mixed, ca.cert, "slack.com")).toBe("permitted subtree violation");
  });

  test("the CA itself refuses to issue for a host outside the routed list", async () => {
    const ca = await loadCa(home(), HOSTS);
    await expect(ca.issue(["example.com"])).rejects.toThrow(/vouches only for slack\.com/);
    await expect(ca.issue(["slack.com", "evil.example"])).rejects.toThrow(/not evil\.example/);
    await expect(ca.issue([])).rejects.toThrow();
  });

  test("its files are private and only in <home>/ca: never in a system trust store", async () => {
    const dir = home();
    const ca = await loadCa(dir, HOSTS);
    const files = readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
      .sort();
    expect(files).toEqual(["ca/bundle.pem", "ca/ca.json", "ca/ca.pem"]);
    for (const file of files) expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600);
    expect(statSync(caDir(dir)).mode & 0o777).toBe(0o700);
    expect([ca.caFile, ca.bundleFile].every((path) => path.startsWith(caDir(dir)))).toBe(true);
    // The bundle is the public roots and the CA: a runtime that replaces its bundle still reaches every other host.
    expect(readFileSync(ca.bundleFile, "utf8").trim().endsWith(ca.cert.trim())).toBe(true);
    expect(readFileSync(ca.bundleFile, "utf8").split("BEGIN CERTIFICATE").length).toBeGreaterThan(100);
  });

  test("no code in the server touches a system trust store", () => {
    const root = join(import.meta.dirname, "..", "..");
    const sources = readdirSync(root, { recursive: true, withFileTypes: true }).filter(
      (entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"),
    );
    const stores =
      /add-trusted-cert|update-ca-certificates|update-ca-trust|certutil|\/etc\/ssl|\/etc\/pki|\/usr\/local\/share\/ca-certificates|Keychains|trust anchor/;
    const touching = sources.filter((entry) => stores.test(readFileSync(join(entry.parentPath, entry.name), "utf8")));
    expect(touching.map((entry) => entry.name)).toEqual([]);
  });

  test("the CA is kept across starts, and replaced when rotated or when the routed hosts change", async () => {
    const dir = home();
    const first = await loadCa(dir, HOSTS);
    expect((await loadCa(dir, HOSTS)).cert).toBe(first.cert);
    const rotated = await rotateCa(dir, HOSTS);
    expect(rotated.cert).not.toBe(first.cert);
    expect((await loadCa(dir, HOSTS)).cert).toBe(rotated.cert);
    expect((await loadCa(dir, [...HOSTS, "uploads.github.com"])).cert).not.toBe(rotated.cert);
  });
});
