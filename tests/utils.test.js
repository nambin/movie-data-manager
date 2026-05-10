import { test } from "node:test";
import assert from "node:assert/strict";
import { getLanguageName } from "../lib/utils.js";

test("getLanguageName: standard ISO 639-1 codes", () => {
  assert.equal(getLanguageName("ko"), "Korean");
  assert.equal(getLanguageName("en"), "English");
  assert.equal(getLanguageName("ja"), "Japanese");
  assert.equal(getLanguageName("fr"), "French");
  assert.equal(getLanguageName("zh"), "Chinese");
});

test("getLanguageName: TMDb-specific override 'cn' → Cantonese", () => {
  // TMDb tags Hong Kong / Cantonese films (e.g. Police Story id=9056,
  // Infernal Affairs id=10775) with original_language="cn". Without the
  // override, Intl.DisplayNames returns "cn" verbatim and the YAML ends
  // up with `tmdb_original_language: cn`.
  assert.equal(getLanguageName("cn"), "Cantonese");
});

test("getLanguageName: unknown code falls back to the code as-is", () => {
  assert.equal(getLanguageName("xx"), "xx");
});

test("getLanguageName: empty / null / undefined returns null", () => {
  assert.equal(getLanguageName(""), null);
  assert.equal(getLanguageName(null), null);
  assert.equal(getLanguageName(undefined), null);
});
