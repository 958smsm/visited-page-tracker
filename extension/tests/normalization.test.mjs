import test from "node:test";
import assert from "node:assert/strict";
import normalization from "../.test-build/src/normalization/normalize-url.js";

const { normalizeUrl } = normalization;
const defaults = { includeFragments: false, ignoreTrackingParameters: false, unifyHttpHttps: false, unifyWww: false, ignoreQueryStrings: false, enableFileUrls: false };

test("URL normalization applies safe defaults", () => {
  const result = normalizeUrl("HTTPS://WWW.Example.COM:443/path?q=2#part", defaults);
  assert.equal(result.normalizedUrl, "https://www.example.com/path?q=2");
  assert.equal(result.hostname, "www.example.com");
});

test("URL normalization keeps query order and can remove tracking parameters", () => {
  const result = normalizeUrl("https://Example.com/?a=1&utm_source=x&b=2&fbclid=y", { ...defaults, ignoreTrackingParameters: true });
  assert.equal(result.normalizedUrl, "https://example.com/?a=1&b=2");
});

test("tracking removal preserves untouched raw query spelling", () => {
  const result = normalizeUrl("https://example.com/?x=%2F+z&utm_source=a&y=a%20b", { ...defaults, ignoreTrackingParameters: true });
  assert.equal(result.normalizedUrl, "https://example.com/?x=%2F+z&y=a%20b");
});

test("normalization supports fragment, scheme, www, and query settings", () => {
  const result = normalizeUrl("http://www.example.com/path?q=1#x", { ...defaults, includeFragments: true, unifyHttpHttps: true, unifyWww: true, ignoreQueryStrings: true });
  assert.equal(result.normalizedUrl, "https://example.com/path#x");
});

test("file URLs require explicit setting", () => {
  assert.equal(normalizeUrl("file:///tmp/example.html", defaults), null);
  assert.equal(normalizeUrl("file:///tmp/example.html", { ...defaults, enableFileUrls: true }).normalizedUrl, "file:///tmp/example.html");
});
