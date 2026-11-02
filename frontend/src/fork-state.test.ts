import assert from "node:assert/strict";
import { test } from "node:test";
import { conditionMet, furnitureHidden, hiddenFurnitureIds, visibilityOf, type Furniture } from "./model.ts";

const st = (s: string) => ({ state: s });

test("fork: 'state is' shows the item only in that state, case-insensitively", () => {
  const f = { visibility: [{ condition: "state" as const, entity: "lock.back_door", state: "Locked" }] };
  assert.equal(furnitureHidden(f, { "lock.back_door": st("locked") }), false);
  assert.equal(furnitureHidden(f, { "lock.back_door": st("unlocked") }), true);
  assert.equal(furnitureHidden(f, {}), true);
});

test("fork: 'state is not' hides the item in that state; a missing entity meets it", () => {
  const c = { condition: "state" as const, entity: "switch.x", state_not: ["off", "unavailable"] };
  assert.equal(conditionMet(c, { "switch.x": st("on") }), true);
  assert.equal(conditionMet(c, { "switch.x": st("off") }), false);
  assert.equal(conditionMet(c, {}), true);
});

test("fork: all conditions must be met, and no conditions hide nothing", () => {
  const f = {
    visibility: [
      { condition: "state" as const, entity: "a.a", state: "on" },
      { condition: "state" as const, entity: "b.b", state_not: "home" },
    ],
  };
  assert.equal(furnitureHidden(f, { "a.a": st("on"), "b.b": st("away") }), false);
  assert.equal(furnitureHidden(f, { "a.a": st("on"), "b.b": st("home") }), true);
  assert.equal(furnitureHidden({ visibility: [] }, {}), false);
  assert.equal(furnitureHidden({}, {}), false);
});

test("fork: the legacy hide_when rule reads as a condition", () => {
  assert.deepEqual(visibilityOf({ hide_when: { entity: "lock.x", states: ["locked"], show_only: true } }), [{ condition: "state", entity: "lock.x", state: ["locked"] }]);
  assert.deepEqual(visibilityOf({ hide_when: { entity: "lock.x", states: ["unlocked"] } }), [{ condition: "state", entity: "lock.x", state_not: ["unlocked"] }]);
  const b = { floors: [{ furniture: [{ id: "a", hide_when: { entity: "s.a", states: ["off"] } }, { id: "b" }] as Furniture[] }] };
  assert.deepEqual([...hiddenFurnitureIds(b, { "s.a": st("off") })], ["a"]);
});
