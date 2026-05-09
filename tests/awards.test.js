import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AWARD_NAMES,
  BADGE_KEY_BY_NAME,
  deriveAwardBadges,
} from "../lib/utils.js";

test("deriveAwardBadges: Anora-style two-name input", () => {
  // Real entry from prod-output-movies.yml: Anora has both Cannes + Oscar.
  assert.deepEqual(
    deriveAwardBadges(["Cannes Palme d'Or", "Oscar Best Picture"]),
    ["cannes", "oscar"]
  );
});

test("deriveAwardBadges: Parasite-style four-name input", () => {
  assert.deepEqual(
    deriveAwardBadges([
      "청룡영화제 최우수 작품상",
      "Cannes Palme d'Or",
      "Oscar Best Picture",
      "Oscar Best International Film",
    ]),
    ["blue_dragon", "cannes", "oscar"]
  );
});

test("deriveAwardBadges: drops names without a badge mapping", () => {
  assert.deepEqual(
    deriveAwardBadges(["Hong Kong Film Awards", "Cannes Palme d'Or"]),
    ["cannes"]
  );
});

test("deriveAwardBadges: returns empty array when no badges map", () => {
  assert.deepEqual(deriveAwardBadges(["César Award for Best Film"]), []);
  assert.deepEqual(deriveAwardBadges([]), []);
});

test("deriveAwardBadges: preserves input order across mapped names", () => {
  // Reverse order should yield reversed badge order.
  assert.deepEqual(
    deriveAwardBadges(["Oscar Best Picture", "Cannes Palme d'Or"]),
    ["oscar", "cannes"]
  );
});
