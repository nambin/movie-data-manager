import { test } from "node:test";
import assert from "node:assert/strict";
import { isKoreanDirector } from "../lib/utils.js";

test("isKoreanDirector: pure Korean", () => {
  assert.equal(isKoreanDirector("박찬욱"), true);
  assert.equal(isKoreanDirector("봉준호"), true);
});

test("isKoreanDirector: pure English", () => {
  assert.equal(isKoreanDirector("Christopher Nolan"), false);
  assert.equal(isKoreanDirector("Park Chan-wook"), false);
});

test("isKoreanDirector: mixed (Korean + English)", () => {
  assert.equal(isKoreanDirector("박찬욱 (Park Chan-wook)"), true);
});

test("isKoreanDirector: Japanese kanji is NOT Korean", () => {
  assert.equal(isKoreanDirector("是枝裕和"), false);
});

test("isKoreanDirector: Chinese is NOT Korean", () => {
  assert.equal(isKoreanDirector("李安"), false);
});

test("isKoreanDirector: empty / non-string", () => {
  assert.equal(isKoreanDirector(""), false);
  assert.equal(isKoreanDirector(null), false);
  assert.equal(isKoreanDirector(undefined), false);
  assert.equal(isKoreanDirector(123), false);
});

test("isKoreanDirector: U+AC00..U+D7A3 boundary", () => {
  // 가 = U+AC00, 힣 = U+D7A3
  assert.equal(isKoreanDirector("가"), true);
  assert.equal(isKoreanDirector("힣"), true);
  // U+ABFF (just below) and U+D7A4 (just above) should NOT match.
  assert.equal(isKoreanDirector(String.fromCodePoint(0xabff)), false);
  assert.equal(isKoreanDirector(String.fromCodePoint(0xd7a4)), false);
});
