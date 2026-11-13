# FedgarLurch fork of NeonPlan 3D

This fork tracks [Mastershort/neonplan3d](https://github.com/Mastershort/neonplan3d) 2.2.0 and adds the features below.
The fork's version is upstream's plus a fourth number (2.2.0.N). Code changes are marked `fork (fedgar)` in comments.
Installed through HACS from the `main` branch.

## Garden (works with the HA Homestead fork, FedgarLurch/ha-homestead)

Plants live in [HA Homestead](https://github.com/arozoire/ha-homestead) (plantings, beds as zones, diary); NeonPlan is the screen.

- **Garden pack** (`custom_components/neonplan3d/frontend/packs/garden`, built by `tools/garden_pack.py`): low-poly fruit
  trees, vegetables and herbs, plus **Other plant** and **Flowers** for anything else (they take the name typed).
- **Growth 1 to 10**: a plant is drawn at that part of its full size. With Homestead, plants are drawn at Homestead's
  stage for today (it grows on its own) and plants that died or were removed leave the scene.
- **Beds**: an outdoor area of type bed, linked to an HA area that a Homestead zone uses, is a garden bed.
- **Plan save creates plantings** (`custom_components/neonplan3d/garden.py`): a new Garden pack plant in a bed becomes a
  planting in that bed's zone (name, species, type, variety, sown / planted / existing from its Growth). Moving it to
  another bed moves the planting, changing Growth sets the stage, deleting it ends the planting (or deletes it outright
  when it was placed today and has an empty diary). The planting id is kept on the plan item.
- **Bed card** (tap a bed in 3D, or its button in the room bar): how it is watered and from which valve, last watering,
  the plants in it, and **Add plant** (searchable list, variety, seed / transplant with a size / established). The plant
  is placed where the bed was tapped, clear of the others, and saved at once.
- **Plant card** (tap a plant): bed, when it went in, growth (tap to change), last watered / fertilized / pruned, the
  last diary lines, buttons that log watering, feeding and pruning. ✎: rename, variety, move to another bed, remove
  (died, season over, pulled, or placed by mistake). The bed's valve waterings count from the day the plant went in.
- **Beds glow while their valve runs**, in the valve's colour; of beds sharing a valve with a hand-moved hose, only the
  one with the hose glows.

## Other fork features

- Custom 3D models (.glb) as furniture: upload, own size, neon or original colours, outline, another model by state.
- Local packs: model folders shipped with the fork or put in `www/neonplan3d/packs`.
- Per item: no glow in 3D; visibility conditions like a Home Assistant card; another version of the item by state
  (a wall bed open or closed); glow in its own colour by conditions without a light.
- Doors: hide the lock pin; one tap locks or unlocks (no menu, no question).
- Shades inside the window.

## Versions

| Version | What came |
| --- | --- |
| 2.2.0.1 to 2.2.0.9 | No glow, visibility conditions, versions by state, own-colour glow, door options, inside shades, custom models, local packs, Garden pack |
| 2.2.0.10 | Garden pack plants become Homestead plantings on save |
| 2.2.0.11 | Plants at Homestead's stage, plant card, beds glow while their valve runs |
| 2.2.0.12 | Homestead's lists read correctly |
| 2.2.0.13 | Bed card with Add plant; plant editing (name, variety, bed, remove); Other plant and Flowers |
| 2.2.0.14 | A tap on a bed inside a lawn opens the bed |
| 2.2.0.15 | A plant's card counts the bed's waterings from the day it went in |
| 2.2.0.16 | The room bar's bed buttons open the bed card instead of a room panel |
