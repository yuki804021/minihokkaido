#!/usr/bin/env python3
"""路線バスの路線図・停留所・時刻表 (data/bus_map.js と data/bus/*.json) を作る。路線バスは地図上では動かさない。

使い方:
    python3 tools/build_bus.py

- 停留所: 「国土数値情報（バス停留所 P11、2022 年度）」のうち、民間・公営の路線バス (コミュニティバス・デマンドバスは除く)
- 路線図: 「国土数値情報（バスルート N07、2022 年度）」のうち、上の路線バスの事業者のもの
- 時刻表: 北海道オープンデータプラットフォーム (HODA) などの時刻表データ (GTFS)。停留所をクリックしたときに読み込む。
  基準日 (次の平日・土曜・日祝) に走る便だけを使う
都市間高速バスは build_network.py で、時刻表どおりに走らせている。
"""
import json
import os
import re
import sys
import unicodedata
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import gtfs_util as gu  # noqa: E402

P11_URL = 'https://nlftp.mlit.go.jp/ksj/gml/data/P11/P11-22/P11-22_01_GML.zip'
N07_URL = 'https://nlftp.mlit.go.jp/ksj/gml/data/N07/N07-22/N07-22_01_GML.zip'
ROUTE_TYPES = {'1', '2'}  # 1: 民間路線バス 2: 公営路線バス (3: コミュニティバス 4: デマンドバス は除く)

# HODA の GTFS のうち、路線バスでないもの (コミュニティバス・フェリー・鉄道など) と、都市間高速バス (別に扱う)
HODA_EXCLUDE = ('コミュニティ', 'フェリー', '観光データ', '札幌市交通局', '函館市電', '星野リゾート', '斜里バス',
                'ひがし北海道', '高速バス')
# HODA に無い (事業者のサイトで公開している) 路線バスの時刻表データ
EXTRA_FEEDS = [
    ('十勝バス', 'https://www.tokachibus.jp/download/20251201GTFS-dia.zip', 'tokachi_bus.zip'),
    ('十勝バス 空港連絡バス', 'https://www.tokachibus.jp/download/20260901GTFS-airport.zip', 'tokachi_airport.zip'),
    ('根室交通', 'https://api.gtfs-data.jp/v2/organizations/nemurokotsu/feeds/nemurobus/files/feed.zip', 'nemuro_bus.zip'),
]
SKIP_ROUTES = {'nemuro_bus.zip': {'札幌線_R'}}  # 都市間高速バスとして走らせている系統


def norm(name):
    return unicodedata.normalize('NFKC', name).replace('ヶ', 'ケ').replace(' ', '').replace('　', '')


# ------------------------------------------------------------------ 国土数値情報
def load_p11():
    xml = zipfile.ZipFile(gu.fetch(P11_URL, 'P11-22_01_GML.zip')).read('P11-22_01_GML/P11-22_01.xml').decode('utf-8')
    pts = {k: v for k, v in re.findall(r'<gml:Point gml:id="(n\d+)">\s*<gml:pos>([\d.]+ [\d.]+)</gml:pos>', xml)}
    stops = []
    for m in re.finditer(r'<ksj:BusStop gml:id="[^"]+">(.*?)</ksj:BusStop>', xml, re.S):
        b = m.group(1)
        lat, lon = map(float, pts[re.search(r'href="#(n\d+)"', b).group(1)].split())
        routes = [(n, t) for n, t in re.findall(r'<ksj:brn>(.*?)</ksj:brn>\s*<ksj:brt>(\d)</ksj:brt>', b)]
        stops.append({'name': re.search(r'<ksj:bsn>(.*?)</ksj:bsn>', b).group(1),
                      'ops': re.findall(r'<ksj:boc>(.*?)</ksj:boc>', b),
                      'routes': [n for n, t in routes if t in ROUTE_TYPES],
                      'types': {t for _, t in routes}, 'c': [lon, lat]})
    return stops


def load_n07(operators):
    xml = zipfile.ZipFile(gu.fetch(N07_URL, 'N07-22_01_GML.zip')).read('N07-22_01_GML/N07-22_01.xml').decode('utf-8')
    curves = {}
    for m in re.finditer(r'<gml:Curve gml:id="(cv\d+)">.*?<gml:posList>(.*?)</gml:posList>', xml, re.S):
        v = list(map(float, m.group(2).split()))
        curves[m.group(1)] = [[v[i + 1], v[i]] for i in range(0, len(v), 2)]
    out = []
    for m in re.finditer(r'<ksj:BusRoute gml:id="[^"]+">\s*<ksj:loc xlink:href="#(cv\d+)"/>\s*<ksj:boc>(.*?)</ksj:boc>', xml, re.S):
        if m.group(2) in operators and m.group(1) in curves:
            out.append((m.group(2), curves[m.group(1)]))
    return out


# ------------------------------------------------------------------ 時刻表
def feeds():
    out = []
    for name, url in gu.hoda_resources():
        if not url.lower().endswith('.zip') or any(x in name for x in HODA_EXCLUDE):
            continue
        out.append((name.split('(')[0].strip(), url, 'hoda_' + url.split('/')[-1]))
    return out + EXTRA_FEEDS


def timetable(name, zpath, ref):
    """停留所ごとの発車時刻 [分, 系統, 行先, 曜日 (1: 平日 2: 土曜 4: 日祝)]。基準日に走らないデータは None"""
    g = gu.read_gtfs(zpath)
    run = gu.runs_on(g)
    skip = SKIP_ROUTES.get(os.path.basename(zpath), set())
    stops = {s['stop_id']: s for s in g['stops']}
    routes = {r['route_id']: r for r in g['routes']}
    times = gu.trips_by_id(g)
    agency = ' ・ '.join(sorted({a['agency_name'] for a in g['agency']})) or name
    groups, key_of = [], {}  # 同じ名前で 200m 以内の停留所 (のりば) はまとめる

    def group_of(stop_id):
        if stop_id in key_of:
            return key_of[stop_id]
        s = stops[stop_id]
        n, c = s['stop_name'], [float(s['stop_lon']), float(s['stop_lat'])]
        for i, gr in enumerate(groups):
            if gr['name'] == n and gu.haversine(gr['c'], c) < 200:
                key_of[stop_id] = i
                return i
        groups.append({'name': n, 'c': c, 'deps': {}})
        key_of[stop_id] = len(groups) - 1
        return key_of[stop_id]

    route_names, heads = [], []

    def index(lst, v):
        if v not in lst:
            lst.append(v)
        return lst.index(v)

    bits = (('weekday', 1), ('saturday', 2), ('holiday', 4))
    ntrips = 0
    for t in g['trips']:
        if t['route_id'] in skip:
            continue
        mask = sum(b for k, b in bits if run(t['service_id'], ref[k]))
        st = times.get(t['trip_id'], [])
        if not mask or len(st) < 2:
            continue
        ntrips += 1
        r = routes.get(t['route_id'], {})
        rn = index(route_names, (r.get('route_short_name') or r.get('route_long_name') or '').strip())
        last = stops[st[-1]['stop_id']]['stop_name']
        for x in st[:-1]:
            if x.get('pickup_type') == '1':  # 乗車できない停留所 (降車専用)
                continue
            h = index(heads, (x.get('stop_headsign') or t.get('trip_headsign') or last).strip())
            m = gu.gtfs_sec(x['departure_time'] or x['arrival_time']) // 60
            deps = groups[group_of(x['stop_id'])]['deps']
            deps[(m, rn, h)] = deps.get((m, rn, h), 0) | mask
    if not ntrips:
        return None
    return {'op': agency, 'routes': route_names, 'heads': heads, 'trips': ntrips,
            'stops': [[gr['name'], gu.rnd(gr['c']), sorted([m, r, h, k] for (m, r, h), k in gr['deps'].items())]
                      for gr in groups if gr['deps']]}


def main():
    ref = gu.reference_dates()
    print('基準日:', {k: v.isoformat() for k, v in ref.items()})

    # 停留所 (路線バスのみ)
    p11 = [s for s in load_p11() if s['types'] & ROUTE_TYPES]
    operators = sorted({op for s in p11 for op in s['ops']})
    print(f'停留所 {len(p11)} (路線バスの事業者 {len(operators)})')

    # 路線図
    routes = load_n07(set(operators))
    lines = [[operators.index(op), [gu.rnd(c) for c in gu.simplify(coords, 8)]] for op, coords in routes]
    print(f'路線図 {len(lines)} 本、{sum(len(c) for _, c in lines)} 点')

    # 時刻表
    out_dir = os.path.join(ROOT, 'data', 'bus')
    os.makedirs(out_dir, exist_ok=True)
    for f in os.listdir(out_dir):
        if f.startswith('tt_') and f.endswith('.json'):
            os.remove(os.path.join(out_dir, f))
    tables, tt_stops = [], []
    for name, url, cache in feeds():
        try:
            tt = timetable(name, gu.fetch(url, cache), ref)
        except Exception as e:  # 読めないデータは飛ばす
            print(f'  {name}: 読み込めないため除外 ({e})')
            continue
        if tt is None:
            print(f'  {name}: 基準日に走る便が無い (期限切れ) ため除外')
            continue
        k = len(tables)
        fn = f'tt_{k:02d}.json'
        with open(os.path.join(out_dir, fn), 'w', encoding='utf-8') as f:
            json.dump(tt, f, ensure_ascii=False, separators=(',', ':'))
        tables.append({'file': f'data/bus/{fn}', 'op': tt['op'], 'source': name})
        for i, (n, c, _) in enumerate(tt['stops']):
            tt_stops.append([n, c, k, i])
        print(f'  {name}: {tt["trips"]} 便、停留所 {len(tt["stops"])}')

    # 国土数値情報に無い停留所 (2022 年以降の新設など) は、時刻表データの停留所を加える
    stops = [[s['name'], gu.rnd(s['c']), [operators.index(o) for o in s['ops']], s['routes']] for s in p11]
    grid = {}
    for i, s in enumerate(stops):
        grid.setdefault((round(s[1][0], 2), round(s[1][1], 2)), []).append(i)

    def near_p11(n, c):
        for dx in (-0.01, 0, 0.01):
            for dy in (-0.01, 0, 0.01):
                for i in grid.get((round(c[0] + dx, 2), round(c[1] + dy, 2)), []):
                    d = gu.haversine(stops[i][1], c)
                    if d < 40 or (d < 300 and norm(stops[i][0]) == norm(n)):
                        return True
        return False
    added = 0
    for n, c, k, _ in tt_stops:
        if not near_p11(n, c):
            op = tables[k]['op']
            if op not in operators:
                operators.append(op)
            stops.append([n, c, [operators.index(op)], []])
            grid.setdefault((round(c[0], 2), round(c[1], 2)), []).append(len(stops) - 1)
            added += 1
    print(f'時刻表データにだけある停留所 {added} を追加')

    # 系統名は停留所ごとに重複が多いので、一覧にして番号で持つ
    route_names = sorted({r for s in stops for r in s[3]})
    for s in stops:
        s[3] = sorted({route_names.index(r) for r in s[3]})

    bus_map = {
        'ref': {k: v.isoformat() for k, v in ref.items()},
        'operators': operators, 'routeNames': route_names,
        'stops': stops, 'lines': lines, 'timetables': tables, 'ttStops': tt_stops,
    }
    out = os.path.join(ROOT, 'data', 'bus_map.js')
    with open(out, 'w', encoding='utf-8') as f:
        f.write('// 路線バスの路線図・停留所・時刻表の索引 (tools/build_bus.py で自動生成)\n')
        f.write('window.BUS_MAP = ')
        json.dump(bus_map, f, ensure_ascii=False, separators=(',', ':'))
        f.write(';\n')
    size = sum(os.path.getsize(os.path.join(out_dir, t['file'].split('/')[-1])) for t in tables)
    print(f'{out}: 停留所 {len(stops)}、路線 {len(lines)}、{os.path.getsize(out) / 1e6:.2f} MB / 時刻表 {len(tables)} 件 {size / 1e6:.2f} MB')


if __name__ == '__main__':
    main()
