// fork (fedgar): the garden from HA Homestead in the 3D view.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ago, drawnGrowth, gardenFurniture, gardenPatches, plantCard, readGarden, type GardenData } from "./garden.ts";
import type { Building, Furniture } from "./model.ts";
import type { HomeAssistant } from "./types.ts";

const garden = (): GardenData =>
  readGarden({
    zones: {
      z2: { id: "z2", name: "Bed 2", area_id: "bed_2", valve_entity: "valve.front_flower_bed", hose_here: true },
      z10: { id: "z10", name: "Bed 10", area_id: "bed_10", valve_entity: "valve.front_flower_bed", hose_here: false },
      z13: { id: "z13", name: "Bed 13", area_id: "bed_13", valve_entity: "valve.tree_valve" },
    },
    plantings: {
      p1: { id: "p1", name: "Lettuce 1", zone_id: "z2", origin: "planted", planted_on: "2026-11-01", status: "active" },
      p2: { id: "p2", name: "Basil 1", zone_id: "z2", status: "removed" },
      p3: { id: "p3", name: "Peach Tree", zone_id: "z13", origin: "existing", status: "active" },
    },
    events: {
      e1: { id: "e1", kind: "watering", done_on: "2026-11-11", zone_id: "z2", notes: "Front Flower Bed, 22 min" },
      e2: { id: "e2", kind: "pruning", done_on: "2026-11-05", planting_id: "p1" },
      e3: { id: "e3", kind: "watering", done_on: "2026-11-12", zone_id: "z13" },
    },
    growth: { p1: 3.4, p3: 10 },
  })!;

const plant = (id: string, planting: string | null, growth: number | null = null): Furniture =>
  ({ id, type: "pack:local.garden:lettuce", x: 0, z: 0, rotation: 0, w: 1, d: 1, h: 1, planting_id: planting, growth }) as unknown as Furniture;

test("plants are drawn at today's stage, gone ones leave the scene", () => {
  const g = garden();
  assert.equal(drawnGrowth(g, { planting_id: "p1", growth: 2 }), 3);
  assert.equal(drawnGrowth(g, { planting_id: "p3", growth: 4 }), null);
  assert.equal(drawnGrowth(g, { planting_id: null, growth: 4 }), 4);
  const out = gardenFurniture([plant("a", "p1", 2), plant("b", "p2"), plant("c", null, 5), plant("d", "unknown", 6)], g);
  assert.deepEqual(
    out.map((f) => [f.id, f.growth]),
    [["a", 3], ["c", 5], ["d", 6]],
  );
});

test("beds glow while their valve runs, the hose bed only", () => {
  const sq: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const b = {
    floors: [{ id: "f", outdoor: ["bed_2", "bed_10", "bed_13"].map((a) => ({ id: a, type: "bed", area_id: a, points: sq })), furniture: [] }],
  } as unknown as Building;
  const hass = (states: Record<string, string>) =>
    ({ states: Object.fromEntries(Object.entries(states).map(([k, v]) => [k, { state: v, attributes: {} }])) }) as unknown as HomeAssistant;
  assert.deepEqual(gardenPatches(hass({ "valve.front_flower_bed": "closed", "valve.tree_valve": "closed" }), b, garden()), []);
  const on = gardenPatches(hass({ "valve.front_flower_bed": "open", "valve.tree_valve": "closed" }), b, garden());
  assert.equal(on.length, 1);
  assert.equal(on[0].glow, true);
  assert.equal(gardenPatches(hass({ "valve.tree_valve": "open" }), b, garden()).length, 1);
});

test("the plant card: bed, last care including the bed's waterings, recent diary", () => {
  const c = plantCard(garden(), "p1")!;
  assert.equal(c.bed, "Bed 2");
  assert.equal(c.last.watering, "2026-11-11");
  assert.equal(c.last.pruning, "2026-11-05");
  assert.equal(c.last.fertilizing, null);
  assert.deepEqual(
    c.recent.map((e) => e.id),
    ["e1", "e2"],
  );
  assert.equal(plantCard(garden(), "nope"), null);
  // a plant put in after the bed was watered: that watering is not its own
  const g = garden();
  g.plantings.p1.planted_on = "2026-11-12";
  assert.equal(plantCard(g, "p1")!.last.watering, null);
  // one that was already there has the bed's whole history
  assert.equal(plantCard(garden(), "p3")!.last.watering, "2026-11-12");
});

test("Homestead's lists are keyed by id", () => {
  const g = readGarden({ zones: [{ id: "z", name: "Bed 1" }], plantings: [{ id: "p", name: "Pear Tree" }], events: [], growth: { p: 10 } })!;
  assert.equal(g.zones.z.name, "Bed 1");
  assert.equal(g.plantings.p.name, "Pear Tree");
  assert.equal(plantCard(g, "p")?.name, "Pear Tree");
});

test("ago", () => {
  const now = new Date("2026-11-13T15:00:00");
  assert.equal(ago(null, now), "never");
  assert.equal(ago("2026-11-13", now), "today");
  assert.equal(ago("2026-11-12", now), "yesterday");
  assert.equal(ago("2026-11-10", now), "3 days ago");
});

test("the Garden pack's plants to choose from, found by name or kind", async () => {
  const { gardenChoices, findChoices } = await import("./garden.ts");
  const item = (id: string, name: string, tags: string[]) => ({ id, name: { en: name }, size: [0.4, 0.4, 0.3] as [number, number, number], parts: [], tags });
  const packs = [
    {
      id: "local.garden",
      name: "Garden",
      publisher: "",
      licensee: null,
      items: [
        item("basil", "Basil", ["herb"]),
        item("plant", "Other plant", ["generic"]),
        item("pear_tree", "Pear tree", ["fruit tree", "tree"]),
        item("tomato", "Tomato (caged)", ["vegetable", "nightshade"]),
      ],
    },
  ] as never;
  const all = gardenChoices(packs);
  assert.deepEqual(
    all.map((c) => [c.name, c.group]),
    [["Pear tree", "Trees"], ["Tomato (caged)", "Vegetables"], ["Basil", "Herbs"], ["Other plant", "Other"]],
  );
  assert.deepEqual(
    findChoices(all, "night").map((c) => c.name),
    ["Tomato (caged)", "Other plant"],
  );
  assert.equal(findChoices(all, "").length, 4);
});

test("a new plant goes where the bed was tapped, else the nearest clear spot inside", async () => {
  const { freeSpot, newPlantItem } = await import("./garden.ts");
  const bed: [number, number][] = [[0, 0], [2, 0], [2, 1], [0, 1]];
  assert.deepEqual(freeSpot(bed, [], 0.2, [0.5, 0.5]), [0.5, 0.5]);
  // tapped outside (the raised bed's side): the middle
  assert.deepEqual(freeSpot(bed, [], 0.2, [5, 5]), [1, 0.5]);
  // a plant already there: moved clear of it, still inside
  const p = freeSpot(bed, [[0.5, 0.5, 0.2]], 0.2, [0.5, 0.5]);
  assert.ok(Math.hypot(p[0] - 0.5, p[1] - 0.5) >= 0.4 - 1e-9);
  assert.ok(p[0] > 0 && p[0] < 2 && p[1] > 0 && p[1] < 1);
  const choice = { type: "pack:local.garden:plant", name: "Other plant", group: "Other", generic: true, words: "", size: [0.8, 0.8, 0.6] } as const;
  const f = newPlantItem("f1", { choice: { ...choice, size: [0.8, 0.8, 0.6] }, name: " Lavender ", variety: "Hidcote", growth: 3 }, [1, 0.5]);
  assert.equal(f.name, "Lavender");
  assert.equal(f.plant_variety, "Hidcote");
  assert.equal(f.growth, 3);
  assert.equal(newPlantItem("f2", { choice: { ...choice, size: [0.8, 0.8, 0.6] }, growth: 10 }, [1, 0.5]).growth, null);
});

test("beds of the plan in bed order, and the plants in one", async () => {
  const { bedsOf, bedPlantings } = await import("./garden.ts");
  const sq: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const b = { floors: [{ id: "f", outdoor: ["bed_13", "bed_2", "bed_10", "lawn"].map((a) => ({ id: a, type: "bed", area_id: a, points: sq })), furniture: [] }] } as unknown as Building;
  assert.deepEqual(
    bedsOf(b, garden()).map((x) => x.zone.name),
    ["Bed 2", "Bed 10", "Bed 13"],
  );
  assert.deepEqual(
    bedPlantings(garden(), "z2").map((p) => p.name),
    ["Lettuce 1"],
  );
});
