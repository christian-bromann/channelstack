// @peculiar/x509 resolves its parts through tsyringe, which needs the Reflect metadata API first.
import "reflect-metadata";

import { join } from "node:path";
import { rootCertificates } from "node:tls";

import { AsnConvert } from "@peculiar/asn1-schema";
import {
  GeneralName,
  GeneralSubtree,
  GeneralSubtrees,
  id_ce_nameConstraints,
  NameConstraints,
} from "@peculiar/asn1-x509";
import * as x509 from "@peculiar/x509";

import { readPrivateJsonFile, writePrivateFile } from "../home/index.ts";

/** ECDSA P-256 with SHA-256: what every TLS client accepts, and quick to make. */
const ALGORITHM = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;
const DAY_MS = 24 * 60 * 60 * 1000;
/** The CA lasts a year; `channelstack ca rotate` replaces it sooner. */
const CA_DAYS = 365;
/** A leaf certificate is made at each start and lasts as long as a server may run. */
const LEAF_DAYS = 30;

/** Where channelstack's own CA lives: `<home>/ca/`, never anywhere a system trust store reads. */
export function caDir(home: string): string {
  return join(home, "ca");
}

/**
 * The CA's make. A CA made by an earlier one (version 1 let a routed host's subdomains through) is
 * replaced at the next start, like an expired one.
 */
const CA_VERSION = 2;

interface CaFile {
  /** `CA_VERSION` when it was made. */
  version?: number;
  /** The CA certificate, PEM. */
  cert: string;
  /** Its private key, PKCS#8 PEM. Only this file holds it. */
  key: string;
  /** The hosts its name constraints permit, in order. */
  hosts: string[];
}

/** A certificate and its key, PEM, for a TLS listener. */
export interface Leaf {
  cert: string;
  key: string;
}

/**
 * channelstack's own CA for proxy mode (implementation plan 6.2 and 12.6). It is name-constrained
 * to the routed provider hosts: a certificate it signs for any other name fails verification,
 * whoever made it. It is never added to a system trust store; only the agent's environment trusts
 * it (`caFile` for `NODE_EXTRA_CA_CERTS`, `bundleFile` for `SSL_CERT_FILE`).
 */
export interface ProxyCa {
  /** The hosts the CA may vouch for. */
  readonly hosts: readonly string[];
  /** The CA certificate, PEM. */
  readonly cert: string;
  /** `<home>/ca/ca.pem`: the CA alone. */
  readonly caFile: string;
  /** `<home>/ca/bundle.pem`: the public roots and the CA, for runtimes that replace their bundle. */
  readonly bundleFile: string;
  /** A certificate for these hosts, each of which must be one the CA may vouch for. */
  issue(hosts: readonly string[]): Promise<Leaf>;
}

const pemKey = async (key: CryptoKey) =>
  x509.PemConverter.encode(await crypto.subtle.exportKey("pkcs8", key), "PRIVATE KEY");

const importKey = (pem: string) =>
  crypto.subtle.importKey("pkcs8", x509.PemConverter.decodeFirst(pem), ALGORITHM, false, ["sign"]);

const sameHosts = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((host, at) => host === b[at]);

/**
 * Permit exactly these DNS names and no IP address at all. A permitted `slack.com` also permits
 * every name under it, so each host's subdomains are excluded again (`.slack.com`, the leading dot
 * meaning "under it"). Name constraints can't permit a host and one of its subdomains while
 * excluding the others, so routed hosts that nest are refused.
 */
function nameConstraints(hosts: readonly string[]): x509.Extension {
  const nested = hosts.filter((host) => hosts.some((other) => other !== host && host.endsWith(`.${other}`)));
  if (nested.length > 0) {
    throw new Error(
      `channelstack's CA can't vouch for ${nested.join(", ")} without every other name next to it: route only the host above it, or drop ${nested.join(", ")} from its driver's hosts`,
    );
  }
  const under = hosts.map((host) => new GeneralSubtree({ base: new GeneralName({ dNSName: `.${host}` }) }));
  const constraints = new NameConstraints({
    permittedSubtrees: new GeneralSubtrees(
      hosts.map((host) => new GeneralSubtree({ base: new GeneralName({ dNSName: host }) })),
    ),
    excludedSubtrees: new GeneralSubtrees([
      ...under,
      ...["0.0.0.0/0", "::/0"].map((range) => new GeneralSubtree({ base: new GeneralName({ iPAddress: range }) })),
    ]),
  });
  return new x509.Extension(id_ce_nameConstraints, true, AsnConvert.serialize(constraints));
}

async function createCa(hosts: readonly string[], now: number): Promise<CaFile> {
  const keys = await crypto.subtle.generateKey(ALGORITHM, true, ["sign", "verify"]);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    name: "CN=channelstack proxy CA, O=channelstack",
    notBefore: new Date(now - DAY_MS),
    notAfter: new Date(now + CA_DAYS * DAY_MS),
    keys,
    signingAlgorithm: ALGORITHM,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      nameConstraints(hosts),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  return { version: CA_VERSION, cert: cert.toString("pem"), key: await pemKey(keys.privateKey), hosts: [...hosts] };
}

function writeCa(home: string, ca: CaFile): void {
  const dir = caDir(home);
  writePrivateFile(join(dir, "ca.json"), `${JSON.stringify(ca, null, 2)}\n`);
  writePrivateFile(join(dir, "ca.pem"), ca.cert);
  writePrivateFile(join(dir, "bundle.pem"), `${[...rootCertificates, ca.cert.trim()].join("\n")}\n`);
}

/**
 * A certificate for `hosts`, signed by the CA's key. Only for tests of the name constraints and
 * for `ProxyCa.issue`, which checks the hosts first: this function signs whatever it is given.
 */
export async function signLeaf(
  ca: { cert: string; key: string },
  hosts: readonly string[],
  now = Date.now(),
): Promise<Leaf> {
  const issuer = new x509.X509Certificate(ca.cert);
  const signingKey = await importKey(ca.key);
  const keys = await crypto.subtle.generateKey(ALGORITHM, true, ["sign", "verify"]);
  const cert = await x509.X509CertificateGenerator.create({
    subject: `CN=${hosts[0] ?? "channelstack"}`,
    issuer: issuer.subject,
    notBefore: new Date(now - DAY_MS),
    notAfter: new Date(now + LEAF_DAYS * DAY_MS),
    publicKey: keys.publicKey,
    signingKey,
    signingAlgorithm: ALGORITHM,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
      new x509.SubjectAlternativeNameExtension(hosts.map((host) => ({ type: "dns" as const, value: host }))),
      await x509.AuthorityKeyIdentifierExtension.create(issuer.publicKey),
    ],
  });
  return { cert: `${cert.toString("pem")}\n${ca.cert.trim()}\n`, key: await pemKey(keys.privateKey) };
}

/**
 * The install's CA for these hosts: the one in `<home>/ca/`, or a new one when there is none, it
 * has expired, or it was made for other hosts (a driver's hosts changed).
 */
export async function loadCa(home: string, hosts: readonly string[], now = Date.now()): Promise<ProxyCa> {
  const file = readPrivateJsonFile(join(caDir(home), "ca.json")) as CaFile | undefined;
  const current =
    file &&
    file.version === CA_VERSION &&
    sameHosts(file.hosts, hosts) &&
    new x509.X509Certificate(file.cert).notAfter.getTime() > now + LEAF_DAYS * DAY_MS
      ? file
      : await createCa(hosts, now);
  // The files are written each time, so a bundle follows the runtime's roots and modes stay private.
  writeCa(home, current);
  return caOf(home, current);
}

/** `channelstack ca rotate`: a new CA, with a new key, for the same hosts. Agents need the new `ca.pem`. */
export async function rotateCa(home: string, hosts: readonly string[], now = Date.now()): Promise<ProxyCa> {
  const ca = await createCa(hosts, now);
  writeCa(home, ca);
  return caOf(home, ca);
}

function caOf(home: string, ca: CaFile): ProxyCa {
  return {
    hosts: ca.hosts,
    cert: ca.cert,
    caFile: join(caDir(home), "ca.pem"),
    bundleFile: join(caDir(home), "bundle.pem"),
    async issue(wanted) {
      const outside = wanted.filter((host) => !ca.hosts.includes(host));
      if (outside.length > 0 || wanted.length === 0) {
        throw new Error(
          `channelstack's CA vouches only for ${ca.hosts.join(", ")}, not ${outside.join(", ") || "no host"}`,
        );
      }
      return signLeaf(ca, wanted);
    },
  };
}
