// contacts.ts — single source of truth for "who is who" (name ↔ Discord snowflake).
//
// viem-style type safety: the map is `as const satisfies Record<string, Snowflake>`,
// so (a) every value is compile-time checked to be a numeric-string snowflake — a
// malformed id fails `tsc` right here (this is the "know the abi type" trick: the
// literal + `satisfies` validates the shape), and (b) the KEYS become a literal
// union `ContactName`, so anything typed `ContactName` autocompletes to the real
// names and rejects typos at compile time — exactly how viem infers function names
// from an ABI `as const`.
//
// access.json's `answerFrom` references these names (or raw ids); access-ctl
// validates each entry against this map at write time (the runtime equivalent of
// the compile-time check, since JSON itself can't be type-checked).

export type Snowflake = `${number}`

export const CONTACTS = {
  nat: '691531480689541170',
} as const satisfies Record<string, Snowflake>

/** Literal union of known names — "nat" | ... — autocompletes, rejects typos. */
export type ContactName = keyof typeof CONTACTS
/** A reference in config: a known alias OR a raw snowflake. */
export type ContactRef = ContactName | Snowflake

const BY_NAME: Record<string, Snowflake> = CONTACTS

/** alias → snowflake, or pass a raw id straight through. */
export function resolveContact(ref: string): string {
  return BY_NAME[ref] ?? ref
}

/** snowflake → alias name (for readable meta / logs), or undefined if unknown. */
export function nameFor(id: string): ContactName | undefined {
  for (const [name, sf] of Object.entries(CONTACTS) as [ContactName, Snowflake][]) {
    if (sf === id) return name
  }
  return undefined
}

/** Is `ref` a name we know? (used by access-ctl to validate config at write time.) */
export function isKnownName(ref: string): ref is ContactName {
  return ref in CONTACTS
}
