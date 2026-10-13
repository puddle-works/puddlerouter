/**
 * The extensions that may be pulled and run without asking.
 *
 * An entry is `@scope/*` (any extension in the scope, nested names included)
 * or an exact `@scope/name`. The defaults are the scopes the owner trusts;
 * the local `puddlerouter.yaml` can add more.
 *
 * @module
 */

/** Scopes trusted by default. */
export const DEFAULT_ALLOWLIST: string[] = [
  "@swamp/*",
  "@mesgme/*",
  "@webframp/*",
  "@puddleworks/*",
];

const ENTRY = /^@[a-z0-9][a-z0-9-]*\/(?:\*|[a-z0-9][a-z0-9/_-]*)$/;
const NAME = /^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9/_-]*$/;

/** True if `entry` is a well-formed allowlist entry. */
export function isEntry(entry: string): boolean {
  return ENTRY.test(entry);
}

/** A test for whether an extension name is on the list. */
export function allowPredicate(list: string[]): (extension: string) => boolean {
  return (extension) => {
    if (!NAME.test(extension)) return false;
    return list.some((entry) =>
      entry.endsWith("/*")
        ? extension.startsWith(entry.slice(0, -1))
        : entry === extension
    );
  };
}

/** True if the extension is on the default list. */
export const isAllowed = allowPredicate(DEFAULT_ALLOWLIST);
