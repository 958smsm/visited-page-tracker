import test from "node:test";
import assert from "node:assert/strict";
import matchers from "../.test-build/src/shared/matchers.js";

const { domainMatches, urlPatternMatches, wildcardToRegExp } = matchers;

test("excluded domains include subdomains but not suffix lookalikes", () => {
  assert.equal(domainMatches("docs.example.com", ["example.com"]), true);
  assert.equal(domainMatches("notexample.com", ["example.com"]), false);
});

test("wildcard URL patterns support star and question mark", () => {
  assert.equal(urlPatternMatches("https://example.com/private/abc", ["https://example.com/private/*"]), true);
  assert.equal(wildcardToRegExp("https://example.com/item/?").test("https://example.com/item/7"), true);
});
