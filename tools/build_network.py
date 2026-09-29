#!/usr/bin/env python3
"""北海道の路線・駅・運行パターンのデータ (data/network.js) を作る。

使い方:
    python3 tools/build_network.py

駅の位置と並びは 駅データ.jp (piuccio/open-data-jp-railway-stations 経由) を使う。
取得したファイルは tools/cache/ に保存し、2 回目以降はそれを使う。

線路の形は、いまは駅と駅を直線で結んだ概略。
運転間隔・停車駅・フェリーや航空便の時刻は、すべて制作者による推計。
"""
import json
import math
import os
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE = os.path.join(HERE, 'cache')
STATIONS_URL = 'https://raw.githubusercontent.com/piuccio/open-data-jp-railway-stations/master/stations.json'

R = 6371008.8


# ------------------------------------------------------------------ 幾何
def haversine(a, b):
    la1, la2 = math.radians(a[1]), math.radians(b[1])
    dla, dlo = la2 - la1, math.radians(b[0] - a[0])
    h = math.sin(dla / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin(dlo / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def bearing(a, b):
    la1, la2 = math.radians(a[1]), math.radians(b[1])
    dlo = math.radians(b[0] - a[0])
    y = math.sin(dlo) * math.cos(la2)
    x = math.cos(la1) * math.sin(la2) - math.sin(la1) * math.cos(la2) * math.cos(dlo)
    return math.degrees(math.atan2(y, x)) % 360


def offset(c, brg_deg, dist):
    b = math.radians(brg_deg)
    dlat = dist * math.cos(b) / R
    dlon = dist * math.sin(b) / (R * math.cos(math.radians(c[1])))
    return [c[0] + math.degrees(dlon), c[1] + math.degrees(dlat)]


def rnd(c):
    return [round(c[0], 6), round(c[1], 6)]


def path_length(coords):
    return sum(haversine(coords[i], coords[i + 1]) for i in range(len(coords) - 1))


def densify(coords, step):
    """折れ線を step [m] ごとの点に分ける (航路・飛行経路用)"""
    out = [coords[0]]
    for a, b in zip(coords, coords[1:]):
        n = max(1, int(haversine(a, b) // step))
        for k in range(1, n):
            f = k / n
            out.append([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f])
        out.append(list(b))
    return out


# ------------------------------------------------------------------ 駅データ
def load_stations():
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, 'stations.json')
    if not os.path.exists(path):
        print('download', STATIONS_URL)
        urllib.request.urlretrieve(STATIONS_URL, path)
    with open(path, encoding='utf-8') as f:
        groups = json.load(f)
    lines = {}
    for g in groups:
        for s in g['stations']:
            lines.setdefault(s['ekidata_line_id'], []).append(s)
    for v in lines.values():
        v.sort(key=lambda s: int(s['ekidata_id']))
    return {k: [(s['name_kanji'], [round(s['lon'], 6), round(s['lat'], 6)]) for s in v] for k, v in lines.items()}


EKI = load_stations()

# 駅データ.jp の収録後に廃止された駅 (2021・2022 年の廃止を反映。網羅的ではない)。
# 廃止された区間は、下の LINES で使う区間を選ぶことで除いている
CLOSED = {
    # 2021 年 3 月
    '11103': {'伊納'},
    '11116': {'北日ノ出', '将軍山', '東雲', '生野'},
    '11117': {'南斜里'},
    '11108': {'初田牛'},
    '11115': {'南比布', '北比布', '東六線', '北剣淵', '下士別', '北星', '南美深', '紋穂内', '豊清水', '安牛', '上幌延', '徳満'},
    # 2022 年 3 月
    '11101': {'池田園', '流山温泉', '銚子口', '石谷', '本石倉'},
}

# 駅データ.jp に無い駅
EXTRA = {
    '奥津軽いまべつ': [140.5153, 41.1453],
}


def station_list(line_id):
    closed = CLOSED.get(line_id, set())
    return [(n, c) for n, c in EKI[line_id] if n not in closed]


def take(line_id, a, b):
    """路線 line_id の a 駅から b 駅まで (逆順も可)"""
    lst = station_list(line_id)
    names = [n for n, _ in lst]
    i, j = names.index(a), names.index(b)
    return lst[i:j + 1] if i <= j else list(reversed(lst[j:i + 1]))


def pick(line_id, *names):
    """路線 line_id から駅を名前の順に取り出す (並びを直すとき用)"""
    d = dict(station_list(line_id))
    return [(n, d[n]) for n in names]


def join(*parts):
    out = []
    for p in parts:
        for s in p:
            if out and out[-1][0] == s[0]:
                continue
            out.append(s)
    return out


# ------------------------------------------------------------------ 路線 (線路)
GROUPS = [
    {'id': 'sapporo_subway', 'name': '札幌市営地下鉄'},
    {'id': 'tram', 'name': '路面電車（札幌・函館）'},
    {'id': 'jr', 'name': 'JR北海道 普通・快速'},
    {'id': 'jr_ltd', 'name': 'JR北海道 特急・北海道新幹線'},
    {'id': 'hokkaido_other', 'name': '道南いさりび鉄道'},
    {'id': 'ferry', 'name': 'フェリー・旅客船'},
    {'id': 'air', 'name': '航空便（推計）'},
]

JR_COLOR = '#43A047'

hakodate_main = join(take('11101', '函館', '駒ケ岳'), pick('11101', '森'), take('11101', '森', '長万部'))
hakodate_sawara = join(pick('11101', '大沼'), take('11101', '鹿部', '東森'), pick('11101', '森'))
muroran_main = join(take('11104', '長万部', '本輪西'), take('11104', '東室蘭', '苫小牧'))
muroran_branch = pick('11104', '東室蘭', '輪西', '御崎', '母恋', '室蘭')
chitose_main = join(pick('11109', '沼ノ端', '植苗'), take('11109', '南千歳', '白石'), pick('11109', '苗穂', '札幌'))
chitose_airport = pick('11109', '南千歳', '新千歳空港')
sekisho = join(pick('11110', '南千歳', '追分', '川端', '滝ノ上', '新夕張', '占冠', 'トマム'), pick('11107', '新得'))
shinkansen = [('新函館北斗', dict(EKI['11101'])['新函館北斗']), ('木古内', dict(EKI['99108'])['木古内']),
              ('奥津軽いまべつ', EXTRA['奥津軽いまべつ']), ('新青森', dict(EKI['11202'])['新青森'])]
sapporo_tram = station_list('99104')
sapporo_tram = sapporo_tram + [sapporo_tram[0]]  # 環状運転 (2015 年にループ化)

LINES = [
    # id, 名前, 事業者, グループ, 種別, 色, 駅
    ('subway_namboku', '札幌市営地下鉄 南北線', '札幌市交通局', 'sapporo_subway', 'rail', '#2E9E48', station_list('99102')),
    ('subway_tozai', '札幌市営地下鉄 東西線', '札幌市交通局', 'sapporo_subway', 'rail', '#F39800', station_list('99101')),
    ('subway_toho', '札幌市営地下鉄 東豊線', '札幌市交通局', 'sapporo_subway', 'rail', '#0091D5', station_list('99103')),
    ('sapporo_tram', '札幌市電', '札幌市交通局', 'tram', 'tram', '#7CB342', sapporo_tram),
    ('hakodate_tram2', '函館市電 2系統', '函館市企業局', 'tram', 'tram', '#E57373', station_list('99105')),
    ('hakodate_tram5', '函館市電 5系統', '函館市企業局', 'tram', 'tram', '#4FC3F7', station_list('99106')),
    ('jr_hakodate_s', 'JR函館本線 (函館〜長万部)', 'JR北海道', 'jr', 'rail', JR_COLOR, hakodate_main),
    ('jr_hakodate_sawara', 'JR函館本線 (砂原支線)', 'JR北海道', 'jr', 'rail', JR_COLOR, hakodate_sawara),
    ('jr_hakodate_yama', 'JR函館本線 (長万部〜小樽)', 'JR北海道', 'jr', 'rail', JR_COLOR, station_list('11102')),
    ('jr_hakodate_n', 'JR函館本線 (小樽〜旭川)', 'JR北海道', 'jr', 'rail', JR_COLOR, station_list('11103')),
    ('jr_muroran', 'JR室蘭本線 (長万部〜苫小牧)', 'JR北海道', 'jr', 'rail', JR_COLOR, muroran_main),
    ('jr_muroran_branch', 'JR室蘭本線 (東室蘭〜室蘭)', 'JR北海道', 'jr', 'rail', JR_COLOR, muroran_branch),
    ('jr_muroran_n', 'JR室蘭本線 (苫小牧〜岩見沢)', 'JR北海道', 'jr', 'rail', JR_COLOR, station_list('11105')),
    ('jr_chitose', 'JR千歳線', 'JR北海道', 'jr', 'rail', JR_COLOR, chitose_main),
    ('jr_chitose_airport', 'JR千歳線 (南千歳〜新千歳空港)', 'JR北海道', 'jr', 'rail', JR_COLOR, chitose_airport),
    ('jr_sekisho', 'JR石勝線', 'JR北海道', 'jr', 'rail', JR_COLOR, sekisho),
    ('jr_nemuro_w', 'JR根室本線 (滝川〜富良野)', 'JR北海道', 'jr', 'rail', JR_COLOR, take('11106', '滝川', '富良野')),
    ('jr_nemuro', 'JR根室本線 (新得〜釧路)', 'JR北海道', 'jr', 'rail', JR_COLOR, station_list('11107')),
    ('jr_hanasaki', 'JR根室本線 (花咲線)', 'JR北海道', 'jr', 'rail', JR_COLOR, station_list('11108')),
    ('jr_hidaka', 'JR日高本線', 'JR北海道', 'jr', 'rail', JR_COLOR, take('11111', '苫小牧', '鵡川')),
    ('jr_sassho', 'JR札沼線 (学園都市線)', 'JR北海道', 'jr', 'rail', JR_COLOR, take('11112', '札幌', '北海道医療大学')),
    ('jr_furano', 'JR富良野線', 'JR北海道', 'jr', 'rail', JR_COLOR, station_list('11114')),
    ('jr_soya', 'JR宗谷本線', 'JR北海道', 'jr', 'rail', JR_COLOR, station_list('11115')),
    ('jr_sekihoku', 'JR石北本線', 'JR北海道', 'jr', 'rail', JR_COLOR, station_list('11116')),
    ('jr_senmo', 'JR釧網本線', 'JR北海道', 'jr', 'rail', JR_COLOR, station_list('11117')),
    ('shinkansen', '北海道新幹線 (新函館北斗〜新青森)', 'JR北海道', 'jr_ltd', 'rail', '#7B5EA7', shinkansen),
    ('isaribi', '道南いさりび鉄道線', '道南いさりび鉄道', 'hokkaido_other', 'rail', '#1565C0', station_list('99108')),
]
LINE = {l[0]: l for l in LINES}


def stations_of(line_id):
    return LINE[line_id][6]


def seg(line_id, a, b):
    lst = stations_of(line_id)
    names = [n for n, _ in lst]
    i, j = names.index(a), names.index(b)
    return lst[i:j + 1] if i <= j else list(reversed(lst[j:i + 1]))


# ------------------------------------------------------------------ 運行系統
RAIL = {'kind': 'rail', 'cars': 2, 'carLength': 21, 'width': 2.9, 'height': 4.0, 'speed': 75, 'dwell': 30, 'accel': 30}
LOCAL1 = {**RAIL, 'cars': 1}
# 線路を直線で結んでいて実際より短いので、最高速度は控えめにして所要時間を実際に近づける
LTD = {**RAIL, 'cars': 5, 'speed': 90, 'dwell': 60, 'accel': 40}
SUBWAY = {'kind': 'rail', 'cars': 6, 'carLength': 18, 'width': 3.1, 'height': 3.7, 'speed': 50, 'dwell': 20, 'accel': 15}
TRAM = {'kind': 'tram', 'cars': 1, 'carLength': 13, 'width': 2.4, 'height': 3.8, 'speed': 16, 'dwell': 20, 'accel': 8}

services = []


def service(sid, name, group, line, color, legs, spec, stops=None, **extra):
    """legs: [(路線, 始点, 終点), ...] をつないだ経路。stops を省くと各駅に停車"""
    path = join(*[seg(*leg) for leg in legs])
    names = [n for n, _ in path]
    if stops is not None:
        missing = [s for s in stops if s not in names]
        assert not missing, (sid, missing)
    rows = []
    for i, (n, c) in enumerate(path):
        stop = 1 if stops is None or n in stops or i in (0, len(path) - 1) else 0
        rows.append([n, c, stop])
    sv = {'id': sid, 'name': name, 'group': group, 'line': line, 'color': color, **spec,
          'loop': False, 'both': True, 'offset': 0, 'path': rows}
    sv.update(extra)
    services.append(sv)
    return sv


# 札幌市営地下鉄 (運転間隔は推計)
service('namboku', '南北線', 'sapporo_subway', 'subway_namboku', '#2E9E48', [('subway_namboku', '麻生', '真駒内')],
        {**SUBWAY, 'cars': 6}, bands=[['06:00', '07:30', 6], ['07:30', '09:00', 4], ['09:00', '17:00', 7], ['17:00', '19:30', 5], ['19:30', '24:00', 8]])
service('tozai', '東西線', 'sapporo_subway', 'subway_tozai', '#F39800', [('subway_tozai', '宮の沢', '新さっぽろ')],
        {**SUBWAY, 'cars': 7}, bands=[['06:00', '07:30', 6], ['07:30', '09:00', 4], ['09:00', '17:00', 7], ['17:00', '19:30', 5], ['19:30', '24:00', 8]])
service('toho', '東豊線', 'sapporo_subway', 'subway_toho', '#0091D5', [('subway_toho', '栄町', '福住')],
        {**SUBWAY, 'cars': 4}, bands=[['06:00', '07:30', 8], ['07:30', '09:00', 5], ['09:00', '17:00', 8], ['17:00', '19:30', 6], ['19:30', '24:00', 10]])

# 札幌市電 (ループ線を外回り・内回りで運転)
loop = [[n, c, 1] for n, c in sapporo_tram]
for sid, name, path in (('sapporo_tram_out', '外回り', loop), ('sapporo_tram_in', '内回り', list(reversed(loop)))):
    services.append({'id': sid, 'name': f'札幌市電 {name}', 'group': 'tram', 'line': 'sapporo_tram', 'color': '#7CB342', **TRAM,
                     'loop': True, 'both': False, 'offset': 0 if sid.endswith('out') else 3, 'path': path,
                     'bands': [['06:30', '23:00', 8]]})

# 函館市電
service('hakodate2', '2系統 湯の川〜谷地頭', 'tram', 'hakodate_tram2', '#E57373', [('hakodate_tram2', '湯の川', '谷地頭')],
        TRAM, bands=[['06:30', '22:30', 16]])
service('hakodate5', '5系統 湯の川〜函館どつく前', 'tram', 'hakodate_tram5', '#4FC3F7', [('hakodate_tram5', '湯の川', '函館どつく前')],
        TRAM, bands=[['06:30', '22:30', 12]], offset=6)

# JR北海道 普通・快速 (運転間隔はすべて推計)
LOCALS = [
    # id, 名前, 経路, 仕様, 運転間隔の帯
    ('hakodate_liner', 'はこだてライナー', [('jr_hakodate_s', '函館', '新函館北斗')], {**RAIL, 'cars': 3, 'speed': 85},
     [['06:00', '23:00', 40]], None),
    ('hakodate_mori', '函館本線 普通', [('jr_hakodate_s', '函館', '森')], LOCAL1, [['06:00', '21:00', 120]], None),
    ('hakodate_sawara', '函館本線 普通 (砂原支線経由)', [('jr_hakodate_s', '函館', '大沼'), ('jr_hakodate_sawara', '大沼', '森')],
     LOCAL1, [['07:30', '19:00', 240]], None),
    ('hakodate_oshamambe', '函館本線 普通', [('jr_hakodate_s', '森', '長万部')], LOCAL1, [['06:00', '20:00', 180]], None),
    ('yamasen_kutchan', '函館本線 普通 (山線)', [('jr_hakodate_yama', '長万部', '倶知安')], LOCAL1, [['06:00', '19:00', 180]], None),
    ('yamasen_otaru', '函館本線 普通 (山線)', [('jr_hakodate_yama', '倶知安', '小樽')], RAIL, [['06:00', '21:30', 60]], None),
    ('sapporo_otaru', '函館本線 普通', [('jr_hakodate_n', '小樽', '江別')], {**RAIL, 'cars': 6, 'speed': 80},
     [['05:40', '07:00', 30], ['07:00', '09:00', 15], ['09:00', '23:30', 20]], None),
    ('sapporo_iwamizawa', '函館本線 普通', [('jr_hakodate_n', '札幌', '岩見沢')], {**RAIL, 'cars': 4, 'speed': 80},
     [['06:00', '23:30', 30]], None),
    ('iwamizawa_asahikawa', '函館本線 普通', [('jr_hakodate_n', '岩見沢', '旭川')], RAIL, [['06:00', '21:30', 90]], None),
    ('chitose_local', '千歳線 普通', [('jr_chitose', '札幌', '千歳')], {**RAIL, 'cars': 4, 'speed': 80},
     [['06:00', '23:30', 30]], None),
    ('chitose_tomakomai', '千歳線 普通', [('jr_chitose', '千歳', '沼ノ端'), ('jr_muroran_n', '沼ノ端', '苫小牧')], RAIL,
     [['06:00', '22:30', 60]], None),
    ('muroran_local', '室蘭本線 普通', [('jr_muroran', '苫小牧', '東室蘭'), ('jr_muroran_branch', '東室蘭', '室蘭')], RAIL,
     [['06:00', '22:00', 60]], None),
    ('muroran_oshamambe', '室蘭本線 普通', [('jr_muroran', '東室蘭', '長万部')], LOCAL1, [['06:00', '20:00', 180]], None),
    ('muroran_iwamizawa', '室蘭本線 普通', [('jr_muroran_n', '苫小牧', '岩見沢')], LOCAL1, [['06:00', '20:30', 150]], None),
    ('hidaka_local', '日高本線 普通', [('jr_hidaka', '苫小牧', '鵡川')], LOCAL1, [['06:00', '21:00', 120]], None),
    ('sekisho_local', '石勝線 普通', [('jr_sekisho', '南千歳', '新夕張')], LOCAL1, [['06:30', '19:30', 180]], None),
    ('sassho_local', '学園都市線 普通', [('jr_sassho', '札幌', '北海道医療大学')], {**RAIL, 'cars': 4, 'speed': 80},
     [['06:00', '23:30', 30]], None),
    ('sassho_ainosato', '学園都市線 普通', [('jr_sassho', '札幌', 'あいの里公園')], {**RAIL, 'cars': 4, 'speed': 80},
     [['06:15', '22:00', 30]], None),
    ('furano_biei', '富良野線 普通', [('jr_furano', '旭川', '美瑛')], LOCAL1, [['06:00', '22:00', 60]], None),
    ('furano_local', '富良野線 普通', [('jr_furano', '美瑛', '富良野')], LOCAL1, [['06:30', '20:30', 120]], None),
    ('nemuro_takikawa', '根室本線 普通', [('jr_nemuro_w', '滝川', '富良野')], LOCAL1, [['06:00', '20:00', 120]], None),
    ('nemuro_obihiro', '根室本線 普通', [('jr_nemuro', '新得', '池田')], LOCAL1, [['06:00', '21:00', 120]], None),
    ('nemuro_kushiro', '根室本線 普通', [('jr_nemuro', '池田', '釧路')], LOCAL1, [['06:00', '20:00', 180]], None),
    ('hanasaki', '花咲線 普通', [('jr_hanasaki', '釧路', '根室')], LOCAL1, [['06:00', '19:00', 180]], None),
    ('soya_nayoro', '宗谷本線 普通', [('jr_soya', '旭川', '名寄')], LOCAL1, [['06:00', '21:30', 90]], None),
    ('soya_wakkanai', '宗谷本線 普通', [('jr_soya', '名寄', '稚内')], LOCAL1, [['06:00', '18:00', 240]], None),
    ('sekihoku_kamikawa', '石北本線 普通', [('jr_sekihoku', '旭川', '上川')], LOCAL1, [['06:00', '20:00', 150]], None),
    ('sekihoku_kitami', '石北本線 普通', [('jr_sekihoku', '遠軽', '北見')], LOCAL1, [['06:00', '19:00', 180]], None),
    ('sekihoku_abashiri', '石北本線 普通', [('jr_sekihoku', '北見', '網走')], LOCAL1, [['06:00', '21:00', 120]], None),
    ('senmo_shari', '釧網本線 普通', [('jr_senmo', '網走', '知床斜里')], LOCAL1, [['06:00', '20:00', 120]], None),
    ('senmo_kushiro', '釧網本線 普通', [('jr_senmo', '知床斜里', '釧路')], LOCAL1, [['06:00', '18:00', 180]], None),
]
for i, (sid, name, legs, spec, bands, stops) in enumerate(LOCALS):
    service(sid, name, 'jr', legs[0][0], JR_COLOR, legs, spec, stops, bands=bands, offset=(i * 7) % 20)

service('airport', '快速 エアポート', 'jr', 'jr_chitose', '#1E88E5',
        [('jr_chitose', '札幌', '南千歳'), ('jr_chitose_airport', '南千歳', '新千歳空港')],
        {**RAIL, 'cars': 6, 'speed': 110, 'dwell': 40}, ['札幌', '新札幌', '北広島', '恵庭', '千歳', '南千歳', '新千歳空港'],
        bands=[['05:40', '06:30', 20], ['06:30', '23:00', 12]], offset=3)

# 特急 (停車駅は主なもの。本数・時刻は推計)
SAP_TOMAKOMAI = [('jr_chitose', '札幌', '沼ノ端'), ('jr_muroran_n', '沼ノ端', '苫小牧')]
SAP_HAKO = SAP_TOMAKOMAI + [('jr_muroran', '苫小牧', '長万部'), ('jr_hakodate_s', '長万部', '函館')]
LIMITED = [
    ('hokuto', '特急 北斗', SAP_HAKO, '#E53935',
     ['札幌', '新札幌', '南千歳', '苫小牧', '登別', '東室蘭', '伊達紋別', '洞爺', '長万部', '八雲', '森', '大沼公園', '新函館北斗', '五稜郭', '函館'],
     {'bands': [['06:00', '19:30', 75]]}),
    ('suzuran', '特急 すずらん', SAP_TOMAKOMAI + [('jr_muroran', '苫小牧', '東室蘭'), ('jr_muroran_branch', '東室蘭', '室蘭')], '#8E24AA',
     ['札幌', '新札幌', '南千歳', '苫小牧', '白老', '登別', '幌別', '東室蘭', '室蘭'],
     {'bands': [['07:00', '21:00', 150]], 'offset': 20}),
    ('lilac', '特急 ライラック・カムイ', [('jr_hakodate_n', '札幌', '旭川')], '#2E7D32',
     ['札幌', '岩見沢', '美唄', '砂川', '滝川', '深川', '旭川'],
     {'bands': [['06:30', '22:30', 30]]}),
    ('soya', '特急 宗谷', [('jr_hakodate_n', '札幌', '旭川'), ('jr_soya', '旭川', '稚内')], '#FFB300',
     ['札幌', '岩見沢', '滝川', '深川', '旭川', '和寒', '士別', '名寄', '美深', '音威子府', '幌延', '豊富', '南稚内', '稚内'],
     {'departures': ['07:30'], 'departuresReturn': ['17:45']}),
    ('sarobetsu', '特急 サロベツ', [('jr_soya', '旭川', '稚内')], '#FFD54F',
     ['旭川', '和寒', '士別', '名寄', '美深', '音威子府', '幌延', '豊富', '南稚内', '稚内'],
     {'departures': ['12:45', '18:00'], 'departuresReturn': ['06:40', '13:30']}),
    ('okhotsk', '特急 オホーツク', [('jr_hakodate_n', '札幌', '旭川'), ('jr_sekihoku', '旭川', '網走')], '#26A69A',
     ['札幌', '岩見沢', '滝川', '深川', '旭川', '上川', '丸瀬布', '遠軽', '生田原', '留辺蘂', '北見', '端野', '美幌', '女満別', '網走'],
     {'departures': ['06:50', '17:30'], 'departuresReturn': ['06:20', '17:25']}),
    ('taisetsu', '特急 大雪', [('jr_sekihoku', '旭川', '網走')], '#80CBC4',
     ['旭川', '上川', '丸瀬布', '遠軽', '生田原', '留辺蘂', '北見', '端野', '美幌', '女満別', '網走'],
     {'departures': ['10:40', '18:10'], 'departuresReturn': ['09:30', '13:40']}),
    ('oozora', '特急 おおぞら', [('jr_chitose', '札幌', '南千歳'), ('jr_sekisho', '南千歳', '新得'), ('jr_nemuro', '新得', '釧路')], '#1E88E5',
     ['札幌', '新札幌', '南千歳', '追分', 'トマム', '新得', '芽室', '帯広', '池田', '浦幌', '白糠', '釧路'],
     {'bands': [['06:50', '19:30', 150]]}),
    ('tokachi', '特急 とかち', [('jr_chitose', '札幌', '南千歳'), ('jr_sekisho', '南千歳', '新得'), ('jr_nemuro', '新得', '帯広')], '#90CAF9',
     ['札幌', '新札幌', '南千歳', 'トマム', '新得', '十勝清水', '芽室', '帯広'],
     {'bands': [['07:50', '21:00', 180]], 'offset': 30}),
]
for sid, name, legs, color, stops, extra in LIMITED:
    service(sid, name, 'jr_ltd', legs[-1][0], color, legs, LTD, stops, **extra)

service('hayabusa', '北海道新幹線 はやぶさ', 'jr_ltd', 'shinkansen', '#7B5EA7', [('shinkansen', '新函館北斗', '新青森')],
        {'kind': 'rail', 'cars': 10, 'carLength': 25, 'width': 3.4, 'height': 4.0, 'speed': 160, 'dwell': 60, 'accel': 60},
        bands=[['06:35', '21:30', 70]])

# 道南いさりび鉄道
service('isaribi_local', '道南いさりび鉄道 普通', 'hokkaido_other', 'isaribi', '#1565C0', [('isaribi', '木古内', '函館')],
        LOCAL1, bands=[['06:00', '22:00', 90]])
service('isaribi_kamiiso', '道南いさりび鉄道 普通', 'hokkaido_other', 'isaribi', '#1565C0', [('isaribi', '上磯', '函館')],
        LOCAL1, bands=[['06:30', '21:00', 90]], offset=45)

# ------------------------------------------------------------------ フェリー・旅客船 (航路の形は概略、時刻は推計)
FERRY_LINES = []
BIG = {'kind': 'ship', 'cars': 1, 'carLength': 190, 'width': 27, 'height': 22, 'dwell': 1800, 'accel': 300}
MID = {'kind': 'ship', 'cars': 1, 'carLength': 95, 'width': 16, 'height': 13, 'dwell': 600, 'accel': 120}
SMALL = {'kind': 'ship', 'cars': 1, 'carLength': 45, 'width': 9, 'height': 8, 'dwell': 300, 'accel': 60}

HAKODATE_PORT = ('函館港', [140.7065, 41.8010])
AOMORI_PORT = ('青森港', [140.7010, 40.8420])
OMA_PORT = ('大間港', [140.9050, 41.5310])
TOMAKOMAI_PORT = ('苫小牧港', [141.6200, 42.6300])
HACHINOHE_PORT = ('八戸港', [141.5350, 40.5480])
OTARU_PORT = ('小樽港', [141.0210, 43.1970])
WAKKANAI_PORT = ('稚内港', [141.6880, 45.4140])
OSHIDOMARI = ('鴛泊港（利尻島）', [141.2430, 45.2430])
KAFUKA = ('香深港（礼文島）', [141.0450, 45.3040])
HABORO = ('羽幌港', [141.6950, 44.3650])
YAGISHIRI = ('焼尻港', [141.4250, 44.4350])
TEURI = ('天売港', [141.3350, 44.4150])
ESASHI = ('江差港', [140.1250, 41.8680])
OKUSHIRI = ('奥尻港', [139.5200, 42.1700])


def duration(coords, stops, spec, speed):
    """sim.js と同じ計算で、始発から終点までの所要時間 [秒]"""
    v = speed / 3.6
    t, last, first = 0.0, 0, True
    cum = [0.0]
    for i in range(1, len(coords)):
        cum.append(cum[-1] + haversine(coords[i - 1], coords[i]))
    for i in range(1, len(coords)):
        if not (stops[i] or i == len(coords) - 1):
            continue
        t += (cum[i] - cum[last]) / v + spec['accel'] * 2
        if i != len(coords) - 1:
            t += spec['dwell']
        last = i
    return t


def hhmm(sec):
    sec = int(round(sec)) % 86400
    return f'{sec // 3600:02d}:{sec // 60 % 60:02d}'


def sec_of(s):
    h, m = map(int, s.split(':'))
    return h * 3600 + m * 60


def ferry(sid, name, points, spec, minutes, departures=None, departures_return=None, arrivals_return=None, bands=None, note='運航パターンは推計。航路の形は概略'):
    """points: 港 (名前, 座標) と途中の点 ([lon, lat]) の並び。minutes: 始発港から終点までの所要時間 [分]"""
    raw = [(p[0], p[1], 1) if isinstance(p, tuple) else ('', p, 0) for p in points]
    coords = [r[1] for r in raw]
    stops = [r[2] for r in raw]
    # 所要時間に合わせて速度を決める
    lo, hi = 1.0, 200.0
    for _ in range(60):
        mid = (lo + hi) / 2
        if duration(coords, stops, spec, mid) > minutes * 60:
            lo = mid
        else:
            hi = mid
    speed = round(hi, 1)
    path = []
    dense = densify(coords, 2000)
    # 港は densify 後も元の座標のまま残る (始点・終点・各区間の端点)
    ports = {tuple(c): n for n, c, s in raw if s}
    for c in dense:
        n = ports.get(tuple(c), '')
        path.append([n, rnd(c), 1 if n else 0])
    sv = {**spec, 'id': sid, 'name': name, 'group': 'ferry', 'line': sid, 'color': '#e8eef5', 'speed': speed,
          'loop': False, 'both': True, 'offset': 0, 'note': note, 'path': path}
    if bands:
        sv['bands'] = bands
    if departures:
        sv['departures'] = departures
    if arrivals_return:
        # 帰りは終点 (沖合) を出る時刻を、始発港に着く時刻から逆算する
        d = duration(list(reversed(coords)), list(reversed(stops)), spec, speed)
        departures_return = [hhmm(sec_of(a) - d) for a in arrivals_return]
    if departures_return:
        sv['departuresReturn'] = sorted(departures_return)
    services.append(sv)
    FERRY_LINES.append({'id': sid, 'name': name, 'operator': name.split('（')[0], 'group': 'ferry', 'kind': 'ship', 'color': '#e8eef5',
                        'stations': [[n, c] for n, c, s in raw if s], 'shape': [rnd(c) for c in coords]})


ferry('ferry_seikan', '津軽海峡フェリー・青函フェリー（函館〜青森）',
      [HAKODATE_PORT, [140.690, 41.770], [140.665, 41.720], [140.660, 41.600], [140.690, 41.440], [140.725, 41.250],
       [140.740, 41.120], [140.750, 40.970], [140.725, 40.875], AOMORI_PORT],
      BIG, 225, bands=[['00:30', '23:59', 90]])
ferry('ferry_oma', '津軽海峡フェリー（函館〜大間）',
      [HAKODATE_PORT, [140.690, 41.770], [140.665, 41.720], [140.750, 41.620], [140.880, 41.550], OMA_PORT],
      MID, 90, departures=['09:30', '16:00'], departures_return=['07:00', '13:30'])
ferry('ferry_hachinohe', 'シルバーフェリー（苫小牧〜八戸）',
      [TOMAKOMAI_PORT, [141.630, 42.550], [141.800, 42.000], [141.850, 41.500], [141.700, 40.900], [141.570, 40.580], HACHINOHE_PORT],
      BIG, 450, departures=['01:00', '05:00', '13:30', '21:15'], departures_return=['00:30', '08:30', '17:00', '22:00'])
ferry('ferry_pacific', 'さんふらわあ・太平洋フェリー（苫小牧〜大洗・仙台）',
      [TOMAKOMAI_PORT, [141.630, 42.550], [141.900, 42.100], [142.100, 41.600], ('大洗・仙台方面', [142.150, 41.300])],
      BIG, 240, departures=['01:30', '18:45', '19:00'], arrivals_return=['11:00', '13:30', '19:45'],
      note='運航パターンは推計。航路の形は概略で、北海道の沖合で出現・消滅します')
ferry('ferry_shinnihonkai', '新日本海フェリー（小樽〜新潟・舞鶴）',
      [OTARU_PORT, [141.050, 43.260], [140.700, 43.400], [140.350, 43.450], [140.100, 43.300], ('新潟・舞鶴方面', [139.950, 43.000])],
      BIG, 240, departures=['17:00', '23:30'], arrivals_return=['04:30', '20:45'],
      note='運航パターンは推計。航路の形は概略で、北海道の沖合で出現・消滅します')
ferry('ferry_rishiri', 'ハートランドフェリー（稚内〜利尻島）',
      [WAKKANAI_PORT, [141.700, 45.440], [141.660, 45.475], [141.600, 45.465], [141.400, 45.330], OSHIDOMARI],
      MID, 100, departures=['07:15', '11:25', '15:30'], departures_return=['09:25', '13:40', '17:30'])
ferry('ferry_rebun', 'ハートランドフェリー（稚内〜礼文島）',
      [WAKKANAI_PORT, [141.700, 45.440], [141.660, 45.475], [141.600, 45.465], [141.350, 45.400], [141.100, 45.330], KAFUKA],
      MID, 115, departures=['06:20', '10:35', '14:40'], departures_return=['08:40', '12:50', '16:45'])
ferry('ferry_rishiri_rebun', 'ハートランドフェリー（利尻島〜礼文島）',
      [OSHIDOMARI, [141.180, 45.290], KAFUKA],
      MID, 45, departures=['09:10', '14:20'], departures_return=['08:10', '15:30'])
ferry('ferry_haboro', '羽幌沿海フェリー（羽幌〜焼尻島〜天売島）',
      [HABORO, YAGISHIRI, TEURI],
      SMALL, 75, departures=['08:30', '13:30'], departures_return=['10:30', '15:40'])
ferry('ferry_okushiri', 'ハートランドフェリー（江差〜奥尻島）',
      [ESASHI, OKUSHIRI],
      MID, 130, departures=['12:30'], departures_return=['09:00'])

# ------------------------------------------------------------------ 空港・航空便 (位置は概略、便数・時刻は推計)
AIRPORTS = [
    # id, 名前, 座標, 滑走路の向き (真方位), 長さ, 運用時間
    ('CTS', '新千歳空港', [141.6923, 42.7752], 1, 3000, ['0000', '2400']),
    ('OKD', '丘珠空港', [141.3814, 43.1176], 131, 1500, ['0800', '2000']),
    ('HKD', '函館空港', [140.8219, 41.7700], 111, 3000, ['0730', '2130']),
    ('AKJ', '旭川空港', [142.4475, 43.6708], 151, 2500, ['0800', '2130']),
    ('KUH', 'たんちょう釧路空港', [144.1929, 43.0410], 161, 2500, ['0800', '2130']),
    ('OBO', 'とかち帯広空港', [143.2172, 42.7333], 161, 2500, ['0800', '2130']),
    ('MMB', '女満別空港', [144.1642, 43.8806], 171, 2500, ['0800', '2130']),
    ('SHB', '中標津空港', [144.9600, 43.5775], 71, 2000, ['0830', '2030']),
    ('MBE', 'オホーツク紋別空港', [143.4042, 44.3039], 131, 2000, ['0830', '2030']),
    ('WKJ', '稚内空港', [141.8008, 45.4042], 71, 2200, ['0830', '2030']),
    ('RIS', '利尻空港', [141.1864, 45.2420], 61, 1800, ['0830', '1830']),
    ('OIR', '奥尻空港', [139.4331, 42.0717], 131, 1500, ['0830', '1830']),
]
AP = {a[0]: a for a in AIRPORTS}

DEST = {
    '羽田': [139.7798, 35.5494], '成田': [140.3864, 35.7647], '伊丹': [135.4383, 34.7855], '関西': [135.2440, 34.4347],
    '中部': [136.8053, 34.8584], '神戸': [135.2239, 34.6328], '福岡': [130.4511, 33.5859], '仙台': [140.9170, 38.1397],
    '那覇': [127.6461, 26.1958], '新潟': [139.1206, 37.9559], '広島': [132.9194, 34.4361], '茨城': [140.4147, 36.1811],
    '花巻': [141.1353, 39.4286], '三沢': [141.3683, 40.7033], '松本': [137.9228, 36.1667],
    'ソウル（仁川）': [126.4505, 37.4602], '台北（桃園）': [121.2328, 25.0797], '香港': [113.9185, 22.3080],
    '上海（浦東）': [121.8053, 31.1443], 'バンコク': [100.7501, 13.6900], 'シンガポール': [103.9915, 1.3644],
}
INTL = {'ソウル（仁川）', '台北（桃園）', '香港', '上海（浦東）', 'バンコク', 'シンガポール'}

# 道外との便: 空港ごとに (行き先, 1 日の便数)
EXTERNAL = {
    'CTS': [('羽田', 48), ('成田', 14), ('伊丹', 12), ('関西', 9), ('中部', 11), ('神戸', 5), ('福岡', 8), ('仙台', 7),
            ('那覇', 3), ('新潟', 3), ('広島', 2), ('茨城', 2), ('花巻', 2),
            ('ソウル（仁川）', 10), ('台北（桃園）', 6), ('香港', 3), ('上海（浦東）', 2), ('バンコク', 2), ('シンガポール', 1)],
    'OKD': [('三沢', 1), ('松本', 1)],
    'HKD': [('羽田', 8), ('伊丹', 2), ('中部', 1), ('成田', 1), ('台北（桃園）', 1)],
    'AKJ': [('羽田', 7), ('中部', 1)],
    'KUH': [('羽田', 6)],
    'OBO': [('羽田', 7)],
    'MMB': [('羽田', 6), ('中部', 1)],
    'SHB': [('羽田', 1)],
    'MBE': [('羽田', 1)],
    'WKJ': [('羽田', 1)],
}
# 道内の便: (空港, 空港, 片道 1 日の便数)
INTERNAL = [
    ('OKD', 'HKD', 3), ('OKD', 'KUH', 3), ('OKD', 'MMB', 2), ('OKD', 'RIS', 1), ('OKD', 'OIR', 1),
    ('CTS', 'MMB', 3), ('CTS', 'WKJ', 2), ('CTS', 'RIS', 1), ('CTS', 'SHB', 1), ('HKD', 'OIR', 1),
]

PLANE = {'kind': 'plane', 'cars': 1, 'carLength': 40, 'width': 36, 'height': 6, 'speed': 480, 'dwell': 0, 'accel': 150}
CRUISE = 6000
CLIMB = 80      # 上昇 [m/km]
DESCENT = 52.5  # 降下 [m/km] (約 3 度)
DEP_LEN = 170_000
ARR_LEN = 200_000


def threshold(ap):
    _, _, c, hdg, runway, _ = ap
    return offset(c, hdg + 180, runway / 2)


def dep_track(ap, target, length):
    """離陸: 滑走路の向きにまっすぐ上昇し、行き先の方向へ旋回する (1km ごとの点)"""
    hdg = ap[3]
    pts = [threshold(ap)]
    brg = hdg
    for k in range(1, int(length // 1000) + 1):
        if k > 8:
            want = bearing(pts[-1], target)
            diff = (want - brg + 540) % 360 - 180
            brg += max(-4, min(4, diff))
        pts.append(offset(pts[-1], brg, 1000))
    return pts


def arr_track(ap, origin, length):
    """着陸: 行き先 (出発地) の方向から回り込み、滑走路の向きに合わせて降りる"""
    hdg = ap[3]
    back = [offset(threshold(ap), hdg, 1500), threshold(ap)]  # 着地後 1.5km 滑走
    brg = hdg + 180
    for k in range(1, int(length // 1000) + 1):
        if k > 12:
            want = bearing(back[-1], origin)
            diff = (want - brg + 540) % 360 - 180
            brg += max(-4, min(4, diff))
        back.append(offset(back[-1], brg, 1000))
    return list(reversed(back))


def alt_profile(coords, climb=True, descend=True):
    cum = [0.0]
    for i in range(1, len(coords)):
        cum.append(cum[-1] + haversine(coords[i - 1], coords[i]))
    total = cum[-1]
    out = []
    for d in cum:
        a = CRUISE
        if climb:
            a = min(a, max(0.0, (d - 1000) / 1000 * CLIMB))
        if descend:
            a = min(a, max(0.0, (total - d - 1500) / 1000 * DESCENT))
        out.append([round(d), round(a)])
    return out


def spread(n, start, end, shift):
    """n 便を start〜end [分] に均等に並べる"""
    span = end - start
    return [hhmm((start + span * (i + 0.5) / n + shift) * 60) for i in range(n)]


def hours_min(ap):
    a, b = ap[5]
    s = int(a[:2]) * 60 + int(a[2:])
    e = int(b[:2]) * 60 + int(b[2:])
    if e - s >= 1440:
        s, e = 7 * 60, 21 * 60 + 30
    return s, e


def path_rows(coords, first, last):
    rows = [['', rnd(c), 0] for c in coords]
    rows[0] = [first, rows[0][1], 1]
    rows[-1] = [last, rows[-1][1], 1]
    return rows


plane_services = []
for code, routes in EXTERNAL.items():
    ap = AP[code]
    s, e = hours_min(ap)
    for i, (dest, n) in enumerate(routes):
        target = DEST[dest]
        dep = dep_track(ap, target, DEP_LEN)
        arr = arr_track(ap, target, ARR_LEN)
        base = {**PLANE, 'group': 'air', 'line': f'air_{code}', 'color': '#f5f7fa', 'loop': False, 'both': False, 'offset': 0,
                'airport': code, 'intl': dest in INTL}
        shift = (i * 11) % 30 - 15
        plane_services.append({**base, 'id': f'air_{code}_{i}_dep', 'name': f'{ap[1]} ⇄ {dest}',
                               'path': path_rows(dep, ap[1], dest), 'alt': alt_profile(dep, descend=False),
                               'departures': spread(n, s + 30, e - 45, shift), 'flight': 'dep',
                               'fromName': ap[1], 'toName': dest})
        # 到着便: 着陸の時刻が運用時間に収まるよう、進入開始の時刻を決める
        arr_dur = path_length(arr) / (PLANE['speed'] / 3.6) + PLANE['accel'] * 2
        lands = spread(n, s + 45, e - 15, -shift)
        plane_services.append({**base, 'id': f'air_{code}_{i}_arr', 'name': f'{dest} ⇄ {ap[1]}',
                               'path': path_rows(arr, dest, ap[1]), 'alt': alt_profile(arr, climb=False),
                               'departures': sorted(hhmm(sec_of(t) - arr_dur) for t in lands), 'flight': 'arr',
                               'fromName': dest, 'toName': ap[1]})

for i, (a, b, n) in enumerate(INTERNAL):
    for j, (x, y) in enumerate(((a, b), (b, a))):
        apx, apy = AP[x], AP[y]
        dist = haversine(apx[2], apy[2])
        # 出発側は旋回して相手の空港へ向かい、到着側は相手の滑走路へ回り込む。中間は直線でつなぐ
        dep = dep_track(apx, apy[2], min(40_000, dist * 0.3))
        arr = arr_track(apy, apx[2], min(60_000, dist * 0.4))
        mid = densify([dep[-1], arr[0]], 1000)[1:-1]
        coords = dep + mid + arr
        s, e = hours_min(apx)
        s2, e2 = hours_min(apy)
        dur = path_length(coords) / (PLANE['speed'] / 3.6) + PLANE['accel'] * 2
        lo, hi = max(s + 30, s2 + 15 - dur / 60), min(e - 45, e2 - 15 - dur / 60)
        plane_services.append({**PLANE, 'id': f'air_in_{i}_{j}', 'name': f'{apx[1]} → {apy[1]}', 'group': 'air',
                               'line': f'air_{x}', 'color': '#f5f7fa', 'loop': False, 'both': False, 'offset': 0,
                               'airport': x, 'intl': False, 'path': path_rows(coords, apx[1], apy[1]),
                               'alt': alt_profile(coords), 'departures': spread(n, lo, hi, (i * 13 + j * 29) % 20 - 10),
                               'flight': 'domestic', 'fromName': apx[1], 'toName': apy[1]})

services.extend(plane_services)


def runway_polygon(ap):
    _, _, c, hdg, runway, _ = ap
    half_l, half_w = runway / 2 + 200, 150
    a = offset(c, hdg, half_l)
    b = offset(c, hdg + 180, half_l)
    ring = [offset(a, hdg - 90, half_w), offset(a, hdg + 90, half_w), offset(b, hdg + 90, half_w), offset(b, hdg - 90, half_w)]
    ring.append(ring[0])
    return [rnd(p) for p in ring]


airports = []
for ap in AIRPORTS:
    code, name, c, hdg, runway, hours = ap
    routes = [{'dest': d, 'perDay': n, 'intl': d in INTL} for d, n in EXTERNAL.get(code, [])]
    for a, b, n in INTERNAL:
        if code in (a, b):
            routes.append({'dest': AP[b if code == a else a][1].replace('空港', ''), 'perDay': n, 'intl': False})
    airports.append({'id': code, 'name': name, 'coord': c, 'heading': hdg, 'runway': runway, 'hours': hours,
                     'polygon': runway_polygon(ap), 'stats': None, 'routes': routes})

# ------------------------------------------------------------------ 出力
lines_out = [{'id': lid, 'name': name, 'operator': op, 'group': grp, 'kind': kind, 'color': color,
              'stations': [[n, c] for n, c in sts]} for lid, name, op, grp, kind, color, sts in LINES]
lines_out += FERRY_LINES

with open(os.path.join(HERE, 'holidays.json'), encoding='utf-8') as f:
    holidays = json.load(f)

network = {
    'source': '駅の位置と並び: 駅データ.jp',
    'groups': GROUPS,
    'lines': lines_out,
    'services': services,
    'airports': airports,
    'calendar': {'holidays': holidays},
    'credits': [],
    'trackSource': '駅間を直線で結んだ概略',
}

out = os.path.join(ROOT, 'data', 'network.js')
with open(out, 'w', encoding='utf-8') as f:
    f.write('// 路線・駅・運行パターンのデータ (tools/build_network.py で自動生成)\n')
    f.write('window.NETWORK = ')
    json.dump(network, f, ensure_ascii=False, separators=(',', ':'))
    f.write(';\n')

n_st = len({(n, tuple(c)) for l in lines_out if l['kind'] != 'ship' for n, c in l['stations']})
print(f'{out}: lines {len(lines_out)}, services {len(services)} (planes {len(plane_services)}), stations {n_st}, '
      f'{os.path.getsize(out) / 1e6:.2f} MB')
