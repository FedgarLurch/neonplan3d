"""Fork (fedgar): builds the garden pack, low-poly .glb models of fruit trees, vegetables and herbs plus pack.json,
into custom_components/neonplan3d/frontend/packs/garden/. Run: python3 tools/garden_pack.py

Every model stands on y = 0 with its front at +z, in metres (NeonPlan fits it to the item's size anyway). Leaves are
double sided, so they show from both sides in the plan.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
import random
import struct

OUT = Path(__file__).resolve().parent.parent / "custom_components" / "neonplan3d" / "frontend" / "packs" / "garden"


def srgb(hexcode: str) -> list[float]:
    """'#rrggbb' to a linear glTF colour."""
    c = [int(hexcode[i : i + 2], 16) / 255 for i in (1, 3, 5)]
    return [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c] + [1.0]


class Model:
    def __init__(self, seed: int) -> None:
        self.rng = random.Random(seed)
        self.mats: dict[str, list[tuple]] = {}

    def tri(self, mat: str, a, b, c, both: bool = False) -> None:
        self.mats.setdefault(mat, []).append((a, b, c))
        if both:
            self.mats[mat].append((a, c, b))

    # ------------------------------------------------------------ shapes
    def blob(self, mat: str, c, r, sub: int = 1, jitter: float = 0.12) -> None:
        """An icosphere around c with radii r (x, y, z), its corners pushed in and out a little."""
        t = (1 + 5**0.5) / 2
        v = [(-1, t, 0), (1, t, 0), (-1, -t, 0), (1, -t, 0), (0, -1, t), (0, 1, t), (0, -1, -t), (0, 1, -t), (t, 0, -1), (t, 0, 1), (-t, 0, -1), (-t, 0, 1)]
        v = [tuple(x / math.sqrt(sum(y * y for y in p)) for x in p) for p in v]
        f = [(0, 11, 5), (0, 5, 1), (0, 1, 7), (0, 7, 10), (0, 10, 11), (1, 5, 9), (5, 11, 4), (11, 10, 2), (10, 7, 6), (7, 1, 8), (3, 9, 4), (3, 4, 2), (3, 2, 6), (3, 6, 8), (3, 8, 9), (4, 9, 5), (2, 4, 11), (6, 2, 10), (8, 6, 7), (9, 8, 1)]
        for _ in range(sub):
            mid: dict[tuple[int, int], int] = {}

            def m(i: int, j: int) -> int:
                k = (min(i, j), max(i, j))
                if k not in mid:
                    p = [(v[i][a] + v[j][a]) / 2 for a in range(3)]
                    n = math.sqrt(sum(x * x for x in p))
                    v.append(tuple(x / n for x in p))
                    mid[k] = len(v) - 1
                return mid[k]

            nf = []
            for a, b, cc in f:
                ab, bc, ca = m(a, b), m(b, cc), m(cc, a)
                nf += [(a, ab, ca), (b, bc, ab), (cc, ca, bc), (ab, bc, ca)]
            f = nf
        k = [1 + self.rng.uniform(-jitter, jitter) for _ in v]
        pts = [(c[0] + p[0] * r[0] * k[i], c[1] + p[1] * r[1] * k[i], c[2] + p[2] * r[2] * k[i]) for i, p in enumerate(v)]
        for a, b, cc in f:
            self.tri(mat, pts[a], pts[b], pts[cc])

    def ball(self, mat: str, c, r: float, ry: float | None = None) -> None:
        """A small round thing (fruit, a bud): an octahedron, once subdivided."""
        ry = r if ry is None else ry
        top, bot = (c[0], c[1] + ry, c[2]), (c[0], c[1] - ry, c[2])
        ring = [(c[0] + r * math.cos(a), c[1], c[2] + r * math.sin(a)) for a in [i * math.pi / 3 for i in range(6)]]
        for i in range(6):
            p, q = ring[i], ring[(i + 1) % 6]
            self.tri(mat, top, q, p)
            self.tri(mat, bot, p, q)

    def cyl(self, mat: str, a, b, r0: float, r1: float, n: int = 7, cap: bool = True) -> None:
        """A tapered tube from point a (radius r0) to point b (radius r1)."""
        d = [b[i] - a[i] for i in range(3)]
        ln = math.sqrt(sum(x * x for x in d)) or 1
        d = [x / ln for x in d]
        up = (0, 1, 0) if abs(d[1]) < 0.9 else (1, 0, 0)
        u = cross(d, up)
        u = norm(u)
        w = cross(d, u)
        ring = lambda o, r: [tuple(o[k] + r * (math.cos(t) * u[k] + math.sin(t) * w[k]) for k in range(3)) for t in [i * 2 * math.pi / n for i in range(n)]]
        ra, rb = ring(a, r0), ring(b, r1)
        for i in range(n):
            j = (i + 1) % n
            self.tri(mat, ra[i], rb[j], rb[i])
            self.tri(mat, ra[i], ra[j], rb[j])
            if cap:
                self.tri(mat, tuple(b), rb[i], rb[j])

    def leaf(self, mat: str, base, yaw: float, pitch: float, length: float, width: float, droop: float = 0.3, segs: int = 3, shape=None) -> None:
        """A leaf blade from `base`: heading `yaw` (radians around y), rising at `pitch`, bending down by `droop`."""
        shape = shape or (lambda t: math.sin(math.pi * min(1, t * 1.15)) if t < 0.87 else max(0.0, (1 - t) * 3))
        dx, dz = math.cos(yaw), math.sin(yaw)
        sx, sz = -dz, dx
        spine = []
        for i in range(segs + 1):
            t = i / segs
            p = pitch - droop * t * 2
            spine.append((t, p))
        pts = []
        x, y, z = base
        prev = (x, y, z)
        for t, p in spine:
            if t > 0:
                step = length / segs
                prev = (prev[0] + dx * math.cos(p) * step, prev[1] + math.sin(p) * step, prev[2] + dz * math.cos(p) * step)
            hw = width / 2 * shape(t)
            pts.append(((prev[0] + sx * hw, prev[1], prev[2] + sz * hw), (prev[0] - sx * hw, prev[1], prev[2] - sz * hw)))
        for i in range(segs):
            (l0, r0), (l1, r1) = pts[i], pts[i + 1]
            self.tri(mat, l0, r0, r1, both=True)
            self.tri(mat, l0, r1, l1, both=True)

    def rosette(self, mat: str, c, n: int, length: float, width: float, pitch: float, droop: float, jitter: float = 0.25, mats=None) -> None:
        for i in range(n):
            yaw = i * 2.399 + self.rng.uniform(-0.2, 0.2)
            k = 1 + self.rng.uniform(-jitter, jitter)
            self.leaf((mats[i % len(mats)] if mats else mat), c, yaw, pitch + self.rng.uniform(-0.15, 0.15), length * k, width * k, droop)

    # ------------------------------------------------------------ output
    def glb(self, path: Path, colors: dict[str, str]) -> int:
        prims, binv, views, accs, mats = [], bytearray(), [], [], []
        for name, tris in self.mats.items():
            pos = [c for t in tris for p in t for c in p]
            pb = struct.pack(f"<{len(pos)}f", *pos)
            while len(binv) % 4:
                binv += b"\0"
            views.append({"buffer": 0, "byteOffset": len(binv), "byteLength": len(pb), "target": 34962})
            binv += pb
            xs, ys, zs = pos[0::3], pos[1::3], pos[2::3]
            accs.append({"bufferView": len(views) - 1, "componentType": 5126, "count": len(pos) // 3, "type": "VEC3", "min": [min(xs), min(ys), min(zs)], "max": [max(xs), max(ys), max(zs)]})
            mats.append({"name": name, "pbrMetallicRoughness": {"baseColorFactor": srgb(colors[name]), "metallicFactor": 0, "roughnessFactor": 0.9}, "doubleSided": True})
            prims.append({"attributes": {"POSITION": len(accs) - 1}, "material": len(mats) - 1})
        j = {"asset": {"version": "2.0", "generator": "NeonPlan fork garden pack"}, "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0, "name": path.stem}], "meshes": [{"primitives": prims}], "materials": mats, "buffers": [{"byteLength": len(binv)}], "bufferViews": views, "accessors": accs}
        js = json.dumps(j, separators=(",", ":")).encode()
        js += b" " * ((4 - len(js) % 4) % 4)
        while len(binv) % 4:
            binv += b"\0"
        total = 12 + 8 + len(js) + 8 + len(binv)
        path.write_bytes(struct.pack("<III", 0x46546C67, 2, total) + struct.pack("<II", len(js), 0x4E4F534A) + js + struct.pack("<II", len(binv), 0x004E4942) + bytes(binv))
        return sum(len(t) for t in self.mats.values())


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def norm(a):
    n = math.sqrt(sum(x * x for x in a)) or 1
    return tuple(x / n for x in a)


GREEN = "#4f8f3a"
GREEN_DARK = "#2f6b2c"
GREEN_LIGHT = "#8cc152"
BARK = "#6b4a32"
STEM = "#7da35a"

# ---------------------------------------------------------------- fruit trees


def fruit_tree(seed: int, height: float, spread: float, shape: str, fruit: str, fruit_r: float, fruit_ry: float | None = None, leaf: str = GREEN, n_fruit: int = 22) -> tuple[Model, dict]:
    m = Model(seed)
    r = m.rng
    trunk_h = height * (0.32 if shape != "vase" else 0.25)
    m.cyl("bark", (0, 0, 0), (0, trunk_h, 0), 0.11, 0.08)
    centres = []
    if shape == "vase":
        # peach: an open centre, three or four scaffold limbs leaning out
        for i in range(4):
            a = i * math.pi / 2 + r.uniform(-0.3, 0.3)
            tip = (math.cos(a) * spread * 0.28, height * 0.62, math.sin(a) * spread * 0.28)
            m.cyl("bark", (0, trunk_h - 0.05, 0), tip, 0.06, 0.035, cap=True)
            centres.append((tip[0] * 1.15, height * 0.72, tip[2] * 1.15, spread * 0.26, height * 0.2))
        centres.append((0, height * 0.86, 0, spread * 0.2, height * 0.12))
    else:
        top = height * (0.82 if shape == "oval" else 0.72)
        m.cyl("bark", (0, trunk_h - 0.05, 0), (0, top, 0), 0.08, 0.03)
        for i in range(3):
            a = i * 2.1 + r.uniform(-0.3, 0.3)
            m.cyl("bark", (0, trunk_h + 0.1 * i, 0), (math.cos(a) * spread * 0.25, trunk_h + height * 0.22, math.sin(a) * spread * 0.25), 0.05, 0.03)
        rx = spread * (0.3 if shape == "oval" else 0.36)
        mid = (trunk_h + height) / 2 + height * 0.05
        ry = (height - trunk_h) * (0.36 if shape == "oval" else 0.3)
        centres.append((0, mid, 0, rx, ry))
        for i in range(6):
            a = i * math.pi / 3 + r.uniform(-0.2, 0.2)
            y = mid + r.uniform(-0.35, 0.35) * ry
            d = rx * 0.55
            centres.append((math.cos(a) * d, y, math.sin(a) * d, rx * 0.62, ry * 0.62))
    for cx, cy, cz, rx, ry in centres:
        m.blob("leaf", (cx, cy, cz), (rx, ry, rx), 1, 0.14)
    # fruit on the outside of the canopy
    for _ in range(n_fruit):
        cx, cy, cz, rx, ry = r.choice(centres)
        a = r.uniform(0, 2 * math.pi)
        e = r.uniform(-0.25, 0.75)
        p = (cx + math.cos(a) * math.cos(e) * rx * 1.06, cy + math.sin(e) * ry * 1.06, cz + math.sin(a) * math.cos(e) * rx * 1.06)
        # drawn about twice their real size, so they still show from across the plan
        m.ball("fruit", p, fruit_r * 2, (fruit_ry or fruit_r) * 2)
    return m, {"bark": BARK, "leaf": leaf, "fruit": fruit}


# ---------------------------------------------------------------- vegetables and herbs


def lettuce(seed: int):
    m = Model(seed)
    for ring, (n, ln, pitch) in enumerate([(9, 0.16, 0.5), (7, 0.12, 0.9), (5, 0.08, 1.2)]):
        m.rosette("leaf" if ring < 2 else "heart", (0, 0.02 + ring * 0.02, 0), n, ln, ln * 0.9, pitch, 0.45)
    return m, {"leaf": "#7fbf4d", "heart": "#b5dd6e"}


def romaine(seed: int):
    m = Model(seed)
    m.rosette("leaf", (0, 0.01, 0), 10, 0.3, 0.14, 1.3, 0.1, mats=["leaf", "leaf2"])
    return m, {"leaf": "#5e9e3c", "leaf2": "#86bf55"}


def cabbage(seed: int):
    m = Model(seed)
    m.blob("head", (0, 0.16, 0), (0.13, 0.12, 0.13), 1, 0.05)
    m.rosette("leaf", (0, 0.04, 0), 8, 0.24, 0.2, 0.55, 0.5)
    return m, {"head": "#a9c98f", "leaf": "#6f9c78"}


def broccoli(seed: int):
    m = Model(seed)
    m.cyl("stem", (0, 0, 0), (0, 0.42, 0), 0.03, 0.025)
    m.rosette("leaf", (0, 0.12, 0), 8, 0.32, 0.12, 0.7, 0.45)
    for i in range(7):
        a = i * 0.9
        d = 0 if i == 0 else 0.05
        m.blob("floret", (math.cos(a) * d * 1.5, 0.46 + (0.03 if i == 0 else 0), math.sin(a) * d * 1.5), (0.07, 0.055, 0.07), 1, 0.2)
    return m, {"stem": "#7aa35f", "leaf": "#3f7a4f", "floret": "#2e6a3a"}


def cauliflower(seed: int):
    m = Model(seed)
    m.blob("curd", (0, 0.24, 0), (0.1, 0.07, 0.1), 1, 0.12)
    m.rosette("leaf", (0, 0.04, 0), 10, 0.28, 0.13, 1.0, 0.3)
    return m, {"curd": "#efe8cf", "leaf": "#5d8f62"}


def kale(seed: int):
    m = Model(seed)
    m.cyl("stem", (0, 0, 0), (0, 0.35, 0), 0.02, 0.015)
    for i, y in enumerate([0.12, 0.22, 0.32]):
        m.rosette("leaf", (0, y, 0), 5, 0.28 - i * 0.04, 0.1, 0.9, 0.25)
    return m, {"stem": "#7a9b6a", "leaf": "#2f5f4b"}


def brussels(seed: int):
    m = Model(seed)
    m.cyl("stem", (0, 0, 0), (0, 0.7, 0), 0.03, 0.02)
    for i in range(14):
        y = 0.12 + i * 0.04
        a = i * 2.4
        m.ball("sprout", (math.cos(a) * 0.04, y, math.sin(a) * 0.04), 0.022)
    m.rosette("leaf", (0, 0.68, 0), 7, 0.22, 0.12, 0.6, 0.4)
    return m, {"stem": "#8aa870", "sprout": "#6fa04a", "leaf": "#3e7350"}


def potato(seed: int):
    m = Model(seed)
    r = m.rng
    for _ in range(9):
        a = r.uniform(0, 2 * math.pi)
        d = r.uniform(0, 0.12)
        base = (math.cos(a) * d, 0, math.sin(a) * d)
        m.cyl("stem", base, (base[0] * 2, 0.35 + r.uniform(0, 0.12), base[2] * 2), 0.012, 0.008, 5, False)
    m.blob("leaf", (0, 0.32, 0), (0.24, 0.17, 0.24), 1, 0.25)
    for i in range(4):
        a = i * 1.6
        m.blob("leaf", (math.cos(a) * 0.16, 0.24, math.sin(a) * 0.16), (0.13, 0.1, 0.13), 1, 0.25)
    for _ in range(6):
        a = r.uniform(0, 2 * math.pi)
        m.ball("flower", (math.cos(a) * 0.12, 0.49, math.sin(a) * 0.12), 0.018)
    return m, {"stem": STEM, "leaf": "#4c8a3e", "flower": "#f2f0ff"}


def tomato(seed: int):
    m = Model(seed)
    r = m.rng
    # a wire cage
    for i in range(3):
        a = i * 2 * math.pi / 3
        m.cyl("cage", (math.cos(a) * 0.2, 0, math.sin(a) * 0.2), (math.cos(a) * 0.24, 1.2, math.sin(a) * 0.24), 0.006, 0.006, 4, False)
    for y, rr in [(0.4, 0.21), (0.8, 0.23), (1.15, 0.25)]:
        for i in range(10):
            a0, a1 = i * math.pi / 5, (i + 1) * math.pi / 5
            m.cyl("cage", (math.cos(a0) * rr, y, math.sin(a0) * rr), (math.cos(a1) * rr, y, math.sin(a1) * rr), 0.005, 0.005, 4, False)
    for y, s in [(0.35, 0.2), (0.65, 0.22), (0.95, 0.2), (1.18, 0.14)]:
        m.blob("leaf", (r.uniform(-0.03, 0.03), y, r.uniform(-0.03, 0.03)), (s, 0.18, s), 1, 0.25)
    for _ in range(12):
        a = r.uniform(0, 2 * math.pi)
        m.ball("fruit", (math.cos(a) * 0.19, r.uniform(0.3, 1.05), math.sin(a) * 0.19), 0.035)
    return m, {"cage": "#9aa3ad", "leaf": "#3f7f36", "fruit": "#d8322a"}


def pepper(seed: int):
    m = Model(seed)
    r = m.rng
    m.cyl("stem", (0, 0, 0), (0, 0.35, 0), 0.015, 0.01)
    m.blob("leaf", (0, 0.4, 0), (0.18, 0.17, 0.18), 1, 0.25)
    m.blob("leaf", (0.06, 0.28, -0.04), (0.14, 0.12, 0.14), 1, 0.25)
    for _ in range(6):
        a = r.uniform(0, 2 * math.pi)
        m.ball(r.choice(["red", "green"]), (math.cos(a) * 0.23, r.uniform(0.25, 0.45), math.sin(a) * 0.23), 0.035, 0.06)
    return m, {"stem": STEM, "leaf": "#3d7a34", "red": "#c9302c", "green": "#4e9a2f"}


def zucchini(seed: int):
    m = Model(seed)
    r = m.rng
    m.rosette("leaf", (0, 0.05, 0), 9, 0.5, 0.42, 0.75, 0.6)
    m.rosette("leaf", (0, 0.1, 0), 5, 0.34, 0.3, 1.0, 0.5)
    for _ in range(3):
        a = r.uniform(0, 2 * math.pi)
        m.cyl("fruit", (math.cos(a) * 0.12, 0.04, math.sin(a) * 0.12), (math.cos(a) * 0.36, 0.06, math.sin(a) * 0.36), 0.03, 0.035)
    for _ in range(2):
        a = r.uniform(0, 2 * math.pi)
        m.ball("flower", (math.cos(a) * 0.2, 0.32, math.sin(a) * 0.2), 0.05, 0.04)
    return m, {"leaf": "#3f7d36", "fruit": "#2d5a24", "flower": "#f5b900"}


def row(seed: int, kind: str):
    """A short row (1 m) of carrots or onions."""
    m = Model(seed)
    r = m.rng
    for i in range(10):
        x = -0.45 + i * 0.1 + r.uniform(-0.015, 0.015)
        if kind == "carrot":
            m.ball("root", (x, 0.005, 0), 0.018, 0.012)
            for j in range(5):
                m.leaf("leaf", (x, 0.01, 0), j * 1.26 + r.uniform(-0.3, 0.3), 1.2, 0.22, 0.05, 0.35)
        else:
            m.ball("bulb", (x, 0.02, 0), 0.03, 0.025)
            for j in range(4):
                a = j * 1.57 + r.uniform(-0.3, 0.3)
                m.cyl("leaf", (x, 0.03, 0), (x + math.cos(a) * 0.05, 0.36 + r.uniform(-0.04, 0.04), math.sin(a) * 0.05), 0.007, 0.003, 4, False)
    if kind == "carrot":
        return m, {"root": "#e8822a", "leaf": "#5aa33b"}
    return m, {"bulb": "#d9c68f", "leaf": "#4f8f4a"}


def pole_beans(seed: int):
    m = Model(seed)
    r = m.rng
    m.cyl("pole", (0, 0, 0), (0, 1.8, 0), 0.015, 0.012)
    for i in range(30):
        t = i / 30
        a = t * 12
        p = (math.cos(a) * 0.06, 0.05 + t * 1.65, math.sin(a) * 0.06)
        m.leaf("leaf", p, a + 1.5, 0.2, 0.11, 0.09, 0.4)
        if i % 4 == 2:
            m.cyl("bean", p, (p[0] * 1.6, p[1] - 0.13, p[2] * 1.6), 0.008, 0.006, 4)
    return m, {"pole": "#8a6a4a", "leaf": "#4d8c3a", "bean": "#6aa03a"}


def corn(seed: int):
    m = Model(seed)
    r = m.rng
    m.cyl("stalk", (0, 0, 0), (0, 2.0, 0), 0.022, 0.012)
    for i in range(9):
        y = 0.25 + i * 0.18
        m.leaf("leaf", (0, y, 0), i * 2.6, 0.7, 0.55 - i * 0.03, 0.1, 0.6, 4)
    m.cyl("ear", (0.02, 1.0, 0), (0.07, 1.22, 0.02), 0.03, 0.02)
    for i in range(6):
        m.cyl("tassel", (0, 2.0, 0), (math.cos(i) * 0.12, 1.92, math.sin(i) * 0.12), 0.004, 0.003, 3, False)
    return m, {"stalk": "#7aa154", "leaf": "#5b9a3c", "ear": "#d9c25a", "tassel": "#c9b26a"}


def strawberry(seed: int):
    m = Model(seed)
    r = m.rng
    m.rosette("leaf", (0, 0.02, 0), 9, 0.14, 0.1, 0.8, 0.4)
    for _ in range(6):
        a = r.uniform(0, 2 * math.pi)
        m.ball("berry", (math.cos(a) * 0.12, 0.03, math.sin(a) * 0.12), 0.018, 0.024)
    for _ in range(3):
        a = r.uniform(0, 2 * math.pi)
        m.ball("flower", (math.cos(a) * 0.07, 0.075, math.sin(a) * 0.07), 0.014, 0.006)
    return m, {"leaf": "#3d8a3a", "berry": "#d42a35", "flower": "#ffffff"}


def herb_bush(seed: int, colors: dict, h: float, rx: float, lumps: int = 5, flower: str | None = None, n_flower: int = 0):
    m = Model(seed)
    r = m.rng
    m.blob("leaf", (0, h * 0.55, 0), (rx * 0.7, h * 0.45, rx * 0.7), 1, 0.2)
    for i in range(lumps):
        a = i * 2 * math.pi / lumps + r.uniform(-0.3, 0.3)
        m.blob("leaf2" if "leaf2" in colors else "leaf", (math.cos(a) * rx * 0.45, h * r.uniform(0.3, 0.6), math.sin(a) * rx * 0.45), (rx * 0.45, h * 0.32, rx * 0.45), 1, 0.25)
    for _ in range(n_flower):
        a = r.uniform(0, 2 * math.pi)
        m.ball("flower", (math.cos(a) * rx * 0.4, h * r.uniform(0.85, 1.0), math.sin(a) * rx * 0.4), 0.012)
    return m, {**colors, **({"flower": flower} if flower else {})}


def rosemary(seed: int):
    m = Model(seed)
    r = m.rng
    for _ in range(26):
        a = r.uniform(0, 2 * math.pi)
        d = r.uniform(0, 0.12)
        b = (math.cos(a) * d, 0.0, math.sin(a) * d)
        lean = r.uniform(0.05, 0.3)
        tip = (b[0] + math.cos(a) * lean, r.uniform(0.5, 0.8), b[2] + math.sin(a) * lean)
        m.cyl("leaf", b, tip, 0.025, 0.008, 5)
    for _ in range(10):
        a = r.uniform(0, 2 * math.pi)
        m.ball("flower", (math.cos(a) * 0.2, r.uniform(0.45, 0.7), math.sin(a) * 0.2), 0.012)
    return m, {"leaf": "#5d7f62", "flower": "#8f9ee8"}


def chives(seed: int):
    m = Model(seed)
    r = m.rng
    for i in range(24):
        a = r.uniform(0, 2 * math.pi)
        d = r.uniform(0, 0.04)
        b = (math.cos(a) * d, 0, math.sin(a) * d)
        tip = (b[0] * 2.5, r.uniform(0.22, 0.32), b[2] * 2.5)
        m.cyl("leaf", b, tip, 0.004, 0.002, 3, False)
        if i < 5:
            m.ball("flower", tip, 0.018)
    return m, {"leaf": "#4f9a45", "flower": "#b07ad6"}


def cilantro(seed: int):
    m = Model(seed)
    r = m.rng
    for i in range(14):
        a = i * 2.4
        tip_y = r.uniform(0.18, 0.32)
        tip = (math.cos(a) * 0.08, tip_y, math.sin(a) * 0.08)
        m.cyl("stem", (0, 0, 0), tip, 0.004, 0.003, 3, False)
        m.leaf("leaf", tip, a, 0.3, 0.07, 0.06, 0.3)
    return m, {"stem": "#7fae5c", "leaf": "#5aa443"}


# id, name, builder, library search words
ITEMS = [
    ("apple_tree", "Apple tree", lambda: fruit_tree(11, 4.0, 3.6, "round", "#c8282e", 0.05), ["fruit tree", "apple", "tree", "orchard"]),
    ("pear_tree", "Pear tree", lambda: fruit_tree(12, 4.6, 3.0, "oval", "#c7c24a", 0.045, 0.065), ["fruit tree", "pear", "tree", "orchard"]),
    ("peach_tree", "Peach tree", lambda: fruit_tree(13, 3.4, 3.0, "vase", "#f08a4b", 0.045, None, "#5a9a3e"), ["fruit tree", "peach", "tree", "orchard"]),
    ("lemon_tree", "Lemon tree", lambda: fruit_tree(14, 3.0, 2.8, "round", "#f3d23a", 0.045, 0.06, "#2f6e2e", 26), ["fruit tree", "citrus", "lemon", "tree"]),
    ("orange_tree", "Orange tree", lambda: fruit_tree(15, 3.4, 3.2, "round", "#f28a1c", 0.05, None, "#2f6e2e", 26), ["fruit tree", "citrus", "orange", "tree"]),
    ("lettuce", "Lettuce", lambda: lettuce(21), ["vegetable", "salad", "leafy greens", "butterhead"]),
    ("romaine", "Romaine lettuce", lambda: romaine(22), ["vegetable", "salad", "leafy greens", "lettuce"]),
    ("cabbage", "Cabbage", lambda: cabbage(23), ["vegetable", "brassica"]),
    ("broccoli", "Broccoli", lambda: broccoli(24), ["vegetable", "brassica"]),
    ("cauliflower", "Cauliflower", lambda: cauliflower(25), ["vegetable", "brassica"]),
    ("kale", "Kale", lambda: kale(26), ["vegetable", "brassica", "leafy greens"]),
    ("brussels_sprouts", "Brussels sprouts", lambda: brussels(27), ["vegetable", "brassica"]),
    ("potato", "Potato", lambda: potato(28), ["vegetable", "root", "tuber"]),
    ("tomato", "Tomato (caged)", lambda: tomato(29), ["vegetable", "fruiting", "nightshade"]),
    ("pepper", "Pepper", lambda: pepper(30), ["vegetable", "fruiting", "chili", "bell pepper", "nightshade"]),
    ("zucchini", "Zucchini / squash", lambda: zucchini(31), ["vegetable", "squash", "cucurbit"]),
    ("carrot_row", "Carrots (1 m row)", lambda: row(32, "carrot"), ["vegetable", "root", "row"]),
    ("onion_row", "Onions (1 m row)", lambda: row(33, "onion"), ["vegetable", "allium", "garlic", "row"]),
    ("pole_beans", "Pole beans", lambda: pole_beans(34), ["vegetable", "beans", "legume", "climbing"]),
    ("corn", "Corn", lambda: corn(35), ["vegetable", "maize", "sweet corn"]),
    ("strawberry", "Strawberry", lambda: strawberry(36), ["fruit", "berry"]),
    ("basil", "Basil", lambda: herb_bush(41, {"leaf": "#4f9e3f", "leaf2": "#62b04e"}, 0.4, 0.3, 5, "#f4f0f8", 5), ["herb"]),
    ("rosemary", "Rosemary", lambda: rosemary(42), ["herb", "shrub"]),
    ("thyme", "Thyme", lambda: herb_bush(43, {"leaf": "#6e8d5c"}, 0.15, 0.35, 6, "#d7b7e6", 10), ["herb", "ground cover"]),
    ("mint", "Mint", lambda: herb_bush(44, {"leaf": "#4caf50", "leaf2": "#5cbf5e"}, 0.3, 0.4, 6), ["herb"]),
    ("parsley", "Parsley", lambda: herb_bush(45, {"leaf": "#3f8f37", "leaf2": "#4fa043"}, 0.3, 0.3, 5), ["herb"]),
    ("cilantro", "Cilantro", lambda: cilantro(46), ["herb", "coriander"]),
    ("sage", "Sage", lambda: herb_bush(47, {"leaf": "#8a9e84"}, 0.45, 0.5, 5, "#9a7fd1", 6), ["herb", "shrub"]),
    ("oregano", "Oregano", lambda: herb_bush(48, {"leaf": "#5d8f4a", "leaf2": "#6c9c55"}, 0.25, 0.4, 6, "#e3c3ea", 8), ["herb"]),
    ("chives", "Chives", lambda: chives(49), ["herb", "allium"]),
    # anything else: the plant gets the name typed for it
    ("plant", "Other plant", lambda: herb_bush(50, {"leaf": "#4b9a45", "leaf2": "#5daa52"}, 0.6, 0.45, 7), ["generic", "other", "shrub"]),
    ("flowers", "Flowers", lambda: herb_bush(51, {"leaf": "#4f9440", "leaf2": "#5fa64d"}, 0.45, 0.4, 7, "#e05a8a", 24), ["generic", "flower"]),
]


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    items = []
    for ident, name, build, tags in ITEMS:
        model, colors = build()
        tris = model.glb(OUT / f"{ident}.glb", colors)
        pts = [p for t in model.mats.values() for tri in t for p in tri]
        lo = [min(p[k] for p in pts) for k in range(3)]
        hi = [max(p[k] for p in pts) for k in range(3)]
        size = [round(max(0.02, hi[0] - lo[0]), 2), round(max(0.02, hi[2] - lo[2]), 2), round(max(0.02, hi[1] - lo[1]), 2)]
        tree = "tree" in tags
        items.append(
            {
                "id": ident,
                "name": {"en": name},
                "size": size,
                "model": f"{ident}.glb",
                "tone": "original",
                "edges": False,
                "growth": True,
                "group": "plant",
                "room": ["garden"],
                "tags": tags + ["garden", "plant"] + (["orchard"] if tree else ["bed", "vegetable garden"]),
                "symbol": [{"shape": "circle", "x": 0, "z": 0, "r": 0.5}] if "row" not in tags else [{"shape": "rect", "x": 0, "z": 0, "w": 1, "d": 0.6}],
            }
        )
        print(f"{ident:18} {tris:5} tris  {size}")
    pack = {"id": "local.garden", "name": "Garden", "publisher": "Edgar fork", "release": 2, "description": "Fruit trees, vegetables and herbs, low-poly. Each plant can be drawn at a growth stage from 1 to 10.", "items": items}
    (OUT / "pack.json").write_text(json.dumps(pack, indent=1) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
