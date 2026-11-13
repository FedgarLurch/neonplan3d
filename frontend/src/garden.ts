/**
 * Fork (fedgar): the garden from HA Homestead in the 3D view.
 *
 * Homestead (a separate integration) keeps the beds ("zones", each linked to an HA area and a valve), the plantings
 * and the diary. The plan's Garden pack plants carry the planting's id (the integration writes it when the plan is
 * saved). Here: plants drawn at today's growth stage and hidden once they are gone, the beds whose valve runs glow
 * in the valve's colour, and the card a tapped plant opens.
 */
import type { Building, Furniture, Vec2 } from "./model.ts";
import type { HomeAssistant } from "./types.ts";

export interface GardenZone {
  id: string;
  name: string;
  area_id?: string | null;
  valve_entity?: string | null;
  hose_here?: boolean;
}

export interface GardenPlanting {
  id: string;
  name: string;
  species?: string;
  variety?: string | null;
  plant_type?: string | null;
  origin?: string | null;
  sown_on?: string | null;
  planted_on?: string | null;
  zone_id?: string | null;
  status?: string;
}

export interface GardenEvent {
  id: string;
  kind: string;
  done_on: string;
  planting_id?: string | null;
  zone_id?: string | null;
  notes?: string | null;
  valve_minutes?: number | null;
}

export interface GardenData {
  zones: Record<string, GardenZone>;
  plantings: Record<string, GardenPlanting>;
  events: Record<string, GardenEvent>;
  growth: Record<string, number>;
}

/** Valve colours of the Garden dashboard; other valves glow in this cyan. */
const VALVE_COLORS: Record<string, string> = {
  "valve.back_yard_water_valve": "#378ADD",
  "valve.front_yard_water_valve": "#1D9E75",
  "valve.tree_valve": "#639922",
  "valve.front_flower_bed": "#D4537E",
};
const OTHER_VALVE = "#37E0FF";

const OPEN = new Set(["open", "opening", "on"]);

/** The garden as the subscription sends it (a missing part is empty). */
export function readGarden(msg: unknown): GardenData | null {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;
  // Homestead sends its collections as lists; keyed by id here
  const byId = <T extends { id: string }>(v: unknown): Record<string, T> => {
    if (Array.isArray(v)) return Object.fromEntries((v as T[]).filter((x) => x && typeof x.id === "string").map((x) => [x.id, x]));
    return v && typeof v === "object" ? (v as Record<string, T>) : {};
  };
  return {
    zones: byId<GardenZone>(m.zones),
    plantings: byId<GardenPlanting>(m.plantings),
    events: byId<GardenEvent>(m.events),
    growth: (m.growth as Record<string, number>) ?? {},
  };
}

/** A planting still in the ground (Homestead keeps dead and removed ones for their history). */
function alive(p: GardenPlanting | undefined): boolean {
  return !!p && (!p.status || p.status === "active");
}

/** The stage a plant is drawn at: Homestead's stage today, in whole steps (10 = full size, stored as unset). */
export function drawnGrowth(garden: GardenData, f: Pick<Furniture, "planting_id" | "growth">): number | null {
  const id = f.planting_id;
  if (!id || garden.growth[id] === undefined) return f.growth ?? null;
  const g = Math.max(1, Math.min(10, Math.round(garden.growth[id])));
  return g >= 10 ? null : g;
}

/** What the garden changes in the scene, as a short key (the scene is rebuilt only when it changes). */
export function gardenKey(b: Building, garden: GardenData | null): string {
  if (!garden) return "";
  const out: string[] = [];
  for (const floor of b.floors) {
    for (const f of floor.furniture) {
      if (!f.planting_id) continue;
      out.push(`${f.id}:${alive(garden.plantings[f.planting_id]) ? drawnGrowth(garden, f) : "x"}`);
    }
  }
  return out.join(",");
}

/** Plants at today's growth; plants that died or were removed in Homestead leave the scene. */
export function gardenFurniture(list: Furniture[], garden: GardenData | null): Furniture[] {
  if (!garden || !list.some((f) => f.planting_id)) return list;
  return list
    .filter((f) => !f.planting_id || !garden.plantings[f.planting_id] || alive(garden.plantings[f.planting_id]))
    .map((f) => {
      if (!f.planting_id) return f;
      const growth = drawnGrowth(garden, f);
      return growth === (f.growth ?? null) ? f : { ...f, growth };
    });
}

/** The valves the beds hang on (watched for the glow). */
export function gardenValves(garden: GardenData | null): string[] {
  if (!garden) return [];
  return [...new Set(Object.values(garden.zones).map((z) => z.valve_entity).filter((v): v is string => !!v))];
}

/** Zones a valve waters now: one zone always, several only where the hand-moved hose lies. */
function wateredZones(garden: GardenData, valve: string): GardenZone[] {
  const on = Object.values(garden.zones).filter((z) => z.valve_entity === valve);
  return on.length <= 1 ? on : on.filter((z) => z.hose_here !== false);
}

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export interface GardenPatch {
  floorId: string;
  points: Vec2[];
  y: number;
  color: [number, number, number];
  opacity: number;
  glow: true;
}

/** The outdoor areas of beds being watered right now, glowing in their valve's colour. */
export function gardenPatches(hass: HomeAssistant, b: Building, garden: GardenData | null): GardenPatch[] {
  if (!garden) return [];
  const areas = new Map<string, string>();
  for (const valve of gardenValves(garden)) {
    if (!OPEN.has(hass.states[valve]?.state ?? "")) continue;
    for (const z of wateredZones(garden, valve)) if (z.area_id) areas.set(z.area_id, VALVE_COLORS[valve] ?? OTHER_VALVE);
  }
  if (!areas.size) return [];
  const out: GardenPatch[] = [];
  for (const floor of b.floors) {
    for (const o of floor.outdoor) {
      const color = o.area_id ? areas.get(o.area_id) : undefined;
      if (color && o.points.length >= 3) out.push({ floorId: floor.id, points: o.points, y: 0.03, color: rgb(color), opacity: 0.55, glow: true });
    }
  }
  return out;
}

export interface PlantCard {
  name: string;
  species: string;
  bed: string | null;
  started: string | null;
  how: string;
  stage: number | null;
  last: { watering: string | null; fertilizing: string | null; pruning: string | null };
  recent: GardenEvent[];
}

const KIND_ICON: Record<string, string> = {
  watering: "💧",
  fertilizing: "🌿",
  pruning: "✂️",
  harvest: "🧺",
  treatment: "🧴",
  removal: "🪦",
  photo: "📸",
  review: "⭐",
};

export function kindIcon(kind: string): string {
  return KIND_ICON[kind] ?? "📝";
}

/** What the plant's card shows: its bed, when it went in, its stage, the last care and the last diary lines. */
export function plantCard(garden: GardenData, plantingId: string): PlantCard | null {
  const p = garden.plantings[plantingId];
  if (!p) return null;
  const zone = p.zone_id ? garden.zones[p.zone_id] : undefined;
  // the bed's waterings (a valve run) count for every plant in it
  const mine = Object.values(garden.events)
    .filter((e) => e.planting_id === p.id || (!!p.zone_id && e.zone_id === p.zone_id))
    .sort((a, b) => (a.done_on < b.done_on ? 1 : a.done_on > b.done_on ? -1 : 0));
  const lastOf = (kind: string) => mine.find((e) => e.kind === kind)?.done_on ?? null;
  const how = p.origin === "sown" ? "Sown" : p.origin === "existing" ? "Already there" : "Planted";
  return {
    name: p.name,
    species: [p.species, p.variety].filter(Boolean).join(", "),
    bed: zone?.name ?? null,
    started: p.planted_on ?? p.sown_on ?? null,
    how,
    stage: garden.growth[p.id] ?? null,
    last: { watering: lastOf("watering"), fertilizing: lastOf("fertilizing"), pruning: lastOf("pruning") },
    recent: mine.slice(0, 5),
  };
}

/** "Today", "Yesterday", "3 days ago", or the date for anything older than a week. */
export function ago(day: string | null, now = new Date()): string {
  if (!day) return "never";
  const d = new Date(`${day}T00:00:00`);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const n = Math.round((today.getTime() - d.getTime()) / 86400_000);
  if (n <= 0) return "today";
  if (n === 1) return "yesterday";
  if (n < 8) return `${n} days ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}
