#!/usr/bin/env python3
"""Mini Hokkaido 3D を手元で開くための簡易サーバ。

    python3 tools/serve.py        # → http://localhost:8000/
    python3 tools/serve.py 8080   # ポート番号を変えるとき

python3 -m http.server と同じくファイルを配信するほか、/api/live で
ADS-B のオープンデータ (adsb.lol、つながらなければ adsb.fi) から、指定した範囲の航空機の位置を中継する。
これらのサービスはブラウザから直接の読み込みを許可していないため、このサーバを経由する。
同じ範囲への問い合わせは 5 秒間まとめて、提供元に負担をかけないようにしている。
"""
import http.server
import json
import os
import sys
import threading
import time
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SOURCES = [
    ('adsb.lol', 'https://api.adsb.lol/v2/point/{lat}/{lon}/{dist}'),
    ('adsb.fi', 'https://opendata.adsb.fi/api/v2/lat/{lat}/lon/{lon}/dist/{dist}'),
]
USER_AGENT = 'MiniHokkaido3D/1.0 (personal, non-commercial)'
CACHE_SECONDS = 5
_cache = {}
_lock = threading.Lock()


def fetch_live(lat, lon, dist):
    key = (round(lat, 1), round(lon, 1), dist)
    with _lock:
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < CACHE_SECONDS:
            return hit[1]
    errors = []
    for name, url in SOURCES:
        try:
            req = urllib.request.Request(url.format(lat=key[0], lon=key[1], dist=dist), headers={'User-Agent': USER_AGENT})
            with urllib.request.urlopen(req, timeout=10) as r:
                data = json.load(r)
            body = {'source': name, 'now': time.time(), 'aircraft': data.get('ac') or data.get('aircraft') or []}
            with _lock:
                _cache[key] = (time.time(), body)
            return body
        except Exception as e:  # 次の提供元を試す
            errors.append(f'{name}: {e}')
    raise RuntimeError(' / '.join(errors))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        if url.path == '/api/live':
            self.live(urllib.parse.parse_qs(url.query))
        else:
            super().do_GET()

    def live(self, q):
        try:
            lat = float(q['lat'][0])
            lon = float(q['lon'][0])
            dist = max(1, min(250, int(float(q.get('dist', ['50'])[0]))))  # 半径 [海里]、提供元の上限は 250
            status, body = 200, fetch_live(lat, lon, dist)
        except (KeyError, ValueError) as e:
            status, body = 400, {'error': f'パラメータが不正です: {e}'}
        except RuntimeError as e:
            status, body = 502, {'error': f'ADS-B のデータを取得できません: {e}'}
        data = json.dumps(body, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        if '/api/live' not in (args[0] if args else ''):  # 10 秒ごとの問い合わせは表示しない
            super().log_message(fmt, *args)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    # 自分のパソコンからだけ開けるよう、localhost で待ち受ける
    server = http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler)
    print(f'Mini Hokkaido 3D: http://localhost:{port}/ を開いてください (終了は Ctrl + C)')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
