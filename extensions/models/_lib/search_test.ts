/**
 * Tests for the words a turn searches the registry for.
 *
 * Run with: make test
 */
import { assertEquals } from "jsr:@std/assert@1";
import { searchQuery } from "./search.ts";

Deno.test("searchQuery keeps the content words", () => {
  assertEquals(
    searchQuery("list the hetzner servers in my account"),
    "hetzner servers account",
  );
  assertEquals(
    searchQuery("How many open issues are labelled bug?"),
    "open issues labelled bug",
  );
  assertEquals(searchQuery("is it?"), "");
});

Deno.test("searchQuery gives at most four words, each once, of the safe characters", () => {
  assertEquals(
    searchQuery("alpha beta alpha gamma delta epsilon"),
    "alpha beta gamma delta",
  );
  assertEquals(searchQuery("x; rm -rf /tmp"), "tmp");
});
