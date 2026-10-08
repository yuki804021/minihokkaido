#!/usr/bin/env python3
"""車両の簡易 3D 模型 (glTF バイナリ .glb) を作る。

使い方:
    python3 tools/models/build_models.py

models/ に車種ごとの .glb を書き出す。追加のライブラリは要らない。
寸法・塗装は CARS の設定で決める。形を変えたいときは設定値を変えて作り直すか、
書き出した .glb を Blender で読み込んで作り込み、同じ名前で上書きする。

模型の決まり (アプリ側で地図に置くときの前提):
- 単位はメートル
- +Z が前 (先頭車は運転台が +Z 側)、+Y が上、+X が右
- 原点は車体の中心・レールの高さ
- 1 両ずつの模型。編成はアプリ側で並べる
"""
import json
import math
import os
import struct

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(ROOT, 'models')


# ------------------------------------------------------------------ 形を作る部品
class Mesh:
    """材質 (色) ごとに三角形を集める。面ごとの法線 (角ばった見た目) にする"""

    def __init__(self):
        self.parts = {}  # 材質名 → [(頂点, 法線), ...] (3 つずつで 1 枚の三角形)

    def tri(self, mat, a, b, c):
        n = normal(a, b, c)
        if n is None:
            return
        self.parts.setdefault(mat, []).extend([(a, n), (b, n), (c, n)])

    def quad(self, mat, a, b, c, d):
        self.tri(mat, a, b, c)
        self.tri(mat, a, c, d)

    def box(self, mat, center, size, pitch=0.0):
        """直方体。pitch は X 軸まわりの傾き [度] (前面の窓など)"""
        cx, cy, cz = center
        hx, hy, hz = (s / 2 for s in size)
        p = math.radians(pitch)

        def v(x, y, z):  # 中心まわりに X 軸で回転してから平行移動
            y2 = y * math.cos(p) - z * math.sin(p)
            z2 = y * math.sin(p) + z * math.cos(p)
            return (cx + x, cy + y2, cz + z2)
        c = [v(x, y, z) for x in (-hx, hx) for y in (-hy, hy) for z in (-hz, hz)]
        # c の添字: x(0/1)*4 + y(0/1)*2 + z(0/1)
        for f in ((0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)):
            self.quad(mat, *(c[i] for i in f))

    def loft(self, mat, rings, cap_start=True, cap_end=True):
        """同じ点数の断面 (輪) を Z 方向に並べて、間を面でつなぐ (車体)"""
        n = len(rings[0])
        for r0, r1 in zip(rings, rings[1:]):
            for i in range(n):
                j = (i + 1) % n
                self.quad(mat, r0[i], r0[j], r1[j], r1[i])
        if cap_start:
            self.fan(mat, list(reversed(rings[0])))
        if cap_end:
            self.fan(mat, rings[-1])

    def fan(self, mat, ring):
        cx = sum(p[0] for p in ring) / len(ring)
        cy = sum(p[1] for p in ring) / len(ring)
        cz = sum(p[2] for p in ring) / len(ring)
        for i in range(len(ring)):
            self.tri(mat, (cx, cy, cz), ring[i], ring[(i + 1) % len(ring)])


def normal(a, b, c):
    ux, uy, uz = (b[i] - a[i] for i in range(3))
    vx, vy, vz = (c[i] - a[i] for i in range(3))
    n = (uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
    length = math.sqrt(sum(x * x for x in n))
    return None if length < 1e-12 else tuple(x / length for x in n)


def section(half_w, floor, top, roof_r, z, segs=4):
    """車体の断面 (反時計回り): 床・側面 (すそを少し絞る)・丸い屋根"""
    pts = [(-half_w * 0.94, floor), (half_w * 0.94, floor), (half_w, floor + 0.35)]
    shoulder = top - roof_r
    pts.append((half_w, shoulder))
    for k in range(1, segs):  # 右の肩から屋根の中央へ
        a = math.pi / 2 * k / segs
        pts.append((half_w - roof_r * (1 - math.cos(a)) * 1.6, shoulder + roof_r * math.sin(a)))
    pts.append((0.0, top))
    for x, y in reversed(pts[3:-1]):  # 左右対称
        pts.append((-x, y))
    pts.append((-half_w, floor + 0.35))
    return [(x, y, z) for x, y in pts]


# ------------------------------------------------------------------ 車種の設定
# 寸法は諸元表 (車体長・車体幅) にもとづく概略。塗装は実車を単純化したもの
CARS = {
    'kiha261': {
        'name': 'キハ261系1000番台（新塗装）',
        'length': {'lead': 21.2, 'mid': 20.8},
        'width': 2.80, 'floor': 1.10, 'top': 3.70, 'roof_r': 0.55,
        'colors': {
            'body': ([0.93, 0.94, 0.95], 0.1, 0.45),      # ホワイト
            'window': ([0.08, 0.10, 0.13], 0.2, 0.15),    # 窓 (黒)
            'band': ([0.30, 0.33, 0.37], 0.2, 0.4),       # 窓まわりのグレー
            'accent': ([0.48, 0.36, 0.66], 0.1, 0.4),     # ライラック (パープル) の線
            'nose': ([0.97, 0.77, 0.05], 0.1, 0.4),       # 前面の警戒色 (イエロー)
            'under': ([0.18, 0.19, 0.21], 0.3, 0.7),      # 床下・台車
            'roof': ([0.62, 0.64, 0.67], 0.2, 0.6),       # 屋根の機器
            'light': ([1.0, 0.97, 0.85], 0.0, 0.2),       # 前照灯
        },
        'windows': (2.05, 2.80),   # 側窓の下端・上端の高さ [m]
        'accent_z': (1.85, 1.95),  # 側面の線
        'doors': [-8.9],           # 乗降扉の位置 (車体中心からの Z、片側 1 か所) 先頭車は後ろ寄り
        'nose': {'length': 3.4, 'cab_drop': 0.55, 'tip': 0.62},
        'roof_units': [(-5.5, 2.4), (5.5, 2.4)],  # 冷房装置 (Z, 長さ)
        'pantograph': False,
    },
    'ser733': {
        'name': '733系（札幌圏）',
        'length': {'lead': 21.2, 'mid': 20.8},
        'width': 2.89, 'floor': 1.15, 'top': 3.62, 'roof_r': 0.45,
        'colors': {
            'body': ([0.78, 0.80, 0.82], 0.75, 0.32),     # ステンレス
            'window': ([0.06, 0.07, 0.09], 0.2, 0.15),    # 窓と窓の間 (黒、連続窓に見せる)
            'band': ([0.53, 0.76, 0.15], 0.1, 0.45),      # JR 北海道のライトグリーン (萌黄色)
            'accent': ([0.53, 0.76, 0.15], 0.1, 0.45),
            'nose': ([0.20, 0.22, 0.25], 0.3, 0.4),       # 前面の窓まわり
            'under': ([0.18, 0.19, 0.21], 0.3, 0.7),
            'roof': ([0.55, 0.57, 0.60], 0.5, 0.5),
            'door': ([0.70, 0.72, 0.75], 0.75, 0.35),     # 扉 (ステンレス、やや暗く)
            'light': ([1.0, 0.97, 0.85], 0.0, 0.2),
        },
        'windows': (2.00, 2.85),
        'accent_z': (1.78, 1.92),  # 窓下のライトグリーンの帯
        'doors': [-6.6, 0.0, 6.6],  # 片側 3 扉
        'nose': {'length': 1.6, 'cab_drop': 0.25, 'tip': 0.92},
        'roof_units': [(-6.0, 2.2), (6.0, 2.2)],
        'pantograph': 'mid',       # 中間車 (モハ733) にパンタグラフ
    },
}


def build(car, kind):
    """kind: 'lead' (先頭車、+Z が運転台) または 'mid' (中間車)"""
    c = CARS[car]
    L = c['length'][kind]
    hw, floor, top, rr = c['width'] / 2, c['floor'], c['top'], c['roof_r']
    m = Mesh()
    z0, z1 = -L / 2, L / 2
    nose = c['nose'] if kind == 'lead' else None

    # 車体: 後ろから前へ断面を並べる。先頭車は前の nose['length'] で屋根を下げ、幅を絞って運転台にする
    rings = [section(hw, floor, top, rr, z0)]
    body_end = z1 - (nose['length'] if nose else 0)
    rings.append(section(hw, floor, top, rr, body_end))
    if nose:
        steps = 6
        for k in range(1, steps + 1):
            t = k / steps
            z = body_end + nose['length'] * t
            drop = nose['cab_drop'] * t ** 1.6           # 屋根が前へ下がる
            narrow = 1 - (1 - nose['tip']) * t ** 2.2   # 先端ほど細くなる
            rings.append(section(hw * narrow, floor, top - drop, rr * narrow, z))
    m.loft('body', rings)

    # 側面: 窓の帯 (連続窓に見えるよう黒く塗る)、線、扉。左右とも、車体の表面から少し浮かせて貼る
    w0, w1 = c['windows']
    a0, a1 = c['accent_z']
    side_end = body_end - 0.3
    for sx in (-1, 1):
        x = sx * (hw + 0.012)
        m.box('window', (x, (w0 + w1) / 2, (z0 + 0.6 + side_end) / 2), (0.02, w1 - w0, side_end - z0 - 0.6))
        m.box('accent', (x, (a0 + a1) / 2, (z0 + 0.2 + side_end) / 2), (0.02, a1 - a0, side_end - z0 - 0.2))
        if car == 'kiha261':  # 窓まわりのグレーの帯 (窓の上下に細く)
            m.box('band', (sx * (hw + 0.008), w1 + 0.08, (z0 + 0.4 + side_end) / 2), (0.02, 0.12, side_end - z0 - 0.4))
        doors = c['doors'] if kind == 'lead' or car != 'kiha261' else [-8.7, 8.7]
        for dz in doors:
            x2 = sx * (hw + 0.02)
            m.box(c['colors'].get('door') and 'door' or 'band', (x2, floor + 1.0, dz), (0.02, 1.9, 1.3))
            m.box('window', (sx * (hw + 0.026), floor + 1.45, dz), (0.02, 0.75, 0.9))

    # 先頭部: 前面窓 (傾けた黒い板)、警戒色 (キハ261) や帯、前照灯
    if nose:
        tip_z = z1
        top_front = top - nose['cab_drop']
        fw = hw * nose['tip']
        if car == 'kiha261':
            m.box('nose', (0, floor + 0.75, tip_z - 0.25), (fw * 2 * 0.98, 1.1, 0.55))  # 黄色の前面下部
            # 前面窓: 黄色の上、前面いっぱいに (前面は垂直なので、少し前に浮かせて貼る)
            m.box('window', (0, top_front - 0.42, tip_z + 0.02), (fw * 2 * 0.86, 0.62, 0.04))
        else:
            m.box('nose', (0, top_front - 0.75, tip_z - 0.06), (fw * 2 * 0.95, 1.15, 0.06))  # 窓まわり
            m.box('window', (0, top_front - 0.72, tip_z - 0.02), (fw * 2 * 0.85, 0.9, 0.04))
            m.box('band', (0, floor + 0.62, tip_z - 0.03), (fw * 2 * 0.98, 0.16, 0.06))     # 前面のライトグリーン
        for sx in (-1, 1):
            m.box('light', (sx * fw * 0.62, floor + 0.38 if car == 'kiha261' else floor + 0.95, tip_z + 0.01), (0.32, 0.14, 0.04))
        # スカート (排障器)
        m.box('under', (0, 0.55, tip_z - 0.35), (fw * 2 * 0.95, 0.5, 0.25))

    # 床下・台車
    m.box('under', (0, floor - 0.25, 0), (c['width'] * 0.88, 0.5, L - 1.2))
    for bz in (-(L / 2 - 2.6), L / 2 - 2.6):
        m.box('under', (0, 0.5, bz), (2.3, 0.6, 2.6))
        for wz in (bz - 1.05, bz + 1.05):  # 車輪 (箱で代用)
            for sx in (-1, 1):
                m.box('under', (sx * 0.72, 0.43, wz), (0.12, 0.86, 0.86))

    # 屋根の機器
    for rz, rl in c['roof_units']:
        if nose and rz > body_end - 1:
            continue
        m.box('roof', (0, top + 0.12, rz), (1.6, 0.28, rl))
    if c['pantograph'] == kind:
        pz = -L / 2 + 4.5
        m.box('roof', (0, top + 0.08, pz), (1.3, 0.16, 1.4))                 # 台
        m.box('roof', (0, top + 0.55, pz + 0.55), (0.08, 0.06, 1.5), pitch=-38)  # 下の腕
        m.box('roof', (0, top + 0.95, pz + 0.2), (0.08, 0.06, 1.3), pitch=30)   # 上の腕
        m.box('roof', (0, top + 1.2, pz - 0.3), (1.6, 0.05, 0.12))           # すり板
    return m


# ------------------------------------------------------------------ glTF バイナリの書き出し
def write_glb(mesh, colors, path, name):
    bin_parts, views, accessors, primitives, materials = [], [], [], [], []
    offset = 0

    def add(data, target, comp, count, typ, minmax=None):
        nonlocal offset
        pad = (-len(data)) % 4
        bin_parts.append(data + b'\x00' * pad)
        views.append({'buffer': 0, 'byteOffset': offset, 'byteLength': len(data), 'target': target})
        acc = {'bufferView': len(views) - 1, 'componentType': comp, 'count': count, 'type': typ}
        if minmax:
            acc['min'], acc['max'] = minmax
        accessors.append(acc)
        offset += len(data) + pad
        return len(accessors) - 1

    for mat, verts in mesh.parts.items():
        pos = [v[0] for v in verts]
        nor = [v[1] for v in verts]
        mn = [min(p[i] for p in pos) for i in range(3)]
        mx = [max(p[i] for p in pos) for i in range(3)]
        ip = add(struct.pack(f'<{len(pos) * 3}f', *[x for p in pos for x in p]), 34962, 5126, len(pos), 'VEC3', (mn, mx))
        inn = add(struct.pack(f'<{len(nor) * 3}f', *[x for p in nor for x in p]), 34962, 5126, len(nor), 'VEC3')
        rgb, metal, rough = colors[mat]
        materials.append({'name': mat, 'pbrMetallicRoughness': {'baseColorFactor': rgb + [1.0], 'metallicFactor': metal,
                                                                'roughnessFactor': rough}})
        primitives.append({'attributes': {'POSITION': ip, 'NORMAL': inn}, 'material': len(materials) - 1})

    gltf = {
        'asset': {'version': '2.0', 'generator': 'Mini Hokkaido 3D build_models.py'},
        'scene': 0, 'scenes': [{'nodes': [0]}],
        'nodes': [{'mesh': 0, 'name': name}],
        'meshes': [{'name': name, 'primitives': primitives}],
        'materials': materials, 'accessors': accessors, 'bufferViews': views,
        'buffers': [{'byteLength': offset}],
    }
    js = json.dumps(gltf, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    js += b' ' * ((-len(js)) % 4)
    binary = b''.join(bin_parts)
    with open(path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(binary)))
        f.write(struct.pack('<II', len(js), 0x4E4F534A) + js)
        f.write(struct.pack('<II', len(binary), 0x004E4942) + binary)
    return sum(len(v) for v in mesh.parts.values()) // 3


def main():
    os.makedirs(OUT, exist_ok=True)
    manifest = {}
    for car, c in CARS.items():
        for kind in ('lead', 'mid'):
            fn = f'{car}_{kind}.glb'
            tris = write_glb(build(car, kind), c['colors'], os.path.join(OUT, fn), f'{car}_{kind}')
            manifest[f'{car}_{kind}'] = {'file': f'models/{fn}', 'name': c['name'] + ('（先頭車）' if kind == 'lead' else '（中間車）'),
                                         'length': c['length'][kind], 'triangles': tris}
            print(f'{fn}: 三角形 {tris}、{os.path.getsize(os.path.join(OUT, fn)) / 1024:.0f} KB')
    with open(os.path.join(OUT, 'manifest.json'), 'w', encoding='utf-8') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)


if __name__ == '__main__':
    main()
