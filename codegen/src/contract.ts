/**
 * The hand-written contract (`api/*.d.ts`) against what implements it: the generated SDK, and the
 * test integration's own types. `pnpm api:check` runs it.
 *
 * Each interface of the contract is compared with the implementation's type of the same name,
 * member by member: a member that is missing, or a method where the contract has a property (or
 * the reverse), is a gap. Members' parameter and return types aren't compared here (see #39); the
 * examples check them where they call them.
 */
import ts from "typescript";

export interface ContractCheck {
  /** The contract's entry, e.g. `api/index.d.ts`. */
  contract: string;
  /** Modules whose exports implement it, e.g. the SDK's `client.ts` and the Vitest integration. */
  implementations: readonly string[];
  /** Contract interfaces nothing implements by that name: bases repeated in every handle, configuration, option bags. */
  notImplemented: (name: string) => boolean;
  /** Contract interfaces implemented once per channel (`ApiCall` → `SlackApiCall`, …), with the channels' prefixes. */
  perChannel: Readonly<Record<string, readonly string[]>>;
  /** Gaps known and tracked: `Type.member` or `Type`, each with its issue. */
  known: Readonly<Record<string, string>>;
  options: ts.CompilerOptions;
}

export interface ContractResult {
  /** Every gap found, tracked or not. */
  gaps: string[];
  /** Gaps `known` doesn't list. */
  untracked: string[];
  /** Entries of `known` that are no longer gaps. */
  closed: string[];
}

export function checkContract(check: ContractCheck): ContractResult {
  const program = ts.createProgram([check.contract, ...check.implementations], { ...check.options, noEmit: true });
  const checker = program.getTypeChecker();
  const exported = (file: string) => {
    const source = program.getSourceFile(file);
    const module = source && checker.getSymbolAtLocation(source);
    if (!module) throw new Error(`Can't read the exports of ${file}`);
    return new Map(
      checker
        .getExportsOfModule(module)
        .map((symbol) => [
          symbol.name,
          symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol,
        ]),
    );
  };
  const implemented = new Map<string, ts.Symbol>();
  for (const file of check.implementations) {
    for (const [name, symbol] of exported(file)) {
      if (symbol.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface) && !implemented.has(name)) {
        implemented.set(name, symbol);
      }
    }
  }
  const callable = (symbol: ts.Symbol) =>
    checker.getNonNullableType(checker.getTypeOfSymbol(symbol)).getCallSignatures().length > 0;
  /** `[Symbol.asyncDispose]` for a symbol-keyed member, its name otherwise. */
  const shown = (member: ts.Symbol) =>
    member.escapedName.toString().startsWith("__@")
      ? `[Symbol.${member.escapedName.toString().slice(3).replace(/@\d+$/, "")}]`
      : member.name;

  const gaps: string[] = [];
  const compare = (contractType: ts.Type, name: string) => {
    const implementation = implemented.get(name);
    if (!implementation) {
      gaps.push(name);
      return;
    }
    const implementationType = checker.getDeclaredTypeOfSymbol(implementation);
    for (const member of checker.getPropertiesOfType(contractType)) {
      // By the escaped name, so a well-known symbol (`Symbol.asyncDispose`) finds its counterpart.
      const counterpart = checker.getPropertyOfType(implementationType, member.escapedName.toString());
      if (!counterpart) gaps.push(`${name}.${shown(member)}`);
      else if (callable(member) !== callable(counterpart)) gaps.push(`${name}.${shown(member)} (method vs property)`);
    }
  };
  for (const [name, symbol] of exported(check.contract)) {
    if (!(symbol.flags & ts.SymbolFlags.Interface) || check.notImplemented(name)) continue;
    const contractType = checker.getDeclaredTypeOfSymbol(symbol);
    const channels = check.perChannel[name];
    if (channels) for (const channel of channels) compare(contractType, `${channel}${name}`);
    else compare(contractType, name);
  }
  return {
    gaps,
    untracked: gaps.filter((gap) => !(gap in check.known)),
    closed: Object.keys(check.known).filter((gap) => !gaps.includes(gap)),
  };
}
