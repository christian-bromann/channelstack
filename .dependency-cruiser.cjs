/** Architecture boundaries from docs/code-map.md. `pnpm check:deps` fails on any violation. */
module.exports = {
  forbidden: [
    {
      name: "drivers-dont-import-each-other",
      comment: "Shared behaviour moves into server/src/core/.",
      severity: "error",
      from: { path: "^server/src/drivers/([^/]+)/" },
      to: { path: "^server/src/drivers/[^/]+/", pathNot: "^server/src/drivers/$1/" },
    },
    {
      name: "core-doesnt-import-drivers",
      comment: "Drivers register themselves with core (server/src/drivers/index.ts hands them over).",
      severity: "error",
      from: { path: "^server/src/core/" },
      to: { path: "^server/src/drivers/" },
    },
    {
      name: "generated-is-private-to-its-sdk",
      comment: "Nothing imports generated/ except the SDK it belongs to.",
      severity: "error",
      from: { pathNot: "^sdks/typescript/" },
      to: { path: "^sdks/typescript/generated/" },
    },
    {
      name: "sdk-contains-no-server-code",
      comment: "An SDK holds no platform logic: it talks to the server over the protocol only.",
      severity: "error",
      from: { path: "^sdks/", pathNot: "^sdks/typescript/test/integration/" },
      to: { path: "^(server|codegen|scripts)/" },
    },
    {
      name: "codegen-reads-only-the-spec",
      comment: "Emitters read the IR, never the server's code.",
      severity: "error",
      from: { path: "^codegen/" },
      to: { path: "^(server|sdks|scripts)/" },
    },
    {
      name: "server-doesnt-import-sdks",
      severity: "error",
      from: { path: "^server/src/" },
      to: { path: "^(sdks|codegen|scripts|scenarios)/" },
    },
    {
      name: "integrations-and-agents-use-the-public-surface",
      comment: "Test integrations are built on the SDK; reference agents have no channelstack code in them at all.",
      severity: "error",
      from: { path: "^(integrations|examples)/" },
      to: { path: "^(server|codegen|scripts)/" },
    },
    {
      name: "agents-contain-no-channelstack-code",
      severity: "error",
      from: { path: "^examples/agents/" },
      to: { path: "^(sdks|integrations)/" },
    },
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(^|/)(dist|node_modules)/" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: { extensions: [".ts", ".mjs", ".js", ".json"] },
  },
};
