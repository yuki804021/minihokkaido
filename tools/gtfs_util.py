"""GTFS・バスのデータを扱う共通の処理 (build_network.py と build_bus.py から使う)"""
import csv
import datetime
import io
import json
import math
import os
import time
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, 'cache')
R = 6371008.8

# 北海道オープンデータプラットフォーム (HODA) の「公共交通GTFSデータ」(CC BY)
HODA_PACKAGE = 'https://ckan.hoda.jp/api/3/action/package_show?id=gtfs-data'

with open(os.path.join(HERE, 'holidays.json'), encoding='utf-8') as f:
    HOLIDAYS = set(json.load(f))


def haversine(a, b):
    la1, la2 = math.radians(a[1]), math.radians(b[1])
    dla, dlo = la2 - la1, math.radians(b[0] - a[0])
    h = math.sin(dla / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin(dlo / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def rnd(c, n=5):
    return [round(c[0], n), round(c[1], n)]


def fetch(url, name, headers=None):
    """url を tools/cache/name に保存する (既にあれば使う)"""
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, name)
    if not os.path.exists(path):
        print('download', url)
        req = urllib.request.Request(url, headers=headers or {'User-Agent': 'MiniHokkaido3D/1.0 (personal)'})
        with urllib.request.urlopen(req, timeout=120) as r, open(path, 'wb') as f:
            f.write(r.read())
    return path


def hoda_resources():
    """HODA の GTFS データの一覧 [(名前, URL)]"""
    path = fetch(HODA_PACKAGE, 'hoda_gtfs_package.json')
    with open(path, encoding='utf-8') as f:
        return [(r['name'], r.get('url') or '') for r in json.load(f)['result']['resources']]


def read_gtfs(zpath):
    with zipfile.ZipFile(zpath) as z:
        def table(name):
            member = next((x for x in z.namelist() if x.split('/')[-1] == name), None)
            if member is None:
                return []
            with z.open(member) as f:
                return list(csv.DictReader(io.TextIOWrapper(f, encoding='utf-8-sig')))
        return {k: table(k + '.txt') for k in ('agency', 'stops', 'routes', 'trips', 'stop_times', 'calendar', 'calendar_dates')}


def gtfs_sec(s):
    h, m, sec = map(int, s.strip().split(':'))
    return h * 3600 + m * 60 + sec


def ymd(d):
    return d.strftime('%Y%m%d')


def is_holiday(d):
    return d.weekday() == 6 or ymd(d) in HOLIDAYS


def reference_dates(today=None):
    """ダイヤを選ぶ基準日: 今日以降の最初の平日・土曜・日祝"""
    today = today or (datetime.datetime.utcnow() + datetime.timedelta(hours=9)).date()
    out = {}
    for k in range(0, 21):
        d = today + datetime.timedelta(days=k)
        if is_holiday(d):
            out.setdefault('holiday', d)
        elif d.weekday() == 5:
            out.setdefault('saturday', d)
        else:
            out.setdefault('weekday', d)
    return out


def runs_on(g):
    """service_id → 日付 d にそのダイヤで走るかを返す関数"""
    cal = {c['service_id']: c for c in g['calendar']}
    extra = {}
    for c in g['calendar_dates']:
        extra[(c['service_id'], c['date'])] = c.get('exception_type')
    days = ('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday')

    def run(service_id, d):
        e = extra.get((service_id, ymd(d)))
        if e == '1':
            return True
        if e == '2':
            return False
        c = cal.get(service_id)
        if not c:
            return False
        if not (c['start_date'] <= ymd(d) <= c['end_date']):
            return False
        # 祝日は日曜のダイヤとみなす (calendar_dates に祝日の指定が無いデータのため)
        dow = 'sunday' if ymd(d) in HOLIDAYS else days[d.weekday()]
        return c.get(dow) == '1'
    return run


def trips_by_id(g):
    times = {}
    for r in g['stop_times']:
        times.setdefault(r['trip_id'], []).append(r)
    for v in times.values():
        v.sort(key=lambda r: int(r['stop_sequence']))
    return times


def simplify(coords, tol=15.0):
    """Douglas-Peucker で折れ線の点を減らす (tol [m])"""
    if len(coords) < 3:
        return coords
    lat0 = coords[0][1]
    kx, ky = 111320 * math.cos(math.radians(lat0)), 110540
    pts = [((c[0]) * kx, (c[1]) * ky) for c in coords]
    keep = [False] * len(coords)
    keep[0] = keep[-1] = True
    stack = [(0, len(coords) - 1)]
    while stack:
        i, j = stack.pop()
        (x1, y1), (x2, y2) = pts[i], pts[j]
        dx, dy = x2 - x1, y2 - y1
        L2 = dx * dx + dy * dy
        best, bi = 0.0, -1
        for k in range(i + 1, j):
            x, y = pts[k]
            if L2 == 0:
                d = math.hypot(x - x1, y - y1)
            else:
                t = max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / L2))
                d = math.hypot(x - x1 - t * dx, y - y1 - t * dy)
            if d > best:
                best, bi = d, k
        if best > tol:
            keep[bi] = True
            stack += [(i, bi), (bi, j)]
    return [c for c, k in zip(coords, keep) if k]


_last_osrm = [0.0]


def road_route(stops):
    """停留所の並び (座標) を道路に沿ってつないだ経路。OSRM の公開サーバ (OpenStreetMap) を使い、結果は保存する。
    取得できなければ None"""
    import hashlib
    key = hashlib.sha1(json.dumps([rnd(c) for c in stops]).encode()).hexdigest()[:16]
    os.makedirs(os.path.join(CACHE, 'osrm'), exist_ok=True)
    path = os.path.join(CACHE, 'osrm', key + '.json')
    if not os.path.exists(path):
        coords = ';'.join(f'{c[0]:.5f},{c[1]:.5f}' for c in stops)
        url = f'https://router.project-osrm.org/route/v1/driving/{coords}?overview=full&geometries=geojson'
        wait = 1.1 - (time.time() - _last_osrm[0])  # 公開サーバの利用上限 (1 秒に 1 回) を守る
        if wait > 0:
            time.sleep(wait)
        _last_osrm[0] = time.time()
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'MiniHokkaido3D/1.0 (personal)'})
            with urllib.request.urlopen(req, timeout=60) as r:
                data = json.load(r)
        except Exception as e:  # 通信できないときは直線にする
            print('  道路の経路を取得できないため直線にする:', e)
            return None
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(data, f)
    with open(path, encoding='utf-8') as f:
        data = json.load(f)
    if data.get('code') != 'Ok' or not data.get('routes'):
        return None
    return data['routes'][0]['geometry']['coordinates']


def split_at_stops(line, stops, max_gap=1500):
    """道路の経路 line を、停留所ごとの区間 (途中の点の並び) に分ける。停留所から遠い区間は直線 ([])"""
    out = []
    prev = 0
    idx = []
    for c in stops:
        best, bj = None, prev
        for j in range(prev, len(line)):
            d = haversine(c, line[j])
            if best is None or d < best:
                best, bj = d, j
        idx.append((bj, best))
        prev = bj
    for k in range(len(stops) - 1):
        (a, da), (b, db) = idx[k], idx[k + 1]
        out.append([rnd(p) for p in line[a + 1:b]] if da < max_gap and db < max_gap and b > a else [])
    return out
