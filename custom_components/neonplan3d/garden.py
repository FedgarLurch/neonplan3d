"""Fork (fedgar): plants placed in the plan become plantings in HA Homestead.

Runs on every plan save (the editor, or a plant added from a bed's card in the 3D view). A Garden pack plant (a
local pack item with growth) that is new in the plan is created in Homestead, in the zone whose HA area is the bed
it stands in; its planting id is kept on the item. The generic items (Other plant, Flowers) take the name typed for
them, and a variety typed when it was added goes on the planting. Moving it to another bed moves the planting,
changing its Growth sets the planting's growth stage, and deleting it from the plan ends the planting (a planting
made today with nothing in its diary is deleted instead, so a misplaced plant leaves no trace). Without Homestead,
or if a call fails, the plan is saved as it is.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.util import dt as dt_util

_LOGGER = logging.getLogger(__name__)

HOMESTEAD = "homestead"
GARDEN_PACK = "pack:local.garden:"

# item id -> (species, plant type, variety)
PLANTS: dict[str, tuple[str, str, str | None]] = {
    "apple_tree": ("Malus domestica", "fruit_tree", None),
    "pear_tree": ("Pyrus communis", "fruit_tree", None),
    "peach_tree": ("Prunus persica", "fruit_tree", None),
    "lemon_tree": ("Citrus limon", "fruit_tree", None),
    "orange_tree": ("Citrus sinensis", "fruit_tree", None),
    "lettuce": ("Lactuca sativa", "vegetable", None),
    "romaine": ("Lactuca sativa", "vegetable", "Romaine"),
    "cabbage": ("Brassica oleracea", "vegetable", "Cabbage"),
    "broccoli": ("Brassica oleracea", "vegetable", "Broccoli"),
    "cauliflower": ("Brassica oleracea", "vegetable", "Cauliflower"),
    "kale": ("Brassica oleracea", "vegetable", "Kale"),
    "brussels_sprouts": ("Brassica oleracea", "vegetable", "Brussels sprouts"),
    "potato": ("Solanum tuberosum", "vegetable", None),
    "tomato": ("Solanum lycopersicum", "vegetable", None),
    "pepper": ("Capsicum annuum", "vegetable", None),
    "zucchini": ("Cucurbita pepo", "vegetable", None),
    "carrot_row": ("Daucus carota", "vegetable", None),
    "onion_row": ("Allium cepa", "vegetable", None),
    "pole_beans": ("Phaseolus vulgaris", "vegetable", None),
    "corn": ("Zea mays", "vegetable", None),
    "strawberry": ("Fragaria x ananassa", "vegetable", None),
    "basil": ("Ocimum basilicum", "herb", None),
    "rosemary": ("Salvia rosmarinus", "herb", None),
    "thyme": ("Thymus vulgaris", "herb", None),
    "mint": ("Mentha", "herb", None),
    "parsley": ("Petroselinum crispum", "herb", None),
    "cilantro": ("Coriandrum sativum", "herb", None),
    "sage": ("Salvia officinalis", "herb", None),
    "oregano": ("Origanum vulgare", "herb", None),
    "chives": ("Allium schoenoprasum", "herb", None),
}

# Items for anything else: the plant is called what was typed for it (the item's own name)
GENERIC: dict[str, str] = {"plant": "other", "flowers": "flower"}


def base_name(label: str) -> str:
    """'Tomato (caged)' -> 'Tomato', 'Zucchini / squash' -> 'Zucchini', 'Apple tree' -> 'Apple Tree'."""
    label = re.sub(r"\(.*?\)", "", label).split("/")[0].strip()
    return " ".join(w[:1].upper() + w[1:] for w in label.split())


def next_name(base: str, plant_type: str, used: list[str]) -> str:
    """Numbers are never reused. Trees: the first is just 'Apple Tree', then 'Apple Tree 2'. Others: 'Lettuce 1'."""
    top = 0
    for name in used:
        if name == base:
            top = max(top, 1)
        elif (m := re.fullmatch(re.escape(base) + r" (\d+)", name)) is not None:
            top = max(top, int(m.group(1)))
    if plant_type == "fruit_tree":
        return base if top == 0 else f"{base} {top + 1}"
    return f"{base} {top + 1}"


def inside(x: float, z: float, points: list[list[float]]) -> bool:
    """Point in polygon (even-odd)."""
    hit = False
    j = len(points) - 1
    for i, (xi, zi) in enumerate(points):
        xj, zj = points[j]
        if (zi > z) != (zj > z) and x < (xj - xi) * (z - zi) / ((zj - zi) or 1e-12) + xi:
            hit = not hit
        j = i
    return hit


def bed_area(floor: dict[str, Any], x: float, z: float) -> str | None:
    """The HA area of the outdoor area (bed first) under the point."""
    found = None
    for area in floor.get("outdoor") or []:
        if not area.get("area_id") or len(area.get("points") or []) < 3 or not inside(x, z, area["points"]):
            continue
        if area.get("type") == "bed":
            return area["area_id"]
        found = found or area["area_id"]
    return found


def _plants(building: dict[str, Any]) -> dict[str, tuple[dict[str, Any], dict[str, Any]]]:
    """Garden plants in the plan: furniture id -> (item, its floor)."""
    out = {}
    for floor in building.get("floors") or []:
        for item in floor.get("furniture") or []:
            if isinstance(item.get("type"), str) and item["type"].startswith(GARDEN_PACK) and item.get("id"):
                out[item["id"]] = (item, floor)
    return out


def _store(hass: HomeAssistant) -> Any:
    for entry in hass.config_entries.async_entries(HOMESTEAD):
        if (store := getattr(entry, "runtime_data", None)) is not None and hasattr(store, "data"):
            return store
    return None


async def _call(hass: HomeAssistant, service: str, data: dict[str, Any]) -> dict[str, Any]:
    out = await hass.services.async_call(HOMESTEAD, service, data, blocking=True, return_response=True)
    return out or {}


async def async_sync_garden(
    hass: HomeAssistant, old: dict[str, Any], new: dict[str, Any], names: dict[str, str]
) -> None:
    """Bring Homestead in line with the plan about to be saved; writes planting ids into `new`.

    `names` maps garden pack item ids to their names in the library."""
    if (store := _store(hass)) is None or not hass.services.has_service(HOMESTEAD, "add_planting"):
        return
    data = store.data
    zones_by_area = {z.area_id: z.id for z in data.zones.values() if getattr(z, "area_id", None)}
    today = dt_util.now().date().isoformat()
    before = _plants(old)
    after = _plants(new)

    for fid, (item, floor) in after.items():
        prev = before.get(fid, (None, None))[0] or {}
        # the editor does not know the ids written here: carry them over from the saved plan
        for key in ("planting_id", "planting_on"):
            if not item.get(key) and prev.get(key):
                item[key] = prev[key]
        try:
            area = bed_area(floor, float(item.get("x") or 0), float(item.get("z") or 0))
            zone_id = zones_by_area.get(area) if area else None
            growth = item.get("growth") or 10
            pid = item.get("planting_id")
            if pid and pid in data.plantings:
                planting = data.plantings[pid]
                if planting.zone_id != zone_id and zone_id is not None:
                    await _call(hass, "update_planting", {"id": pid, "zone_id": zone_id})
                if prev and (prev.get("growth") or 10) != growth:
                    await _call(hass, "set_growth", {"id": pid, "stage": growth})
                continue
            if pid:
                continue  # removed in Homestead: leave it alone
            key = item["type"][len(GARDEN_PACK) :]
            species, plant_type, variety = PLANTS.get(key, (None, GENERIC.get(key, "other"), None))
            base = base_name(names.get(key) or key.replace("_", " "))
            own = str(item.get("name") or "").strip()
            if key in GENERIC and own:
                base = species = own
            variety = str(item.get("plant_variety") or "").strip() or variety
            payload: dict[str, Any] = {
                "name": next_name(base, plant_type, [p.name for p in data.plantings.values()]),
                "species": species or base,
                "plant_type": plant_type,
            }
            if variety:
                payload["variety"] = variety
            if zone_id:
                payload["zone_id"] = zone_id
            if growth >= 10:
                payload["origin"] = "existing"
            elif growth <= 1:
                payload |= {"origin": "sown", "sown_on": today, "growth_start": 1}
            else:
                payload |= {"origin": "planted", "planted_on": today, "growth_start": growth}
            out = await _call(hass, "add_planting", payload)
            if out.get("id"):
                item["planting_id"] = out["id"]
                item["planting_on"] = today
        except Exception:  # never block the save
            _LOGGER.exception("NeonPlan 3D: could not sync garden plant %s with Homestead", fid)

    for fid, (item, _floor) in before.items():
        pid = item.get("planting_id")
        if fid in after or not pid or pid not in data.plantings:
            continue
        try:
            fresh = item.get("planting_on") == today and not any(e.planting_id == pid for e in data.events.values())
            if fresh:
                await _call(hass, "delete_planting", {"id": pid})
            elif data.plantings[pid].status == "active":
                await _call(hass, "add_event", {"kind": "removal", "planting_id": pid, "reason": "removed"})
        except Exception:
            _LOGGER.exception("NeonPlan 3D: could not end planting %s in Homestead", pid)
