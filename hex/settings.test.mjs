import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const settings = JSON.parse(
  readFileSync(new URL("settings.json", import.meta.url), "utf8"),
);

const assertStrings = (values, label) => {
  assert.ok(Array.isArray(values), label);
  for (const value of values) assert.equal(typeof value, "string", label);
};

test("vocabulary entries have a term and sounds_like strings", () => {
  assert.ok(Array.isArray(settings.vocabulary));
  for (const { term, sounds_like } of settings.vocabulary) {
    assert.equal(typeof term, "string");
    assertStrings(sounds_like, term);
  }
});

test("replacements have a matched_phrase and an output", () => {
  const { replacements } = settings.dictation_processing.default_mode;
  assert.ok(Array.isArray(replacements));
  for (const { matched_phrase, output } of replacements) {
    assert.equal(typeof matched_phrase, "string");
    assert.equal(typeof output, "string");
  }
});
