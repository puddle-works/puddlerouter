/**
 * Tests for the allowlist in the local puddlerouter.yaml.
 *
 * Run with: make test
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { allowPredicate, DEFAULT_ALLOWLIST, parseConfig } from "./config.ts";

Deno.test("the default allowlist trusts swamp, mesgme, webframp and puddleworks", () => {
  const ok = allowPredicate(DEFAULT_ALLOWLIST);
  for (
    const n of [
      "@swamp/git",
      "@mesgme/hetzner-cloud-power",
      "@webframp/github",
      "@puddleworks/puddlerouter",
      "@swamp/aws/ec2",
    ]
  ) assert(ok(n), n);
  for (
    const n of ["@swampy/git", "swamp/git", "@other/git", "@swamp/", "@swamp"]
  ) {
    assert(!ok(n), n);
  }
});

Deno.test("allow entries add to the defaults; bad entries are reported and dropped", () => {
  const c = parseConfig(
    "allow:\n  - '@acme/*'\n  - '@acme2/tool'\n  - '*'\n  - 'nope'\n  - '@a/b c'\n",
  );
  const ok = allowPredicate(c.allowlist);
  assert(ok("@acme/anything"));
  assert(ok("@acme2/tool"));
  assert(!ok("@acme2/other"));
  assert(ok("@swamp/git"));
  assertEquals(c.errors.length, 3);
});

Deno.test("an empty or missing file gives the defaults", () => {
  for (const text of ["", "# nothing\n"]) {
    const c = parseConfig(text);
    assertEquals(c.allowlist, DEFAULT_ALLOWLIST);
    assertEquals(c.errors, []);
  }
});

Deno.test("invalid YAML gives the defaults and an error", () => {
  const c = parseConfig("allow: [unclosed");
  assertEquals(c.allowlist, DEFAULT_ALLOWLIST);
  assertEquals(c.errors.length, 1);
});

// @puddleworks/recipes reads the file's recipes and reads keys.
Deno.test("the keys the recipes extension reads are not errors here", () => {
  const c = parseConfig(
    "allow: ['@acme/*']\nreads: ['@webframp/github list_prs']\nrecipes:\n  - id: x\n    nonsense: true\n",
  );
  assertEquals(c.errors, []);
  assert(allowPredicate(c.allowlist)("@acme/anything"));
});

Deno.test("alwaysLlm entries load as case-insensitive patterns", () => {
  const c = parseConfig("alwaysLlm:\n  - '^load the handover doc\\b'\n");
  assertEquals(c.errors, []);
  assertEquals(c.alwaysLlm.length, 1);
  assert(c.alwaysLlm[0].test("Load The Handover Doc at /tmp/x.md"));
  assert(!c.alwaysLlm[0].test("please load the handover doc"));
});

Deno.test("a bad alwaysLlm entry is reported and dropped; the rest still load", () => {
  const c = parseConfig(
    "alwaysLlm:\n  - '('\n  - ''\n  - 12\n  - '^write the handover'\n",
  );
  assertEquals(c.errors.length, 3);
  assert(c.errors.every((e) => e.startsWith("alwaysLlm: ignored")));
  assertEquals(c.alwaysLlm.map((re) => re.source), ["^write the handover"]);
});

Deno.test("alwaysLlm that is not a list is reported", () => {
  const c = parseConfig("alwaysLlm: '^load'\n");
  assertEquals(c.alwaysLlm, []);
  assertEquals(c.errors, ["alwaysLlm: must be a list of patterns"]);
});

Deno.test("no file or an unreadable one gives no alwaysLlm patterns", () => {
  assertEquals(parseConfig("").alwaysLlm, []);
  assertEquals(parseConfig("allow: [unclosed").alwaysLlm, []);
});
