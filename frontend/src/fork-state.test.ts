import assert from "node:assert/strict";
import { test } from "node:test";
import { furnitureHidden, hiddenFurnitureIds, type Furniture } from "./model.ts";

const st = (s: string) => ({ state: s });

test("fork: an item hides while its entity is in a listed state, case-insensitively", () => {
  const f = { hide_when: { entity: "lock.front_door", states: ["Unlocked"] } } as Pick<Furniture, "hide_when">;
  assert.equal(furnitureHidden(f, { "lock.front_door": st("unlocked") }), true);
  assert.equal(furnitureHidden(f, { "lock.front_door": st("locked") }), false);
});

test("fork: show_only turns the rule round; unknown entities and empty rules hide nothing", () => {
  const f = { hide_when: { entity: "input_boolean.xmas", states: ["on"], show_only: true } } as Pick<Furniture, "hide_when">;
  assert.equal(furnitureHidden(f, { "input_boolean.xmas": st("off") }), true);
  assert.equal(furnitureHidden(f, { "input_boolean.xmas": st("on") }), false);
  assert.equal(furnitureHidden(f, {}), false);
  assert.equal(furnitureHidden({ hide_when: { entity: "x.y", states: [] } }, { "x.y": st("on") }), false);
  assert.equal(furnitureHidden({ hide_when: null }, {}), false);
});

test("fork: hiddenFurnitureIds collects across floors", () => {
  const b = { floors: [{ furniture: [{ id: "a", hide_when: { entity: "s.a", states: ["off"] } }, { id: "b" }] as Furniture[] }] };
  assert.deepEqual([...hiddenFurnitureIds(b, { "s.a": st("off") })], ["a"]);
});
