// Mini Hokkaido 3D — 札幌を中心とした北海道の鉄道 3D 可視化
(function () {
  'use strict';

  const { Simulator, offset, bearing, formatTime, parseTime } = window.Sim;
  const NET = window.NETWORK;
  const sim = new Simulator(NET);
  // 今日 (JST) が平日か土休日かで、時刻表データの便を選ぶ。?day=weekday|holiday で固定もできる
  const todayYmd = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
  const dayParam = new URLSearchParams(location.search).get('day');
  sim.setDayType(['weekday', 'holiday'].includes(dayParam) ? dayParam : sim.dayTypeOf(todayYmd));

  // ---------------------------------------------------------------- 設定
  const STYLES = {
    light: 'https://tiles.openfreemap.org/styles/liberty',
    dark: 'https://tiles.openfreemap.org/styles/dark',
  };
  const GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
  const TERRAIN_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
  // ベースマップが読めないときの予備: 国土地理院 淡色地図
  const FALLBACK_STYLE = {
    version: 8,
    glyphs: GLYPHS,
    sources: {
      gsi: {
        type: 'raster', tileSize: 256, maxzoom: 18,
        tiles: ['https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png'],
        attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>',
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#dfe3e6' } },
      { id: 'gsi', type: 'raster', source: 'gsi' },
    ],
  };

  const VIEWS = {
    sapporo: { center: [141.3525, 43.0640], zoom: 14.4, pitch: 60, bearing: -20 },
    susukino: { center: [141.3540, 43.0560], zoom: 16.0, pitch: 65, bearing: 20 },
    sapporo_wide: { center: [141.40, 43.06], zoom: 11.2, pitch: 50, bearing: -10 },
    new_chitose: { center: [141.675, 42.790], zoom: 12.6, pitch: 55, bearing: 0 },
    otaru: { center: [141.000, 43.195], zoom: 13.2, pitch: 55, bearing: 0 },
    asahikawa: { center: [142.355, 43.765], zoom: 13.0, pitch: 55, bearing: 0 },
    hakodate: { center: [140.740, 41.775], zoom: 13.2, pitch: 55, bearing: -10 },
    kushiro: { center: [144.382, 42.990], zoom: 13.0, pitch: 55, bearing: 0 },
    seikan: { center: [140.60, 41.45], zoom: 8.6, pitch: 45, bearing: 0 },
    wakkanai: { center: [141.45, 45.32], zoom: 9.2, pitch: 45, bearing: 0 },
    hokkaido: { center: [142.9, 43.45], zoom: 6.4, pitch: 30, bearing: 0 },
  };

  // ---------------------------------------------------------------- 状態
  const params = new URLSearchParams(location.search);
  const state = {
    // auto: 太陽の高さに合わせて昼はライト、夜はダークの地図に切り替える
    themeMode: ['light', 'dark'].includes(params.get('theme')) ? params.get('theme') : 'auto',
    theme: 'light',
    // 軽量モード: 3D 建物・地形・夜の灯りを消し、車両の立体表示と更新回数を減らす (?lite か、前回の設定)
    lite: params.has('lite') || storedLite(),
    buildings: true,
    terrain: params.has('terrain'),
    groups: Object.fromEntries(NET.groups.map(g => [g.id, true])),
    selected: null,
    station: null,
    reach: null,
    airport: null,
    night: 0,
    follow: false,
    clock: { base: jstNow(), realBase: performance.now(), speed: 1, paused: false },
  };
  // 実際の飛行機 (ADS-B) の状態。処理は「実際の飛行機 (ADS-B)」の節
  const live = { on: false, available: null, list: [], source: '', fetchedAt: 0, error: '', selected: null, seen: {}, timer: null, busy: false };
  if (state.lite) {
    state.buildings = false;
    state.terrain = false;
  }
  if (params.get('t')) state.clock.base = parseTime(params.get('t'));
  if (params.get('speed')) state.clock.speed = Number(params.get('speed')) || 1;

  function storedLite() {
    try {
      return localStorage.getItem('mh3d-lite') === '1';
    } catch (e) {
      return false;
    }
  }

  function jstNow() {
    const now = Date.now() / 1000 + 9 * 3600;
    return ((now % 86400) + 86400) % 86400;
  }

  function simTime() {
    const c = state.clock;
    if (c.paused) return c.base;
    return c.base + (performance.now() - c.realBase) / 1000 * c.speed;
  }

  function setClock(base, speed, paused) {
    const c = state.clock;
    c.base = ((base % 86400) + 86400) % 86400;
    c.realBase = performance.now();
    if (speed !== undefined) c.speed = speed;
    if (paused !== undefined) c.paused = paused;
    renderClockControls();
  }

  // ---------------------------------------------------------------- 地図
  const initView = VIEWS[params.get('view')] || VIEWS.sapporo;
  const map = new maplibregl.Map({
    container: 'map',
    style: { version: 8, glyphs: GLYPHS, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#dfe3e6' } }] },
    ...initView,
    maxPitch: 85,
    hash: true,
    attributionControl: false,
    antialias: true,
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 120, unit: 'metric' }), 'bottom-right');
  map.addControl(new maplibregl.AttributionControl({
    compact: true,
    customAttribution: [
      ...(NET.trackSource === '国土数値情報（鉄道データ）'
        ? ['駅・線路: 「<a href="https://nlftp.mlit.go.jp/ksj/" target="_blank">国土数値情報</a>」（国土交通省）を加工して作成']
        : NET.trackSource ? [`線路: ${NET.trackSource}`] : []),
      '駅の並び: <a href="https://ekidata.jp/" target="_blank">駅データ.jp</a>',
      ...(NET.credits && NET.credits.length
        // ライセンスはデータごとに異なる (函館市電は GTFS-RU ライセンス、高速バスは CC BY) ので、詳しくは DATA_SOURCES.md に書く
        ? [`時刻表（GTFS）: ${NET.credits.map(c => c.replace(/（.*?）/, '').replace(/\s*GTFS$/, '')).join('・')}`] : []),
      ...(window.BUS_MAP
        ? ['路線バス: 「<a href="https://nlftp.mlit.go.jp/ksj/" target="_blank">国土数値情報</a>（バス停留所・バスルート）」を加工して作成、時刻表は<a href="https://ckan.hoda.jp/dataset/gtfs-data" target="_blank">北海道オープンデータプラットフォーム</a>ほか（GTFS）'] : []),
      '空港: 国土数値情報・国土交通省「空港管理状況調書」',
      '航路: 概略',
      'その他の時刻は推計',
      '<a href="DATA_SOURCES.md" target="_blank">データ出典</a>',
    ].join(' | '),
  }), 'bottom-right');

  function fallbackStyle(theme) {
    const style = JSON.parse(JSON.stringify(FALLBACK_STYLE));
    if (theme === 'dark') {
      style.layers[0].paint['background-color'] = '#10141b';
      // 淡色地図の明るさを反転気味に落として夜の地図にする
      style.layers[1].paint = { 'raster-brightness-min': 0.32, 'raster-brightness-max': 0, 'raster-saturation': -0.6, 'raster-contrast': 0.1 };
    }
    return style;
  }

  async function loadStyle() {
    const url = STYLES[state.theme];
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(res.status);
      const style = await res.json();
      map.setStyle(style, { diff: false });
    } catch (e) {
      console.warn('base map unavailable, using fallback', e);
      map.setStyle(fallbackStyle(state.theme), { diff: false });
    }
  }

  map.on('style.load', addOverlays);
  state.theme = resolveTheme(state.clock.base);
  loadStyle();

  function resolveTheme(sec) {
    if (state.themeMode !== 'auto') return state.themeMode;
    return sunPosition(sec).elevation < -4 ? 'dark' : 'light';
  }

  function firstSymbolLayer() {
    const layer = map.getStyle().layers.find(l => l.type === 'symbol');
    return layer && layer.id;
  }

  function addOverlays() {
    const style = map.getStyle();
    const dark = state.theme === 'dark';
    const beforeLabels = firstSymbolLayer();

    // 3D 建物: スタイルに無ければ OpenMapTiles の building レイヤーから作る
    const hasExtrusion = style.layers.some(l => l.type === 'fill-extrusion');
    if (!hasExtrusion && map.getSource('openmaptiles')) {
      map.addLayer({
        id: 'mm3d-buildings', type: 'fill-extrusion', source: 'openmaptiles',
        'source-layer': 'building', minzoom: 13,
        paint: {
          'fill-extrusion-color': dark ? '#2b3340' : '#d9d4cc',
          'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8],
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
          'fill-extrusion-opacity': 0.8,
        },
      }, beforeLabels);
    }
    applyBuildingVisibility();

    map.addSource('terrain', { type: 'raster-dem', tiles: [TERRAIN_TILES], encoding: 'terrarium', tileSize: 256, maxzoom: 14 });
    applyTerrain();

    // 路線バスの路線図 (線路より下に、細く描く)
    const BUS_COLOR = dark ? '#c9a58f' : '#8d6e63';
    map.addSource('bus-routes', { type: 'geojson', data: busRoutesGeoJSON() });
    map.addLayer({
      id: 'bus-routes', type: 'line', source: 'bus-routes', minzoom: state.lite ? BUS_ROUTE_ZOOM_LITE : BUS_ROUTE_ZOOM,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': BUS_COLOR,
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 12, 1.2, 16, 2.5],
        'line-opacity': ['interpolate', ['linear'], ['zoom'], 8, 0.35, 13, 0.7],
      },
    });

    // 線路
    map.addSource('tracks', { type: 'geojson', data: tracksGeoJSON() });
    map.addLayer({
      id: 'tracks-casing', type: 'line', source: 'tracks',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': dark ? '#000' : '#fff',
        'line-width': ['interpolate', ['linear'], ['zoom'], 7, 2.5, 12, 4, 16, 9],
        'line-opacity': 0.7,
      },
    });
    map.addLayer({
      id: 'tracks', type: 'line', source: 'tracks',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['get', 'color'],
        // 高速バスは道路を走り、札幌の中心部で何本も重なるので、細く半透明にする
        'line-width': ['interpolate', ['linear'], ['zoom'],
          7, ['case', ['==', ['get', 'kind'], 'bus'], 0.8, 1.2],
          12, ['case', ['==', ['get', 'kind'], 'bus'], 1.2, 2.5],
          16, ['case', ['==', ['get', 'kind'], 'bus'], 2, 5]],
        'line-opacity': ['case', ['==', ['get', 'kind'], 'bus'], 0.55, 1],
      },
    });

    // 航路 (破線)
    map.addLayer({
      id: 'ferry-routes', type: 'line', source: 'tracks',
      filter: ['==', ['get', 'kind'], 'ship'],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': dark ? '#8fb6e8' : '#3f6fa8',
        'line-width': ['interpolate', ['linear'], ['zoom'], 7, 1, 12, 2, 16, 3],
        'line-dasharray': [2, 2],
        'line-opacity': 0.8,
      },
    });

    // 駅・港 (JR・郊外線・港は広域から、路面電車は拡大時のみ表示)
    map.addSource('stations', { type: 'geojson', data: stationsGeoJSON() });
    for (const kind of ['rail', 'tram']) {
      map.addLayer({
        id: `stations-${kind}`, type: 'circle', source: 'stations',
        minzoom: kind === 'rail' ? 0 : 12.5,
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 1.5, 12, 3, 16, 6],
          'circle-color': dark ? '#1b1f27' : '#ffffff',
          'circle-stroke-color': ['get', 'color'],
          'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 8, 1, 16, 2.5],
          // 高速バスの停留所は数が多いので、広域では出さない
          'circle-opacity': ['step', ['zoom'], ['case', ['==', ['get', 'kind'], 'bus'], 0, 1], 9.5, 1],
          'circle-stroke-opacity': ['step', ['zoom'], ['case', ['==', ['get', 'kind'], 'bus'], 0, 1], 9.5, 1],
        },
      });
    }
    // 路線バスの停留所 (拡大時のみ)。クリックで時刻表
    map.addSource('bus-stops', { type: 'geojson', data: busStopsGeoJSON() });
    map.addLayer({
      id: 'bus-stops', type: 'circle', source: 'bus-stops', minzoom: 13,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 2, 16, 5],
        'circle-color': dark ? '#1b1f27' : '#ffffff',
        'circle-stroke-color': BUS_COLOR,
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 13, 1, 16, 2],
      },
    });
    map.addSource('bus-stop-label-data', { type: 'geojson', data: busStopsGeoJSON() });
    map.addLayer({
      id: 'bus-stop-labels', type: 'symbol', source: 'bus-stop-label-data', minzoom: 15.5,
      layout: {
        'text-field': ['get', 'name'],
        'text-font': ['Noto Sans Regular'],
        'text-size': 11,
        'text-offset': [0, 0.9],
        'text-anchor': 'top',
        'text-optional': true,
      },
      paint: {
        'text-color': dark ? '#d8c3b6' : '#5d4037',
        'text-halo-color': dark ? '#0b0e13' : '#ffffff',
        'text-halo-width': 1.2,
      },
    });
    map.addSource('station-label-data', { type: 'geojson', data: stationsGeoJSON() });
    for (const kind of ['rail', 'tram']) {
      map.addLayer({
        id: `labels-${kind}`, type: 'symbol', source: 'station-label-data',
        minzoom: kind === 'rail' ? 11 : 14.5,
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 11, 10, 16, 13],
          'text-offset': [0, 1.1],
          'text-anchor': 'top',
          'text-optional': true,
        },
        paint: {
          'text-color': dark ? '#e8ecf1' : '#1d2733',
          'text-halo-color': dark ? '#0b0e13' : '#ffffff',
          'text-halo-width': 1.4,
        },
      });
    }

    // 空港 (敷地と、乗降客数に応じた大きさの印)
    map.addSource('airport-data', { type: 'geojson', data: airportsGeoJSON() });
    map.addLayer({
      id: 'airport-area', type: 'fill', source: 'airport-data',
      filter: ['==', ['get', 'shape'], 'area'],
      paint: { 'fill-color': dark ? '#5b7aa6' : '#7d9cc7', 'fill-opacity': 0.18 },
    });
    map.addLayer({
      id: 'airport-points', type: 'circle', source: 'airport-data',
      filter: ['==', ['get', 'shape'], 'point'],
      paint: {
        // 面積が乗降客数に比例するよう、半径は平方根に比例させる
        'circle-radius': ['interpolate', ['linear'], ['zoom'],
          7, ['case', ['has', 'passengers'], ['*', 9, ['sqrt', ['/', ['get', 'passengers'], 3300000]]], 6],
          12, ['case', ['has', 'passengers'], ['*', 22, ['sqrt', ['/', ['get', 'passengers'], 3300000]]], 14]],
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': dark ? '#8fb6e8' : '#2a5a96',
        'circle-stroke-width': 2,
      },
    });
    // 文字はフォントが読めないとソース全体が描けなくなるので、別のソースにする
    map.addSource('airport-label-data', { type: 'geojson', data: airportsGeoJSON() });
    map.addLayer({
      id: 'airport-labels', type: 'symbol', source: 'airport-label-data',
      filter: ['==', ['get', 'shape'], 'point'],
      layout: {
        'text-field': ['concat', ['get', 'name'], '\n', ['get', 'label']],
        'text-font': ['Noto Sans Regular'],
        'text-size': 12,
        'text-offset': [0, 1.6],
        'text-anchor': 'top',
      },
      paint: {
        'text-color': dark ? '#e8ecf1' : '#1d2733',
        'text-halo-color': dark ? '#0b0e13' : '#ffffff',
        'text-halo-width': 1.5,
      },
    });

    // 到達圏
    map.addSource('reach', { type: 'geojson', data: reachGeoJSON() });
    map.addLayer({
      id: 'reach', type: 'circle', source: 'reach',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, ['case', ['get', 'origin'], 7, 4], 14, ['case', ['get', 'origin'], 14, 9]],
        'circle-color': ['get', 'color'],
        'circle-stroke-color': dark ? '#10141b' : '#ffffff',
        'circle-stroke-width': 2,
      },
    });
    map.addSource('reach-label-data', { type: 'geojson', data: reachGeoJSON() });
    map.addLayer({
      id: 'reach-labels', type: 'symbol', source: 'reach-label-data', minzoom: 10.5,
      layout: {
        'text-field': ['case', ['get', 'origin'], ['concat', ['get', 'name'], ' 出発'], ['concat', ['get', 'name'], ' ', ['get', 'label']]],
        'text-font': ['Noto Sans Regular'],
        'text-size': 12,
        'text-offset': [0, -1.3],
        'text-anchor': 'bottom',
        'text-optional': true,
      },
      paint: {
        'text-color': dark ? '#e8ecf1' : '#1d2733',
        'text-halo-color': dark ? '#0b0e13' : '#ffffff',
        'text-halo-width': 1.6,
      },
    });
    applyReachMode();

    // 列車
    map.addSource('train-glow', { type: 'geojson', data: empty() });
    map.addLayer({
      id: 'train-glow', type: 'circle', source: 'train-glow',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 10, 16, 40],
        'circle-color': '#ffeb3b',
        'circle-opacity': 0.35,
        'circle-blur': 0.8,
        'circle-pitch-alignment': 'map',
      },
    });
    map.addSource('trains', { type: 'geojson', data: empty() });
    map.addLayer({
      id: 'trains', type: 'fill-extrusion', source: 'trains',
      paint: {
        'fill-extrusion-color': ['get', 'color'],
        'fill-extrusion-height': ['get', 'h'],
        'fill-extrusion-base': ['get', 'b'],
        'fill-extrusion-opacity': 0.95,
        'fill-extrusion-vertical-gradient': true,
      },
    });
    // 引いた視点の車両 (立体の代わりに丸で描く。立体より描画がずっと軽い)
    map.addSource('train-points', { type: 'geojson', data: empty() });
    map.addLayer({
      id: 'train-points', type: 'circle', source: 'train-points',
      layout: { 'circle-sort-key': ['case', hoverMatch(), 1, 0] }, // カーソルを近づけた丸を手前に
      paint: {
        'circle-radius': hoverRadius(),
        'circle-color': ['get', 'color'],
        'circle-stroke-color': dark ? '#0b0e13' : '#ffffff',
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 6, 0.6, 12, 1.2],
        'circle-pitch-alignment': 'map',
      },
    });
    drawMode = '';
    map.addSource('train-lights', { type: 'geojson', data: empty() });
    map.addLayer({
      id: 'train-lights', type: 'circle', source: 'train-lights',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 2, 14, 3.5, 17, 7],
        'circle-color': ['get', 'color'],
        'circle-blur': 0.7,
        'circle-opacity': 0,
      },
    });
    applyGroupFilter();
    lastSunMinute = -1;
  }

  function empty() { return { type: 'FeatureCollection', features: [] }; }

  // 丸で描いた車両のうち、カーソルを近づけたもの
  const HOVER_PX = 14, HOVER_SCALE = 2;
  let hoveredId = null;
  let hoverQueued = false;
  function hoverMatch() { return ['==', ['get', 'id'], hoveredId || '']; }
  function hoverRadius() {
    const r = v => ['case', hoverMatch(), v * HOVER_SCALE, v];
    return ['interpolate', ['linear'], ['zoom'], 6, r(2.5), 10, r(3.5), 14, r(5.5)];
  }

  function tracksGeoJSON() {
    return {
      type: 'FeatureCollection',
      // noShape の線 (高速バスの系統ごとの線) は描かず、重複を除いた経路 (multiShape) をまとめて描く
      features: NET.lines.filter(l => !l.noShape).map(l => ({
        type: 'Feature',
        properties: { id: l.id, name: l.name, color: l.color, group: l.group, kind: l.kind },
        geometry: l.multiShape
          ? { type: 'MultiLineString', coordinates: l.multiShape }
          : { type: 'LineString', coordinates: l.shape || l.stations.map(s => s[1]) },
      })),
    };
  }

  function airportsGeoJSON() {
    const features = [];
    for (const a of NET.airports || []) {
      // 利用統計の無い空港は、印を一定の大きさで描き、ラベルは名前だけにする
      const props = a.stats
        ? { id: a.id, name: a.name, passengers: a.stats.passengers, label: `${a.stats.year}年 ${Math.round(a.stats.passengers / 10000)}万人` }
        : { id: a.id, name: a.name, label: '' };
      features.push({ type: 'Feature', properties: { ...props, shape: 'area' }, geometry: { type: 'Polygon', coordinates: [a.polygon] } });
      features.push({ type: 'Feature', properties: { ...props, shape: 'point' }, geometry: { type: 'Point', coordinates: a.coord } });
    }
    return { type: 'FeatureCollection', features };
  }

  // 路線バスの路線図を描き始めるズーム (路線が 1 万 6 千本あり、広域で描くと重いため)
  const BUS_ROUTE_ZOOM = 10.5, BUS_ROUTE_ZOOM_LITE = 13;
  const BUS = window.BUS_MAP || { operators: [], routeNames: [], stops: [], lines: [], timetables: [], ttStops: [] };

  function busRoutesGeoJSON() {
    return {
      type: 'FeatureCollection',
      features: BUS.lines.map(([op, coords]) => ({ type: 'Feature', properties: { op }, geometry: { type: 'LineString', coordinates: coords } })),
    };
  }

  function busStopsGeoJSON() {
    return {
      type: 'FeatureCollection',
      features: BUS.stops.map(([name, c], i) => ({ type: 'Feature', properties: { i, name }, geometry: { type: 'Point', coordinates: c } })),
    };
  }

  function stationsGeoJSON() {
    const seen = new Map();
    for (const l of NET.lines) {
      for (const [name, c] of l.stations) {
        const key = name + c.map(x => x.toFixed(3)).join();
        if (seen.has(key)) {
          seen.get(key).properties.groups += `${l.group},`;
          continue;
        }
        seen.set(key, {
          type: 'Feature',
          properties: { name, color: l.color, kind: l.kind, groups: `,${l.group},` },
          geometry: { type: 'Point', coordinates: c },
        });
      }
    }
    return { type: 'FeatureCollection', features: [...seen.values()] };
  }

  function applyGroupFilter() {
    if (!map.getLayer('tracks')) return;
    const on = Object.keys(state.groups).filter(g => state.groups[g]);
    // 特急は JR の線路を走るので、JR 普通を消しても特急が見えていれば線路は残す
    const lineGroups = new Set(on);
    if (state.groups.jr_ltd) lineGroups.add('jr');
    const f = ['in', ['get', 'group'], ['literal', [...lineGroups]]];
    const notShip = ['!=', ['get', 'kind'], 'ship'];
    map.setFilter('tracks', ['all', f, notShip]);
    map.setFilter('tracks-casing', ['all', f, notShip, ['!=', ['get', 'kind'], 'bus']]); // 高速バスには縁取りを描かない
    map.setFilter('ferry-routes', ['all', f, ['==', ['get', 'kind'], 'ship']]);
    for (const id of ['bus-routes', 'bus-stops', 'bus-stop-labels']) {
      map.setLayoutProperty(id, 'visibility', state.groups.route_bus ? 'visible' : 'none');
    }
    const inGroups = ['any', ...[...lineGroups].map(g => ['in', `,${g},`, ['get', 'groups']])];
    for (const kind of ['rail', 'tram']) {
      // 'rail' のレイヤーには鉄道の駅と港を、'tram' のレイヤーには電停を出す
      const kindFilter = kind === 'tram' ? ['==', ['get', 'kind'], 'tram'] : ['!=', ['get', 'kind'], 'tram'];
      const sf = ['all', kindFilter, inGroups];
      map.setFilter(`stations-${kind}`, sf);
      map.setFilter(`labels-${kind}`, sf);
    }
  }

  function applyBuildingVisibility() {
    for (const l of map.getStyle().layers) {
      if (l.type === 'fill-extrusion' && l.id !== 'trains') {
        map.setLayoutProperty(l.id, 'visibility', state.buildings ? 'visible' : 'none');
      }
    }
  }

  function applyTerrain() {
    map.setTerrain(state.terrain ? { source: 'terrain', exaggeration: 1.4 } : null);
  }

  // ---------------------------------------------------------------- 太陽と空
  // シミュレーション時刻の太陽の位置 (札幌付近) から光の向き・色・空の色を決める
  function sunPosition(sec) {
    const SUN_LAT = 43.06, SUN_LON = 141.35;
    const now = new Date(Date.now() + 9 * 3600 * 1000);
    const start = Date.UTC(now.getUTCFullYear(), 0, 0);
    const day = Math.floor((now.getTime() - start) / 86400000);
    const rad = Math.PI / 180;
    const decl = 23.44 * Math.sin(2 * Math.PI * (284 + day) / 365) * rad;
    const B = 2 * Math.PI * (day - 81) / 364;
    const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B); // 均時差 [分]
    const solarMin = sec / 60 + 4 * (SUN_LON - 135) + eot;
    const hour = (solarMin / 4 - 180) * rad;
    const lat = SUN_LAT * rad;
    const elev = Math.asin(Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hour));
    const az = Math.atan2(Math.sin(hour), Math.cos(hour) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat)) + Math.PI;
    return { elevation: elev / rad, azimuth: az / rad };
  }

  function mix(a, b, f) {
    const pa = a.match(/\w\w/g).map(x => parseInt(x, 16));
    const pb = b.match(/\w\w/g).map(x => parseInt(x, 16));
    return '#' + pa.map((v, i) => Math.round(v + (pb[i] - v) * f).toString(16).padStart(2, '0')).join('');
  }

  let lastSunMinute = -1;
  function updateSun(sec, force) {
    const minute = Math.floor(sec / 60);
    if (!force && minute === lastSunMinute) return;
    lastSunMinute = minute;
    const { elevation, azimuth } = sunPosition(sec);
    // day: 太陽高度 6° 以上で 1、-6° (市民薄明の終わり) 以下で 0
    const day = Math.min(1, Math.max(0, (elevation + 6) / 12));
    const low = Math.max(0, 1 - Math.abs(elevation) / 12); // 朝夕の赤み
    state.night = 1 - day;
    const theme = resolveTheme(sec);
    if (theme !== state.theme) {
      state.theme = theme;
      renderToggles();
      loadStyle();
      return;
    }
    if (map.getLayer('train-lights')) map.setPaintProperty('train-lights', 'circle-opacity', 0.95 * state.night);
    const color = mix(mix('#b4c2ff', '#ffffff', day), '#ffb070', low * day);
    map.setLight({
      anchor: 'map',
      position: [1.5, azimuth, Math.min(88, Math.max(10, 90 - Math.max(elevation, 0)))],
      color,
      intensity: 0.32 + 0.18 * day,
    });
    if (typeof map.setSky === 'function') {
      map.setSky({
        'sky-color': mix('#0b1026', '#6fa8e8', day),
        'horizon-color': mix(mix('#1b2448', '#dce9f5', day), '#ffb27a', low * 0.8),
        'fog-color': mix('#0e1424', '#e6edf3', day),
        'sky-horizon-blend': 0.6,
        'horizon-fog-blend': 0.5,
        'fog-ground-blend': 0.5,
        'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 12, 0],
      });
    }
  }

  // ---------------------------------------------------------------- 列車の描画
  function sizeScale() {
    // 引いた視点でも列車が見えるよう、縮尺に応じて誇張する
    return Math.min(120, Math.max(2, Math.pow(2, 16.6 - map.getZoom())));
  }

  const WINDOW_COLOR = '#22303c';

  const HULL_COLOR = '#1f3f66';

  // 飛行機: 胴体・主翼・尾翼を、その地点の高度に浮かべて描く
  function altitudeAt(sv, d) {
    const a = sv.alt;
    if (!a) return 0;
    let lo = 0, hi = a.length - 1;
    if (d <= a[0][0]) return a[0][1];
    if (d >= a[hi][0]) return a[hi][1];
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (a[mid][0] <= d) lo = mid; else hi = mid;
    }
    const f = (d - a[lo][0]) / (a[hi][0] - a[lo][0] || 1);
    return a[lo][1] + (a[hi][1] - a[lo][1]) * f;
  }

  function planeFeatures(tr, scale, features, lights) {
    const p = tr.pattern.pointAt(tr.dist);
    drawPlane(tr.id, p.c, p.brg, altitudeAt(tr.service, tr.dist), tr.service, tr.service.color, scale, features, lights);
  }

  // 飛行機の形 (推計の航空便と、実際の飛行機 (ADS-B) で共通)。c は機首の位置、brg は進行方位 [rad]、alt は高度 [m]
  function drawPlane(id, c, brg, alt, dims, color, scale, features, lights) {
    const s = Math.max(1, scale / 2);
    const L = dims.carLength * s, span = dims.width * s, h = dims.height * s;
    const left = brg - Math.PI / 2;
    // 機首を現在地に置き、胴体・翼をその後ろに描く
    const at = (back, side) => offset(offset(c, brg + Math.PI, back), left, side);
    const base = alt + 0.5 * s;
    const poly = ring => { ring.push(ring[0]); return { type: 'Polygon', coordinates: [ring] }; };
    const body = poly([at(0, 0), at(L * 0.08, L * 0.06), at(L, L * 0.05), at(L, -L * 0.05), at(L * 0.08, -L * 0.06)]);
    const wing = poly([at(L * 0.38, 0), at(L * 0.55, span / 2), at(L * 0.62, span / 2), at(L * 0.55, 0),
      at(L * 0.62, -span / 2), at(L * 0.55, -span / 2)]);
    const tail = poly([at(L * 0.85, 0), at(L * 0.95, span * 0.18), at(L, span * 0.18), at(L, -span * 0.18),
      at(L * 0.95, -span * 0.18)]);
    for (const [geometry, col, hh] of [[body, color, h], [wing, '#c9d2dc', h * 0.35], [tail, '#c9d2dc', h * 0.35]]) {
      features.push({ type: 'Feature', properties: { id, color: col, b: base, h: base + hh }, geometry });
    }
    lights.push(light(at(L * 0.6, span / 2), '#ff3b30'));
    lights.push(light(at(L * 0.6, -span / 2), '#34c759'));
    lights.push(light(at(0, 0), '#fff6d8'));
  }

  // 船: 船首のとがった船体と、船尾寄りの客室を重ねる
  function shipFeatures(tr, scale, features, lights) {
    const sv = tr.service;
    const s = Math.max(1, scale / 4); // 船は大きいので誇張を控えめにする
    const L = sv.carLength * s, W = sv.width * s, h = sv.height * s;
    const head = Math.max(tr.dist, Math.min(L, tr.pattern.length));
    const f = tr.pattern.pointAt(head);
    const b = tr.pattern.pointAt(Math.max(0, head - L));
    const brg = bearing(b.c, f.c) || f.brg;
    const left = brg - Math.PI / 2;
    const at = (d, side) => offset(offset(b.c, brg, d), left, side);
    const hull = [at(0, W / 2), at(L * 0.75, W / 2), at(L, 0), at(L * 0.75, -W / 2), at(0, -W / 2)];
    hull.push(hull[0]);
    const cabin = [at(L * 0.12, W * 0.35), at(L * 0.6, W * 0.35), at(L * 0.6, -W * 0.35), at(L * 0.12, -W * 0.35)];
    cabin.push(cabin[0]);
    const base = 0.3 * s;
    features.push({ type: 'Feature', properties: { id: tr.id, color: HULL_COLOR, b: base, h: base + h * 0.4 },
      geometry: { type: 'Polygon', coordinates: [hull] } });
    features.push({ type: 'Feature', properties: { id: tr.id, color: sv.color, b: base + h * 0.4, h: base + h },
      geometry: { type: 'Polygon', coordinates: [cabin] } });
    lights.push(light(at(L, 0), '#fff6d8'));
    lights.push(light(at(0, 0), '#ff3b30'));
  }

  function trainFeatures(trains, scale) {
    const features = [];
    const lights = [];
    for (const tr of trains) {
      const sv = tr.service;
      if (sv.kind === 'ship') {
        shipFeatures(tr, scale, features, lights);
        continue;
      }
      if (sv.kind === 'plane') {
        planeFeatures(tr, scale, features, lights);
        continue;
      }
      const L = sv.carLength * scale;
      const W = sv.width * scale;
      const gap = 0.8 * scale;
      // 日本の鉄道は左側通行: 進行方向左へずらして複線を表現
      const lateral = (sv.kind === 'tram' ? 1.6 : 2.0) * scale;
      const h = sv.height * scale;
      const base = 0.4 * scale;
      const { head, cars, colors, pos, allowBehind } = consist(tr, L + gap);
      const at = d => (d >= 0 || !allowBehind ? tr.pattern.pointAt(Math.max(0, d)) : pos(d));
      for (let k = 0; k < cars; k++) {
        const dFront = head - k * (L + gap);
        if (dFront <= 0 && !allowBehind) break;
        const f = at(dFront);
        const b = at(allowBehind ? dFront - L : Math.max(0, dFront - L));
        const brg = bearing(b.c, f.c) || f.brg;
        const left = brg - Math.PI / 2;
        const fc = offset(f.c, left, lateral);
        const bc = offset(b.c, left, lateral);
        const ring = [
          offset(fc, left, W / 2), offset(fc, left + Math.PI, W / 2),
          offset(bc, left + Math.PI, W / 2), offset(bc, left, W / 2),
        ];
        // 先頭車は少し先細りにして進行方向を分かりやすくする
        if (k === 0) {
          const nose = offset(fc, brg, Math.min(L * 0.15, 3 * scale));
          ring.splice(1, 0, nose);
        }
        ring.push(ring[0]);
        // 夜間の前照灯 (先頭) と尾灯 (最後尾)
        if (k === 0) lights.push(light(offset(fc, brg, Math.min(L * 0.15, 3 * scale)), '#fff6d8'));
        if (k === cars - 1 || (!allowBehind && head - (k + 1) * (L + gap) <= 0)) lights.push(light(bc, '#ff3b30'));
        const geometry = { type: 'Polygon', coordinates: [ring] };
        // 車体・窓の帯・上部車体を積み重ねて電車らしく見せる (上から見ても路線色が分かるよう屋根も路線色)
        for (const [from, to, color] of [
          [0, 0.5, colors[k]], [0.5, 0.78, WINDOW_COLOR], [0.78, 1, colors[k]],
        ]) {
          features.push({
            type: 'Feature',
            properties: { id: tr.id, color, b: base + h * from, h: base + h * to },
            geometry,
          });
        }
      }
    }
    return { trains: { type: 'FeatureCollection', features }, lights: { type: 'FeatureCollection', features: lights } };
  }

  // 編成の組み方と先頭の位置。併結・切り離しをする列車は、相手に合わせて位置と両数を変える。
  //   carPitch: 1 両分の長さ (連結面の隙間を含む、表示の誇張込み)
  function consist(tr, carPitch) {
    const sv = tr.service;
    const c = tr.pattern.couple;
    const d = tr.dist;
    const colors = Array(sv.cars).fill(sv.color);
    const base = { head: d, cars: sv.cars, colors, pos: null, allowBehind: false };
    if (c && (c.role === 'lead-join' || c.role === 'lead-split')) {
      // しおかぜ: 宇多津を発車したら (松山行き) / 宇多津に着くまで (松山から) いしづち の 3 両を後ろにつなぐ
      const attached = c.role === 'lead-join' ? tr.elapsed >= c.at : tr.elapsed < c.at;
      if (attached) {
        base.cars = sv.cars + c.cars;
        base.colors = colors.concat(Array(c.cars).fill(c.color));
      }
    } else if (c && c.role === 'join') {
      // いしづち (宇多津止まり): 終点の手前でゆっくり詰め、しおかぜ の最後尾のすぐ後ろに止まる
      const back = c.partnerCars * carPitch;
      const ramp = Math.min(1, Math.max(0, (d - (tr.pattern.length - 2 * back)) / (2 * back)));
      if (ramp > 0) {
        base.head = d - back * ramp;
        return base;
      }
    } else if (c && c.role === 'split') {
      // いしづち (宇多津始発): 切り離された位置 (しおかぜ の後ろ) から動き出し、だんだん自分の経路に乗る
      const back = c.partnerCars * carPitch;
      const ramp = Math.min(1, Math.max(0, d / (2 * back)));
      base.head = d - back * (1 - ramp);
      // 駅より手前 (負の距離) は、しおかぜ が走ってきた線路の上に置く
      base.pos = x => c.partner.pointAt(c.stationCum + x);
      base.allowBehind = true;
      return base;
    }
    // 始発駅では編成全体がホームに収まるよう、先頭を 1 編成分だけ前に置く
    const trainLen = Math.min(base.cars * carPitch, tr.pattern.length);
    base.head = Math.max(d, trainLen);
    return base;
  }

  function light(c, color) {
    return { type: 'Feature', properties: { color }, geometry: { type: 'Point', coordinates: c } };
  }

  // 画面の外 (表示範囲を 30% 広げた外側) の列車は描かない。選択中の列車は常に描く
  function visibleTrains(trains) {
    const b = map.getBounds();
    const padX = (b.getEast() - b.getWest()) * 0.3;
    const padY = (b.getNorth() - b.getSouth()) * 0.3;
    const w = b.getWest() - padX, e = b.getEast() + padX, sth = b.getSouth() - padY, n = b.getNorth() + padY;
    return trains.filter(tr => {
      if (tr.id === state.selected) return true;
      const c = tr.pattern.pointAt(tr.dist).c;
      return c[0] >= w && c[0] <= e && c[1] >= sth && c[1] <= n;
    });
  }

  // 車両を立体で描くズーム (それより引いた視点では丸で描く)。立体の建物が現れるズームにそろえる
  // (明るい地図は 14、暗い地図は 13)。軽量モードでは建物を出さないので 14 に固定
  const SOLID_ZOOM_LITE = 14;
  function solidZoom() {
    if (state.lite) return SOLID_ZOOM_LITE;
    const b = map.getStyle().layers.find(l => l.type === 'fill-extrusion' && l['source-layer'] === 'building');
    return b ? (b.minzoom || 0) : SOLID_ZOOM_LITE;
  }
  // 車両の位置を更新する間隔 [ms]: 通常 約 15 回/秒、軽量モード 10 回/秒、地図を動かしている間 約 7 回/秒
  const FRAME_MS = 66, FRAME_MS_LITE = 100, FRAME_MS_MOVING = 150;
  let lastTrains = [];
  let lastFrame = 0;
  let mapMoving = false;
  let drawMode = ''; // 'solid' | 'points' (切り替わったときだけ、使わないほうを空にする)
  let lastDrawKey = '';
  map.on('movestart', () => { mapMoving = true; });
  map.on('moveend', () => { mapMoving = false; lastDrawKey = ''; });

  function vehiclePoint(tr) {
    return { type: 'Feature', properties: { id: tr.id, color: tr.service.color }, geometry: { type: 'Point', coordinates: tr.pattern.pointAt(tr.dist).c } };
  }

  function frame(now) {
    requestAnimationFrame(frame);
    if (document.hidden) return; // 裏のタブでは描かない
    const interval = mapMoving ? FRAME_MS_MOVING : state.lite ? FRAME_MS_LITE : FRAME_MS;
    if (now - lastFrame < interval) return;
    lastFrame = now;
    const t = simTime();
    document.getElementById('clock').textContent = formatTime(t);
    document.getElementById('cinema-clock').textContent = formatTime(t).slice(0, 5);
    if (!map.getSource('trains')) return;
    // 一時停止中で、表示の条件も変わっていなければ、描き直さない
    const zoom = map.getZoom();
    const drawKey = state.clock.paused && !mapMoving && !live.on
      ? [Math.round(t), Math.round(zoom * 20), state.lite, state.selected, sim.dayType, state.theme, JSON.stringify(state.groups)].join('|') : '';
    if (drawKey && drawKey === lastDrawKey) return;
    lastDrawKey = drawKey;
    updateSun(((t % 86400) + 86400) % 86400);
    // 実際の飛行機 (ADS-B) を表示している間は、推計の航空便を隠す
    const showLive = liveActive();
    const trains = sim.trainsAt(((t % 86400) + 86400) % 86400, sv => state.groups[sv.group] && !(showLive && sv.kind === 'plane'));
    lastTrains = trains;
    const shown = visibleTrains(trains);
    if (zoom >= solidZoom()) {
      const drawn = trainFeatures(shown, sizeScale());
      if (showLive) liveFeatures(sizeScale(), drawn.trains.features, drawn.lights.features);
      map.getSource('trains').setData(drawn.trains);
      map.getSource('train-lights').setData(state.night > 0.05 && !state.lite ? drawn.lights : empty());
      if (drawMode !== 'solid') map.getSource('train-points').setData(empty());
      drawMode = 'solid';
    } else {
      const points = shown.map(vehiclePoint);
      if (showLive) points.push(...livePoints());
      map.getSource('train-points').setData({ type: 'FeatureCollection', features: points });
      if (drawMode !== 'points') {
        map.getSource('trains').setData(empty());
        map.getSource('train-lights').setData(empty());
      }
      drawMode = 'points';
    }
    document.getElementById('train-count').textContent = String(trains.length);
    updateSelection(trains, t);
    if (live.selected) updateLiveSelection();
    if (now - lastBoard > 1000) {
      lastBoard = now;
      if (state.station) renderStation();
      if (state.airport) renderAirportFlights();
      if (state.selected || live.selected) renderInfo(); // 併結・切り離しで列車名や両数が変わる
      renderLiveNote();
      renderChartNow();
    }
  }
  let lastBoard = 0;
  requestAnimationFrame(frame);

  // ---------------------------------------------------------------- 列車の選択
  map.on('click', 'train-points', e => onVehicleClick(e));
  // 丸で描いた車両は、カーソルを近づける (HOVER_PX 以内) と直径を HOVER_SCALE 倍にする
  map.on('mousemove', e => {
    if (hoverQueued) return;
    hoverQueued = true;
    requestAnimationFrame(() => {
      hoverQueued = false;
      setHover(nearestPoint(e.point));
    });
  });
  map.getCanvas().addEventListener('mouseleave', () => setHover(null));
  function nearestPoint(pt) {
    if (drawMode !== 'points' || !map.getLayer('train-points')) return null;
    const r = HOVER_PX;
    let best = null, bestD = Infinity;
    for (const f of map.queryRenderedFeatures([[pt.x - r, pt.y - r], [pt.x + r, pt.y + r]], { layers: ['train-points'] })) {
      const p = map.project(f.geometry.coordinates);
      const d = Math.hypot(p.x - pt.x, p.y - pt.y);
      if (d <= r && d < bestD) { best = f.properties.id; bestD = d; }
    }
    return best;
  }
  function setHover(id) {
    if (id === hoveredId) return;
    hoveredId = id;
    map.getCanvas().style.cursor = id ? 'pointer' : '';
    if (!map.getLayer('train-points')) return;
    map.setPaintProperty('train-points', 'circle-radius', hoverRadius());
    map.setLayoutProperty('train-points', 'circle-sort-key', ['case', hoverMatch(), 1, 0]);
  }
  map.on('click', 'trains', e => onVehicleClick(e));
  function onVehicleClick(e) {
    if (e.defaultPrevented) return;
    // 駅名・停留所名の文字は車両より手前に書かれているので、文字のクリックを優先する
    const labels = ['labels-rail', 'labels-tram', 'bus-stop-labels'].filter(l => map.getLayer(l));
    if (e.point && map.queryRenderedFeatures(e.point, { layers: labels }).length) return;
    const id = e.features[0].properties.id;
    // 実際の飛行機は id が live:<機体の ICAO アドレス>
    live.selected = id.startsWith('live:') ? id.slice(5) : null;
    state.selected = live.selected ? null : id;
    state.follow = false;
    state.station = null;
    e.preventDefault();
    renderInfo();
    renderStation();
  }
  for (const layer of ['airport-points', 'airport-area']) {
    map.on('click', layer, e => {
      if (e.defaultPrevented) return;
      e.preventDefault();
      openAirport(e.features[0].properties.id);
    });
    map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
  }
  map.on('click', 'bus-stops', e => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    openBusStop(e.features[0].properties.i);
  });
  map.on('mouseenter', 'bus-stops', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'bus-stops', () => { map.getCanvas().style.cursor = ''; });
  // 地図に書かれた駅名・停留所名をクリックしても開く (この地図の文字と、背景地図の駅・バス停・空港の名前)
  for (const layer of ['labels-rail', 'labels-tram']) {
    map.on('click', layer, e => {
      if (e.defaultPrevented) return;
      e.preventDefault();
      const f = e.features[0];
      openStation(f.properties.name, f.geometry.coordinates);
    });
    map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
  }
  map.on('click', 'bus-stop-labels', e => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    openBusStop(e.features[0].properties.i);
  });
  map.on('mouseenter', 'bus-stop-labels', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'bus-stop-labels', () => { map.getCanvas().style.cursor = ''; });
  map.on('click', e => {
    if (e.defaultPrevented || !map.getLayer('poi_transit')) return;
    const f = map.queryRenderedFeatures(e.point, { layers: ['poi_transit'] })[0];
    if (!f) return;
    const c = f.geometry.coordinates;
    const name = f.properties['name:ja'] || f.properties.name || '';
    const near = (list, max) => {
      let best = null, bestD = max;
      for (const x of list) {
        const d = Sim.haversine(x.c, c) * (x.name === name.replace(/駅$/, '') ? 0.3 : 1); // 名前が同じものを優先
        if (d < bestD) { best = x; bestD = d; }
      }
      return best;
    };
    let hit = null;
    if (f.properties.class === 'rail') {
      const st = near(stationsGeoJSON().features.map(s => ({ name: s.properties.name, c: s.geometry.coordinates })), 600);
      if (st) hit = () => openStation(st.name, st.c);
    } else if (f.properties.class === 'bus' && window.BUS_MAP) {
      const bs = near(BUS.stops.map(([n, sc], i) => ({ name: n, c: sc, i })), 150);
      if (bs) hit = () => openBusStop(bs.i);
    } else if (f.properties.class === 'airport') {
      const ap = near((NET.airports || []).map(a => ({ name: a.name, c: a.coord, id: a.id })), 5000);
      if (ap) hit = () => openAirport(ap.id);
    }
    if (!hit) return;
    e.preventDefault();
    hit();
  });
  map.on('mouseenter', 'poi_transit', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'poi_transit', () => { map.getCanvas().style.cursor = ''; });
  for (const layer of ['stations-rail', 'stations-tram']) {
    map.on('click', layer, e => {
      if (e.defaultPrevented) return;
      e.preventDefault();
      const f = e.features[0];
      openStation(f.properties.name, f.geometry.coordinates);
    });
    map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
  }
  map.on('click', e => {
    if (e.defaultPrevented) return;
    const near = nearestPoint(e.point);
    if (near) {
      onVehicleClick({ features: [{ properties: { id: near } }], defaultPrevented: false, preventDefault() {} });
      return;
    }
    state.selected = null;
    live.selected = null;
    state.follow = false;
    state.station = null;
    state.airport = null;
    renderInfo();
    renderStation();
    renderAirport();
  });
  map.on('mouseenter', 'trains', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'trains', () => { map.getCanvas().style.cursor = ''; });
  map.on('dragstart', () => { if (state.follow) { state.follow = false; renderInfo(); } });

  function updateSelection(trains, t) {
    const glow = map.getSource('train-glow');
    const tr = state.selected && trains.find(x => x.id === state.selected);
    if (!tr) {
      glow.setData(empty());
      if (state.selected) {
        document.getElementById('info-status').textContent = '運行を終了しました';
        document.getElementById('info-stops').replaceChildren();
        document.getElementById('info-past').hidden = true;
        lastUpcomingKey = '';
      }
      return;
    }
    const p = tr.pattern.pointAt(tr.dist);
    glow.setData({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p.c } });
    if (state.follow) map.jumpTo({ center: p.c });
    const path = tr.pattern.path;
    let status;
    const ship = tr.service.kind === 'ship';
    if (tr.service.kind === 'plane') {
      const sv = tr.service;
      const alt = Math.round(altitudeAt(sv, tr.dist) / 10) * 10;
      const left = Math.max(0, Math.round((tr.segs[tr.segs.length - 1].t1 - tr.elapsed) / 60));
      // 道内便 (domestic) は 1 本の経路で離陸から着陸まで飛ぶので、高度が上がっている間は上昇中とする
      const climbing = sv.flight === 'dep' || (sv.flight === 'domestic' && altitudeAt(sv, tr.dist + 1000) > altitudeAt(sv, tr.dist));
      const onGround = alt <= 0;
      status = climbing
        ? (onGround ? '離陸滑走中' : `${sv.toName} へ向けて上昇中（高度 約${alt.toLocaleString()} m）`)
        : (onGround
          ? (tr.dist > 0 ? '着陸しました' : '離陸滑走中')
          : `着陸まで あと約${left}分（高度 約${alt.toLocaleString()} m）`);
      document.getElementById('info-status').textContent = status;
      document.getElementById('info-stops').replaceChildren();
      document.getElementById('info-past').hidden = true;
      return;
    }
    const cp = tr.pattern.couple;
    if (cp && cp.role === 'split' && tr.waiting) {
      status = `${cp.station}で ${cp.partnerName} から切り離し（${formatTime(tr.dep).slice(0, 5)} 発）`;
    } else if (cp && cp.role === 'join' && tr.stopped && tr.at === path.length - 1) {
      status = `${cp.station}で ${cp.partnerName} の後ろに連結（併結して${cp.partner.destination}へ）`;
    } else if (cp && cp.role === 'lead-join' && tr.stopped && tr.at === cp.index) {
      status = `${cp.station}で ${cp.name.replace('特急 ', '')} と連結中（${formatTime(tr.dep + cp.at).slice(0, 5)} 発）`;
    } else if (cp && cp.role === 'lead-split' && tr.stopped && tr.at === cp.index) {
      status = `${cp.station}で ${cp.name.replace('特急 ', '')} を切り離し（${formatTime(tr.dep + tr.segs[tr.seg].t0).slice(0, 5)} 発）`;
    } else if (tr.waiting) {
      status = `${path[0][0]} で${ship ? '出港' : '発車'}待ち（${formatTime(tr.dep).slice(0, 5)} 発）`;
    } else if (tr.stopped && tr.at === path.length - 1) {
      status = `${path[tr.at][0]} に${ship ? '入港' : '到着'}しました`;
    } else if (tr.stopped) {
      const seg = tr.segs[tr.seg];
      status = `${path[tr.at][0]} に${ship ? '停泊' : '停車'}中（${formatTime(tr.dep + seg.t0).slice(0, 5)} 発）`;
    } else {
      const seg = tr.segs[tr.seg];
      status = `次は ${path[tr.next][0]}（${formatTime(tr.dep + seg.t1).slice(0, 5)} 着予定）`;
    }
    document.getElementById('info-status').textContent = status;
    renderUpcoming(tr);
  }

  // 選択中の列車の停車駅: この先 (最大 6 駅 + 終着駅、到着予定) と、これより前 (発車済み、発車時刻。たたんでおく)
  let lastUpcomingKey = '';
  function renderUpcoming(tr) {
    const p = tr.pattern;
    const rows = tr.segs
      .filter(sg => sg.t1 > tr.elapsed)
      .map(sg => ({ i: sg.to, time: formatTime(tr.dep + sg.t1).slice(0, 5) }));
    const past = tr.segs
      .filter(sg => sg.t0 < tr.elapsed)
      .map(sg => ({ i: sg.from, time: `${formatTime(tr.dep + sg.t0).slice(0, 5)}` }));
    const shown = rows.length > 7 ? [...rows.slice(0, 6), null, rows[rows.length - 1]] : rows;
    const key = tr.id + past.length + shown.map(r => (r ? r.i : '…')).join();
    if (key === lastUpcomingKey) return;
    // 別の列車を選んだら、「これより前の停車場」はたたみ直す
    const pastBox = document.getElementById('info-past');
    if (!lastUpcomingKey.startsWith(tr.id)) pastBox.open = false;
    lastUpcomingKey = key;
    const item = r => {
      const li = document.createElement('li');
      if (!r) {
        li.className = 'more';
        li.textContent = `… ほか ${rows.length - 7} 駅`;
        return li;
      }
      const [name, c] = p.path[r.i];
      li.innerHTML = '<span class="stop-time"></span><a class="stop-name" role="button" tabindex="0"></a>';
      li.querySelector('.stop-time').textContent = r.time;
      const a = li.querySelector('.stop-name');
      a.textContent = name;
      a.title = `${name} の情報`;
      const open = () => openStation(name, c);
      a.addEventListener('click', open);
      a.addEventListener('keydown', e => { if (e.key === 'Enter') open(); });
      return li;
    };
    const list = document.getElementById('info-stops');
    list.replaceChildren(...shown.map(item));
    list.style.setProperty('--route', tr.service.color);
    pastBox.hidden = past.length === 0;
    const pastList = document.getElementById('info-past-stops');
    pastList.replaceChildren(...past.map(item));
    pastList.style.setProperty('--route', tr.service.color);
  }

  function renderInfo() {
    if (live.selected) {
      renderLiveInfo();
      return;
    }
    const box = document.getElementById('info');
    const tr = state.selected && lastTrains.find(x => x.id === state.selected);
    if (!state.selected || !tr) {
      box.hidden = true;
      return;
    }
    const sv = tr.service;
    const p = tr.pattern;
    const dest = sv.kind === 'plane'
      ? ({ dep: `${sv.toName} 行き（出発便）`, arr: `${sv.fromName} 発（到着便）` }[sv.flight] || `${sv.toName} 行き（道内便）`)
      : sv.loop ? '' : `${p.destination} 行`;
    const origin = p.path[0][0];
    document.getElementById('info-swatch').style.background = sv.color;
    const cpl = p.couple;
    const coupledNow = cpl && ((cpl.role === 'lead-join' && tr.elapsed >= cpl.at) || (cpl.role === 'lead-split' && tr.elapsed < cpl.at));
    document.getElementById('info-name').textContent =
      coupledNow ? `${sv.name}・${cpl.name.replace('特急 ', '')}（${sv.cars + cpl.cars}両）` : sv.name;
    document.getElementById('info-dest').textContent = dest;
    document.getElementById('info-detail').textContent =
      (sv.kind === 'plane'
        ? ({
          dep: `${sv.fromName} ${formatTime(tr.dep).slice(0, 5)} 離陸`,
          arr: `${sv.toName} ${formatTime(tr.dep + tr.segs[tr.segs.length - 1].t1).slice(0, 5)} 着陸予定`,
        }[sv.flight] || `${sv.fromName} ${formatTime(tr.dep).slice(0, 5)} 離陸 → ${sv.toName} ${formatTime(tr.dep + tr.segs[tr.segs.length - 1].t1).slice(0, 5)} 着陸予定`)
        : `${origin} ${formatTime(tr.dep).slice(0, 5)} 発 · ${p.tripSegs ? '時刻表データ' : '推計ダイヤ'}`)
      + (sv.note ? ` · ${sv.note}` : '');
    const followBtn = document.getElementById('info-follow');
    const noun = { ship: '船', plane: '飛行機' }[sv.kind] || '列車';
    followBtn.textContent = state.follow ? '追跡をやめる' : `この${noun}を追跡`;
    followBtn.setAttribute('aria-pressed', String(state.follow));
    box.hidden = false;
  }

  // ---------------------------------------------------------------- 到達圏
  // 所要時間の段階と色 (青の単色ランプ。近いほど濃い。ライト/ダークで別の段を使う)
  const REACH_BAND_SETS = { 30: [5, 10, 15, 20, 30], 60: [10, 20, 30, 45, 60], 90: [15, 30, 45, 60, 90] };
  let REACH_BANDS = REACH_BAND_SETS[60];
  const REACH_COLORS = {
    light: ['#0d366b', '#184f95', '#256abf', '#3987e5', '#86b6ef'],
    dark: ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf'],
  };

  function reachColor(minutes) {
    const i = REACH_BANDS.findIndex(b => minutes <= b);
    return REACH_COLORS[state.theme][i < 0 ? REACH_BANDS.length - 1 : i];
  }

  function reachGeoJSON() {
    if (!state.reach) return empty();
    return {
      type: 'FeatureCollection',
      features: state.reach.results.map(r => ({
        type: 'Feature',
        properties: {
          name: r.name,
          origin: r.minutes === 0,
          label: `${Math.round(r.minutes)}分`,
          color: r.minutes === 0 ? (state.theme === 'dark' ? '#ffffff' : '#000000') : reachColor(r.minutes),
        },
        geometry: { type: 'Point', coordinates: r.c },
      })),
    };
  }

  function showReach(name, c, { fit = true } = {}) {
    const t0 = ((simTime() % 86400) + 86400) % 86400;
    const maxMinutes = Number(document.getElementById('reach-max').value);
    REACH_BANDS = REACH_BAND_SETS[maxMinutes];
    const results = sim.reachFrom(name, c, t0, { maxMinutes, isVisible: sv => state.groups[sv.group] });
    state.reach = { name, c, t0, maxMinutes, results };
    applyReachMode();
    if (!fit) return;
    // スマートフォンでは凡例と発車案内が重なるので発車案内を閉じる
    if (matchMedia('(max-width: 640px)').matches) {
      state.station = null;
      renderStation();
    }
    // 到達できた範囲が収まるようにカメラを合わせる
    const b = new maplibregl.LngLatBounds();
    results.forEach(r => b.extend(r.c));
    map.fitBounds(b, { padding: { top: 80, bottom: 80, left: 340, right: 320 }, maxZoom: 14.5, pitch: 40, duration: 1500 });
  }

  function clearReach() {
    state.reach = null;
    applyReachMode();
  }

  function applyReachMode() {
    const on = !!state.reach;
    if (map.getSource('reach')) {
      const data = reachGeoJSON();
      map.getSource('reach').setData(data);
      map.getSource('reach-label-data').setData(data);
    }
    // 到達圏の表示中は線路と駅を控えめにする
    if (map.getLayer('tracks')) {
      map.setPaintProperty('tracks', 'line-opacity', on ? 0.3 : 1);
      map.setPaintProperty('tracks-casing', 'line-opacity', on ? 0.2 : 0.7);
      for (const k of ['rail', 'tram']) {
        map.setPaintProperty(`stations-${k}`, 'circle-opacity', on ? 0.25 : 1);
        map.setPaintProperty(`stations-${k}`, 'circle-stroke-opacity', on ? 0.25 : 1);
        map.setLayoutProperty(`labels-${k}`, 'visibility', on ? 'none' : 'visible');
      }
    }
    if (map.getLayer('trains')) map.setPaintProperty('trains', 'fill-extrusion-opacity', on ? 0.25 : 0.95);
    renderReachLegend();
  }

  function renderReachLegend() {
    const box = document.getElementById('reach-legend');
    if (!state.reach) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const r = state.reach;
    document.getElementById('reach-title').textContent =
      `${r.name} を ${formatTime(r.t0).slice(0, 5)} に出発して ${r.maxMinutes} 分で行ける駅`;
    const counts = REACH_BANDS.map((b, i) =>
      r.results.filter(x => x.minutes > 0 && x.minutes <= b && (i === 0 || x.minutes > REACH_BANDS[i - 1])).length);
    const list = document.getElementById('reach-bands');
    list.replaceChildren(...REACH_BANDS.map((b, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<i></i><span>${i === 0 ? 0 : REACH_BANDS[i - 1]}〜${b}分</span><span class="reach-count">${counts[i]}駅</span>`;
      li.querySelector('i').style.background = REACH_COLORS[state.theme][i];
      return li;
    }));
    document.getElementById('reach-total').textContent = `合計 ${r.results.length - 1} 駅`;
  }

  document.getElementById('reach-clear').addEventListener('click', clearReach);
  // 時刻や上限時間を変えて再計算 (カメラはそのまま、比較しやすいように)
  document.getElementById('reach-recalc').addEventListener('click', () => {
    if (state.reach) showReach(state.reach.name, state.reach.c, { fit: false });
  });
  document.getElementById('reach-max').addEventListener('change', () => {
    if (state.reach) showReach(state.reach.name, state.reach.c, { fit: false });
  });
  document.getElementById('station-reach').addEventListener('click', () => {
    if (state.station) showReach(state.station.name, state.station.c);
  });

  // ---------------------------------------------------------------- 空港の利用状況
  function openAirport(id) {
    state.airport = id;
    state.station = null;
    state.selected = null;
    state.follow = false;
    renderInfo();
    renderStation();
    renderAirport();
  }

  const fmtInt = n => Math.round(n).toLocaleString('ja-JP');
  const man = n => `${(n / 10000).toFixed(n >= 1e6 ? 0 : 1)}万`;

  // 単一系列の縦棒グラフ (月別) と折れ線グラフ (年別)。ホバーで値、表でも確認できる
  function barChart(svg, tip, rows, label) {
    const W = 272, H = 96, top = 8, bottom = 16, gap = 2;
    const max = Math.max(...rows.map(r => r.v)) * 1.1;
    const bw = (W - gap * (rows.length - 1)) / rows.length;
    const y = v => H - bottom - (v / max) * (H - top - bottom);
    const nodes = [svgEl('line', { class: 'axis', x1: 0, x2: W, y1: H - bottom, y2: H - bottom })];
    rows.forEach((r, i) => {
      const x = i * (bw + gap);
      const hgt = H - bottom - y(r.v);
      // 上端だけ角を丸めた棒 (4px)
      const rad = Math.min(4, bw / 2, hgt);
      const d = `M${x},${H - bottom}V${y(r.v) + rad}Q${x},${y(r.v)} ${x + rad},${y(r.v)}H${x + bw - rad}` +
        `Q${x + bw},${y(r.v)} ${x + bw},${y(r.v) + rad}V${H - bottom}Z`;
      const bar = svgEl('path', { class: 'bar', d, tabindex: 0 });
      const show = () => {
        svg.querySelectorAll('.bar').forEach(b => b.classList.remove('on'));
        bar.classList.add('on');
        tip.hidden = false;
        tip.innerHTML = '<b></b> <span></span>';
        tip.querySelector('b').textContent = `${man(r.v)}人`;
        tip.querySelector('span').textContent = r.label;
        tip.style.left = `${((x + bw / 2) / W) * 100}%`;
      };
      bar.addEventListener('pointerenter', show);
      bar.addEventListener('focus', show);
      nodes.push(bar);
      if (i % 3 === 0 || i === rows.length - 1) {
        const t = svgEl('text', { class: 'tick', x: x + bw / 2, y: H - 3, 'text-anchor': 'middle' });
        t.textContent = r.short;
        nodes.push(t);
      }
    });
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('aria-label', label);
    svg.replaceChildren(...nodes);
    svg.onpointerleave = () => {
      tip.hidden = true;
      svg.querySelectorAll('.bar').forEach(b => b.classList.remove('on'));
    };
  }

  function lineChart(svg, tip, rows, label) {
    const W = 272, H = 96, top = 10, bottom = 16, side = 6;
    const max = Math.max(...rows.map(r => r.v)) * 1.1;
    const x = i => side + (i / (rows.length - 1)) * (W - side * 2);
    const y = v => H - bottom - (v / max) * (H - top - bottom);
    const d = rows.map((r, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(r.v).toFixed(1)}`).join('');
    const nodes = [
      svgEl('line', { class: 'axis', x1: 0, x2: W, y1: H - bottom, y2: H - bottom }),
      svgEl('path', { class: 'line', d }),
      svgEl('circle', { class: 'dot', r: 4, cx: x(rows.length - 1), cy: y(rows[rows.length - 1].v) }),
    ];
    rows.forEach((r, i) => {
      if (i === 0 || i === rows.length - 1 || r.short === '2020') {
        const t = svgEl('text', { class: 'tick', x: x(i), y: H - 3, 'text-anchor': i === 0 ? 'start' : i === rows.length - 1 ? 'end' : 'middle' });
        t.textContent = r.short;
        nodes.push(t);
      }
    });
    const hair = svgEl('line', { class: 'hair', y1: top - 4, y2: H - bottom, visibility: 'hidden' });
    const hot = svgEl('circle', { class: 'dot', r: 4, visibility: 'hidden' });
    nodes.push(hair, hot);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('aria-label', label);
    svg.replaceChildren(...nodes);
    svg.onpointermove = e => {
      const rect = svg.getBoundingClientRect();
      const px = (e.clientX - rect.left) / rect.width * W;
      const i = Math.max(0, Math.min(rows.length - 1, Math.round((px - side) / (W - side * 2) * (rows.length - 1))));
      const r = rows[i];
      hair.setAttribute('x1', x(i)); hair.setAttribute('x2', x(i)); hair.setAttribute('visibility', 'visible');
      hot.setAttribute('cx', x(i)); hot.setAttribute('cy', y(r.v)); hot.setAttribute('visibility', 'visible');
      tip.hidden = false;
      tip.innerHTML = '<b></b> <span></span>';
      tip.querySelector('b').textContent = `${man(r.v)}人`;
      tip.querySelector('span').textContent = r.label;
      tip.style.left = `${(x(i) / W) * 100}%`;
    };
    svg.onpointerleave = () => {
      tip.hidden = true;
      hair.setAttribute('visibility', 'hidden');
      hot.setAttribute('visibility', 'hidden');
    };
  }

  function renderAirport() {
    const box = document.getElementById('airport');
    const a = state.airport && (NET.airports || []).find(x => x.id === state.airport);
    if (!a) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const st = a.stats;
    document.getElementById('airport-name').textContent = a.name;
    document.getElementById('airport-kicker').textContent = st ? `空港の利用状況（${st.year}年）` : '空港';
    document.getElementById('airport-meta').textContent =
      `滑走路 ${fmtInt(a.runway)} m ・ 運用 ${a.hours[0].slice(0, 2)}:${a.hours[0].slice(2)}〜${a.hours[1].slice(0, 2)}:${a.hours[1].slice(2)}`;
    document.getElementById('airport-stats').hidden = !st;
    document.getElementById('airport-routes').textContent = st ? '' :
      `就航先（推計）: ${a.routes.map(r => `${r.dest} ${r.perDay}便`).join('・')}`;
    if (!st) {
      renderAirportFlights();
      return;
    }
    document.getElementById('airport-total').textContent = `${fmtInt(st.passengers)} 人`;
    document.getElementById('airport-split').textContent =
      `国内線 ${man(st.domestic)}人 ・ 国際線 ${man(st.international)}人 ・ 着陸 ${fmtInt(st.landings)} 回`;
    const monthly = st.monthly.map(m => ({ v: m.passengers, label: `${st.year}年${m.month}月`, short: `${m.month}月` }));
    barChart(document.getElementById('airport-monthly'), document.getElementById('airport-monthly-tip'), monthly,
      `${a.name} ${st.year}年の月別乗降客数。最多は${monthly.reduce((b, r) => (r.v > b.v ? r : b)).label}`);
    const trend = st.trend.map(t => ({ v: t.passengers, label: `${t.year}年`, short: String(t.year) }));
    lineChart(document.getElementById('airport-trend'), document.getElementById('airport-trend-tip'), trend,
      `${a.name}の乗降客数の推移（${trend[0].label}〜${trend[trend.length - 1].label}）`);
    const tbody = document.querySelector('#airport-table tbody');
    tbody.replaceChildren(...st.trend.map(t => {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td></td><td></td><td></td>';
      tr.children[0].textContent = `${t.year}年`;
      tr.children[1].textContent = fmtInt(t.passengers);
      tr.children[2].textContent = fmtInt(t.landings);
      return tr;
    }));
    renderAirportFlights();
  }

  function renderAirportFlights() {
    const a = state.airport && (NET.airports || []).find(x => x.id === state.airport);
    if (!a) return;
    renderAirportLive(a);
    const t = ((simTime() % 86400) + 86400) % 86400;
    const visible = sv => state.groups[sv.group];
    const deps = sim.departuresAt(a.name, a.coord, t, { limit: 4, radius: 4000, isVisible: visible });
    const arrs = sim.arrivalsAt(a.name, a.coord, t, { limit: 4, radius: 4000, isVisible: visible });
    const row = (time, text) => {
      const li = document.createElement('li');
      li.innerHTML = '<span class="dep-time"></span><span class="dep-name"></span>';
      li.querySelector('.dep-time').textContent = formatTime(time).slice(0, 5);
      li.querySelector('.dep-name').textContent = text;
      return li;
    };
    document.getElementById('airport-deps').replaceChildren(...deps.map(d => row(d.time, `${d.service.toName} 行き`)));
    document.getElementById('airport-arrs').replaceChildren(...arrs.map(d => row(d.time, `${d.service.fromName} から`)));
  }

  document.getElementById('airport-close').addEventListener('click', () => {
    state.airport = null;
    renderAirport();
  });

  // ---------------------------------------------------------------- 駅の発車案内
  function shortName(sv) {
    const m = sv.name.match(/^(\d+系統)/);
    return m ? m[1] : sv.name;
  }

  function destinationOf(p) {
    return p.service.loop ? p.service.name.replace(/^\d+系統\s*/, '') : `${p.destination} 行`;
  }

  function openStation(name, c) {
    state.airport = null;
    renderAirport();
    state.station = { name, c };
    state.selected = null;
    state.follow = false;
    renderInfo();
    renderStation();
  }

  // 駅の情報: 種別・乗り入れる路線・1 日の発車本数と始発・最終 (駅ごとに覚えておく)
  const stationFacts = new Map();
  function stationInfo(name, c) {
    const key = `${sim.dayType}|${name}|${c.join()}`;
    if (stationFacts.has(key)) return stationFacts.get(key);
    const lines = [];
    for (const l of NET.lines) {
      if (!l.stations.some(([n, sc]) => n === name && Sim.haversine(sc, c) < 400)) continue;
      if (!lines.some(x => x.name === l.name)) lines.push(l);
    }
    // 4 時を 1 日の区切りとして、その日の発車をすべて数える
    const all = sim.departuresAt(name, c, 4 * 3600, { limit: Infinity, horizon: 86399 });
    const info = { lines, count: all.length, first: all[0], last: all[all.length - 1], dirs: directionsOf(all) };
    stationFacts.set(key, info);
    return info;
  }
  // 方面: 駅を出て最初に通る駅で分ける。見出しは行き先の多い順に 2 つまで（例: 「小樽・あいの里公園 方面」）
  function dirKey(d) { return d.toward || destinationOf(d.pattern); }
  function directionsOf(deps) {
    const dirs = new Map();
    for (const d of deps) {
      const key = dirKey(d);
      if (!dirs.has(key)) dirs.set(key, new Map());
      const dest = d.pattern.service.loop ? shortName(d.service) : d.pattern.destination;
      dirs.get(key).set(dest, (dirs.get(key).get(dest) || 0) + 1);
    }
    return [...dirs.entries()]
      .map(([key, n]) => ({
        key,
        count: [...n.values()].reduce((a, b) => a + b, 0),
        title: `${[...n.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(x => x[0]).join('・')} 方面`,
      }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key, 'ja')); // 本数の多い方面から
  }
  const KIND_LABEL = { rail: '駅', tram: '停留場', ship: '港（旅客船ターミナル）', bus: '高速バスの停留所' };

  function renderStationInfo(rows) {
    const dl = document.getElementById('station-info');
    dl.replaceChildren(...rows.flatMap(([k, v]) => {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      if (typeof v === 'string') dd.textContent = v; else dd.append(...v);
      return [dt, dd];
    }));
  }

  function lineChip(l) {
    const span = document.createElement('span');
    span.className = 'line-chip';
    span.innerHTML = '<i></i><span></span>';
    span.querySelector('i').style.background = l.color;
    // 路線名から事業者が分かるとき (JR○○線、札幌市営地下鉄、函館市電、船会社名入りの航路) は事業者を書かない
    const op = l.operator && !l.name.startsWith(l.operator.slice(0, 2)) && !l.name.includes(l.operator) ? `（${l.operator}）` : '';
    span.querySelector('span').textContent = l.name + op;
    return span;
  }

  function renderStation() {
    const box = document.getElementById('station');
    if (!state.station) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    document.getElementById('station-name').textContent = state.station.name;
    document.getElementById('station-reach').hidden = !!state.station.bus;
    if (state.station.bus) {
      document.getElementById('station-kicker').textContent = 'バス停';
      document.getElementById('station-board-title').textContent = '発車時刻（この先 3 時間）';
      document.getElementById('station-dirs').hidden = true;
      renderBusStop();
      return;
    }
    const facts = stationInfo(state.station.name, state.station.c);
    const kind = facts.lines.length ? facts.lines[0].kind : 'rail';
    document.getElementById('station-kicker').textContent = KIND_LABEL[kind] || '駅';
    const hm = d => formatTime(d.time).slice(0, 5);
    const day = sim.dayType === 'holiday' ? '土休日' : '平日';
    renderStationInfo([
      ['路線', facts.lines.map(lineChip)],
      ['発車本数', facts.count ? `${day} 1 日 ${facts.count} 本` : '発車する便はありません'],
      ...(facts.count ? [['始発・最終', `${hm(facts.first)}（${destinationOf(facts.first.pattern)}）／${hm(facts.last)}（${destinationOf(facts.last.pattern)}）`]] : []),
      ['位置', `北緯 ${state.station.c[1].toFixed(4)}°・東経 ${state.station.c[0].toFixed(4)}°`],
    ]);
    document.getElementById('station-board-title').textContent = '発車案内（方面を選んで切り替え）';

    const t = ((simTime() % 86400) + 86400) % 86400;
    const deps = sim.departuresAt(state.station.name, state.station.c, t, {
      limit: 200, isVisible: sv => state.groups[sv.group],
    });
    // 方面はタブで切り替える。最初は 1 つめの方面
    const dirs = facts.dirs;
    if (!dirs.some(d => d.key === state.station.dir)) state.station.dir = dirs.length ? dirs[0].key : null;
    const tabs = document.getElementById('station-dirs');
    const tabKey = `${state.station.name}|${state.station.dir}|${dirs.map(d => d.key).join()}`;
    if (tabs.dataset.key !== tabKey) {
      tabs.dataset.key = tabKey;
      tabs.replaceChildren(...dirs.map(d => {
        const b = document.createElement('button');
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', String(d.key === state.station.dir));
        b.innerHTML = '<span></span><small></small>';
        b.querySelector('span').textContent = d.title;
        b.querySelector('small').textContent = `次は ${d.key}`;
        b.addEventListener('click', () => { state.station.dir = d.key; renderStation(); });
        return b;
      }));
    }
    tabs.hidden = dirs.length < 2;
    const shown = deps.filter(d => dirKey(d) === state.station.dir).slice(0, 8);
    const list = document.getElementById('station-deps');
    list.replaceChildren(...shown.map(d => {
      const li = document.createElement('li');
      const min = Math.floor(d.wait / 60);
      li.innerHTML = `<span class="dep-time">${formatTime(d.time).slice(0, 5)}</span>
        <i class="dep-swatch"></i>
        <span class="dep-name"></span>
        <span class="dep-wait">${min === 0 ? 'まもなく' : `${min}分後`}</span>`;
      li.querySelector('.dep-swatch').style.background = d.service.color;
      li.querySelector('.dep-name').textContent =
        `${shortName(d.service)} ${destinationOf(d.pattern)}${d.first ? '（始発）' : ''}`;
      return li;
    }));
    document.getElementById('station-empty').textContent = dirs.length > 1 ? 'この方面に 3 時間以内に発車する列車はありません。' : '3 時間以内に発車する列車はありません。';
    document.getElementById('station-empty').hidden = shown.length > 0;
    // 時刻の出どころ (時刻表データか推計か) を明記する
    const real = deps.filter(d => d.pattern.tripSegs).length;
    document.getElementById('station-source').textContent =
      real === deps.length && real > 0 ? '発車時刻は時刻表データ（GTFS）にもとづきます。'
        : real > 0 ? '発車時刻は時刻表データ（GTFS）と運行パターンからの推計の混在です。'
          : '発車時刻は運行パターンからの推計です。';
  }


  document.getElementById('station-close').addEventListener('click', () => {
    state.station = null;
    renderStation();
  });

  document.getElementById('info-follow').addEventListener('click', () => {
    state.follow = !state.follow;
    const la = live.selected && live.list.find(x => x.hex === live.selected);
    if (state.follow && la) map.easeTo({ center: livePosition(la).c, zoom: Math.max(map.getZoom(), 12), pitch: 60, duration: 800 });
    if (state.follow && !la) {
      const tr = lastTrains.find(x => x.id === state.selected);
      if (tr) {
        map.easeTo({ center: tr.pattern.pointAt(tr.dist).c, zoom: Math.max(map.getZoom(), 15.5), pitch: 60, duration: 800 });
      }
    }
    renderInfo();
  });
  document.getElementById('info-close').addEventListener('click', () => {
    state.selected = null;
    live.selected = null;
    state.follow = false;
    renderInfo();
  });

  // ---------------------------------------------------------------- 操作パネル
  const SPEEDS = [1, 10, 60, 300];

  function renderClockControls() {
    document.querySelectorAll('[data-speed]').forEach(b => {
      b.setAttribute('aria-pressed', String(!state.clock.paused && Number(b.dataset.speed) === state.clock.speed));
    });
    document.getElementById('pause').setAttribute('aria-pressed', String(state.clock.paused));
    document.getElementById('pause').textContent = state.clock.paused ? '▶' : '❚❚';
  }

  const speedBox = document.getElementById('speeds');
  for (const s of SPEEDS) {
    const b = document.createElement('button');
    b.dataset.speed = s;
    b.textContent = s === 1 ? '実時間' : `×${s}`;
    b.addEventListener('click', () => setClock(simTime(), s, false));
    speedBox.appendChild(b);
  }
  document.getElementById('pause').addEventListener('click', () => {
    setClock(simTime(), state.clock.speed, !state.clock.paused);
  });
  document.getElementById('now').addEventListener('click', () => setClock(jstNow(), 1, false));
  document.getElementById('jump').addEventListener('change', e => {
    if (e.target.value) setClock(parseTime(e.target.value), state.clock.speed);
  });
  renderClockControls();

  const legend = document.getElementById('legend');
  for (const g of NET.groups) {
    const services = NET.services.filter(s => s.group === g.id);
    const colors = [...new Set(services.map(s => s.color))].slice(0, 6);
    if (!colors.length && g.color) colors.push(g.color); // 路線バス (動かさない) は群の色
    const label = document.createElement('label');
    label.className = 'legend-item';
    label.innerHTML = `<input type="checkbox" checked>
      <span class="legend-swatches">${colors.map(c => `<i style="background:${c}"></i>`).join('')}</span>
      <span>${g.name}</span>`;
    label.querySelector('input').addEventListener('change', e => {
      state.groups[g.id] = e.target.checked;
      applyGroupFilter();
      renderDayChart();
    });
    legend.appendChild(label);
  }

  // 駅の検索: 同名で場所の違う駅には路線名を添える
  const stationIndex = (() => {
    const byName = new Map();
    for (const l of NET.lines) {
      for (const [name, c] of l.stations) {
        const list = byName.get(name) || [];
        if (!list.some(x => Sim.haversine(x.c, c) < 400)) list.push({ name, c, line: l.name, kind: l.kind });
        byName.set(name, list);
      }
    }
    const entries = [];
    for (const list of byName.values()) {
      for (const st of list) entries.push({ ...st, label: list.length > 1 ? `${st.name}（${st.line}）` : st.name });
    }
    for (const a of NET.airports || []) entries.push({ name: a.name, c: a.coord, line: '空港', kind: 'air', label: a.name, airport: a.id });
    return entries.sort((a, b) => a.label.localeCompare(b.label, 'ja'));
  })();
  const datalist = document.getElementById('station-list');
  for (const st of stationIndex) {
    const o = document.createElement('option');
    o.value = st.label;
    datalist.appendChild(o);
  }
  document.getElementById('search').addEventListener('change', e => {
    const st = stationIndex.find(x => x.label === e.target.value.trim()) ||
      stationIndex.find(x => x.name === e.target.value.trim());
    if (!st) return;
    state.follow = false;
    map.flyTo({ center: st.c, zoom: st.kind === 'tram' ? 16.3 : st.airport ? 12.5 : 15.3, pitch: 60, duration: 2000, essential: true });
    if (st.airport) openAirport(st.airport);
    else openStation(st.name, st.c);
    e.target.blur();
  });

  document.querySelectorAll('[data-view]').forEach(b => {
    b.addEventListener('click', () => {
      state.follow = false;
      map.flyTo({ ...VIEWS[b.dataset.view], duration: 2500, essential: true });
    });
  });

  const themeBtn = document.getElementById('theme');
  const buildingsBtn = document.getElementById('buildings');
  const terrainBtn = document.getElementById('terrain');
  const liteBtn = document.getElementById('lite');
  function renderToggles() {
    liteBtn.setAttribute('aria-pressed', String(state.lite));
    document.documentElement.dataset.theme = state.theme;
    themeBtn.textContent = { auto: '地図: 自動（昼夜）', light: '地図: ライト', dark: '地図: ダーク' }[state.themeMode];
    buildingsBtn.setAttribute('aria-pressed', String(state.buildings));
    terrainBtn.setAttribute('aria-pressed', String(state.terrain));
  }
  themeBtn.addEventListener('click', () => {
    const order = ['auto', 'light', 'dark'];
    state.themeMode = order[(order.indexOf(state.themeMode) + 1) % order.length];
    const theme = resolveTheme(simTime());
    if (theme !== state.theme) {
      state.theme = theme;
      loadStyle();
    }
    renderToggles();
  });
  buildingsBtn.addEventListener('click', () => {
    state.buildings = !state.buildings;
    renderToggles();
    applyBuildingVisibility();
  });
  terrainBtn.addEventListener('click', () => {
    state.terrain = !state.terrain;
    renderToggles();
    applyTerrain();
    if (state.terrain && map.getPitch() < 50) map.easeTo({ pitch: 60 });
  });
  liteBtn.addEventListener('click', () => {
    state.lite = !state.lite;
    try {
      localStorage.setItem('mh3d-lite', state.lite ? '1' : '0');
    } catch (e) { /* 保存できなくても動作には影響しない */ }
    // 軽量モードでは 3D 建物と地形を消す。戻すときは 3D 建物だけ戻す (地形は元々オフ)
    state.buildings = !state.lite;
    if (state.lite) state.terrain = false;
    applyBuildingVisibility();
    applyTerrain();
    if (map.getLayer('bus-routes')) map.setLayerZoomRange('bus-routes', state.lite ? BUS_ROUTE_ZOOM_LITE : BUS_ROUTE_ZOOM, 24);
    lastDrawKey = '';
    renderToggles();
  });
  renderToggles();

  // ---------------------------------------------------------------- 1日の運行本数
  // 10 分ごとに運行中の列車を数えた折れ線。ホバーで値、クリックでその時刻へ移動
  const CHART = { w: 272, h: 84, left: 4, right: 4, top: 8, bottom: 16, step: 600 };
  let dayCounts = null;
  let dayKey = '';

  function computeDayCounts() {
    const key = sim.dayType + NET.groups.map(g => (state.groups[g.id] ? 1 : 0)).join('');
    if (key === dayKey && dayCounts) return dayCounts;
    dayKey = key;
    dayCounts = [];
    for (let t = 0; t <= 86400; t += CHART.step) {
      dayCounts.push(sim.trainsAt(t % 86400, sv => state.groups[sv.group]).length);
    }
    return dayCounts;
  }

  const chartX = t => CHART.left + (t / 86400) * (CHART.w - CHART.left - CHART.right);
  function chartY(v, max) {
    return CHART.h - CHART.bottom - (v / max) * (CHART.h - CHART.top - CHART.bottom);
  }

  function svgEl(tag, attrs) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }

  function renderDayChart() {
    const counts = computeDayCounts();
    const max = Math.max(10, ...counts) * 1.1;
    const svg = document.getElementById('daychart-svg');
    const pts = counts.map((v, i) => `${chartX(i * CHART.step).toFixed(1)},${chartY(v, max).toFixed(1)}`);
    const base = chartY(0, max);
    const nodes = [
      svgEl('path', { class: 'area', d: `M${chartX(0)},${base}L${pts.join('L')}L${chartX(86400)},${base}Z` }),
      svgEl('path', { class: 'line', d: `M${pts.join('L')}` }),
      svgEl('line', { class: 'axis', x1: chartX(0), x2: chartX(86400), y1: base, y2: base }),
    ];
    for (const h of [0, 6, 12, 18, 24]) {
      const t = svgEl('text', { class: 'tick', x: chartX(h * 3600), y: CHART.h - 3, 'text-anchor': h === 0 ? 'start' : h === 24 ? 'end' : 'middle' });
      t.textContent = `${h}時`;
      nodes.push(t);
    }
    nodes.push(svgEl('line', { class: 'now', id: 'daychart-now', y1: CHART.top - 4, y2: base }));
    nodes.push(svgEl('line', { class: 'hair', id: 'daychart-hair', y1: CHART.top - 4, y2: base, visibility: 'hidden' }));
    nodes.push(svgEl('circle', { class: 'dot', id: 'daychart-dot', r: 4, visibility: 'hidden' }));
    svg.replaceChildren(...nodes);
    const peak = Math.max(...counts);
    svg.setAttribute('aria-label', `時刻ごとの運行中の列車本数。最大 ${peak} 本（${formatTime(counts.indexOf(peak) * CHART.step).slice(0, 5)} 頃）`);
    // 表で見る (1 時間ごと)
    const tbody = document.querySelector('#daychart-table tbody');
    tbody.replaceChildren(...Array.from({ length: 24 }, (_, h) => {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td></td><td></td>';
      tr.children[0].textContent = `${String(h).padStart(2, '0')}:00`;
      tr.children[1].textContent = `${counts[h * 6]} 本`;
      return tr;
    }));
    renderChartNow();
  }

  function renderChartNow() {
    const line = document.getElementById('daychart-now');
    if (!line) return;
    const t = ((simTime() % 86400) + 86400) % 86400;
    line.setAttribute('x1', chartX(t));
    line.setAttribute('x2', chartX(t));
  }

  (function bindDayChart() {
    const svg = document.getElementById('daychart-svg');
    const tip = document.getElementById('daychart-tip');
    const toTime = e => {
      const r = svg.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width * CHART.w;
      const frac = (x - CHART.left) / (CHART.w - CHART.left - CHART.right);
      return Math.min(86400 - CHART.step, Math.max(0, Math.round(frac * 86400 / CHART.step) * CHART.step));
    };
    svg.addEventListener('pointermove', e => {
      const t = toTime(e);
      const counts = computeDayCounts();
      const max = Math.max(10, ...counts) * 1.1;
      const v = counts[t / CHART.step];
      const hair = document.getElementById('daychart-hair');
      const dot = document.getElementById('daychart-dot');
      hair.setAttribute('x1', chartX(t)); hair.setAttribute('x2', chartX(t)); hair.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', chartX(t)); dot.setAttribute('cy', chartY(v, max)); dot.setAttribute('visibility', 'visible');
      tip.hidden = false;
      tip.innerHTML = '<b></b> 本 · <span></span>';
      tip.querySelector('b').textContent = String(v);
      tip.querySelector('span').textContent = formatTime(t).slice(0, 5);
      tip.style.left = `${(chartX(t) / CHART.w) * 100}%`;
    });
    svg.addEventListener('pointerleave', () => {
      tip.hidden = true;
      document.getElementById('daychart-hair').setAttribute('visibility', 'hidden');
      document.getElementById('daychart-dot').setAttribute('visibility', 'hidden');
    });
    svg.addEventListener('click', e => setClock(toTime(e), state.clock.speed));
  })();
  renderDayChart();

  // ---------------------------------------------------------------- 実際の飛行機 (ADS-B)
  // tools/serve.py で起動したときだけ使える。/api/live が ADS-B のオープンデータ (adsb.lol など) を中継する。
  // 実際の今の位置なので、時計が「実時間・現在時刻」のときだけ表示し、その間は推計の航空便を隠す
  const LIVE_INTERVAL = 10000; // 問い合わせの間隔 [ms]
  const FT = 0.3048, KT = 0.514444;
  const LIVE_DIMS = { carLength: 40, width: 36, height: 6 };
  const LIVE_COLOR = '#ffb300';
  const liveBtn = document.getElementById('live');
  const angDiff = (a, b) => Math.abs((((a - b) % 360) + 540) % 360 - 180);

  function liveRealtime() {
    const c = state.clock;
    const diff = Math.abs((((simTime() - jstNow()) % 86400) + 86400 + 43200) % 86400 - 43200);
    return !c.paused && c.speed === 1 && diff < 120;
  }

  function liveActive() {
    return live.on && live.available === true && liveRealtime();
  }

  async function pollLive() {
    if (!live.on || live.busy || !liveRealtime()) return;
    live.busy = true;
    // 画面の中心から、画面の角までの距離 (海里) の範囲。提供元の上限は 250 海里
    const c = map.getCenter();
    const b = map.getBounds();
    const nm = Math.min(250, Math.max(20, Sim.haversine([c.lng, c.lat], [b.getEast(), b.getNorth()]) / 1852));
    try {
      const res = await fetch(`api/live?lat=${c.lat.toFixed(3)}&lon=${c.lng.toFixed(3)}&dist=${Math.ceil(nm)}`, { cache: 'no-store' });
      if (res.status === 404) {
        live.available = false; // python -m http.server で開いている
      } else {
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
        live.available = true;
        live.error = '';
        live.source = d.source;
        live.fetchedAt = performance.now();
        // 地上の車両など (カテゴリ C) は除く
        live.list = (d.aircraft || []).filter(a => typeof a.lat === 'number' && typeof a.lon === 'number' && !String(a.category || '').startsWith('C'));
        for (const a of live.list) {
          const r = liveRunwayOf(a);
          if (r) live.seen[r.airport.id] = [...(live.seen[r.airport.id] || []).filter(x => x.hex !== a.hex), { ...r, hex: a.hex, flight: callsign(a), at: Date.now() }];
        }
      }
    } catch (e) {
      live.error = String(e.message || e);
    }
    live.busy = false;
    renderLiveNote();
  }

  function callsign(a) {
    return (a.flight || '').trim() || (a.r ? a.r : `機体 ${a.hex}`);
  }

  // 受信した位置から、速度と進行方向で今の位置を推定する (最大 60 秒先まで)
  function livePosition(a) {
    const age = Math.min(60, (performance.now() - live.fetchedAt) / 1000 + (a.seen_pos || 0));
    const ground = a.alt_baro === 'ground';
    const trk = a.track ?? a.true_heading ?? a.mag_heading ?? 0;
    const brg = trk * Math.PI / 180;
    const c = a.gs && age > 0 ? offset([a.lon, a.lat], brg, a.gs * KT * age) : [a.lon, a.lat];
    const altFt = ground ? 0 : (typeof a.alt_baro === 'number' ? a.alt_baro : (a.alt_geom || 0));
    return { c, brg, alt: Math.max(0, altFt * FT), ground, age };
  }

  function livePoints() {
    return live.list.map(a => ({ type: 'Feature', properties: { id: `live:${a.hex}`, color: a.hex === live.selected ? '#ff6d00' : LIVE_COLOR },
      geometry: { type: 'Point', coordinates: livePosition(a).c } }));
  }

  function liveFeatures(scale, features, lights) {
    for (const a of live.list) {
      const p = livePosition(a);
      drawPlane(`live:${a.hex}`, p.c, p.brg, p.alt, LIVE_DIMS, a.hex === live.selected ? '#ff6d00' : LIVE_COLOR, scale, features, lights);
    }
  }

  // 使用滑走路の推定: 空港から 8km 以内で、高度 2000ft 未満 (または地上を 30kt 以上で走行中)、
  // 進行方向が滑走路の向きと 20 度以内。平行滑走路の L / R は、空港標点から見て左右どちらにいるかで決める
  function liveRunwayOf(a) {
    const ground = a.alt_baro === 'ground';
    if (!ground && !(typeof a.alt_baro === 'number' && a.alt_baro < 2000)) return null;
    if ((a.gs || 0) < 30) return null;
    const trk = a.track ?? a.true_heading;
    if (trk == null) return null;
    const pos = [a.lon, a.lat];
    for (const ap of NET.airports || []) {
      if (!ap.runwayEnds || Sim.haversine(pos, ap.coord) > 8000) continue;
      const end = ap.runwayEnds.find(e => angDiff(e.heading, trk) < 20);
      if (!end) continue;
      let name = end.name;
      if (ap.parallel) {
        const rel = (Sim.bearing(ap.coord, pos) * 180 / Math.PI) - end.heading;
        name += Math.sin(rel * Math.PI / 180) > 0 ? 'R' : 'L';
      }
      const rate = a.baro_rate ?? a.geom_rate;
      const toward = angDiff(Sim.bearing(pos, ap.coord) * 180 / Math.PI, trk) < 90;
      const phase = ground ? '滑走中' : rate != null && Math.abs(rate) > 200 ? (rate < 0 ? '着陸' : '離陸') : (toward ? '着陸' : '離陸');
      return { airport: ap, name, phase };
    }
    return null;
  }

  function renderLiveInfo() {
    const box = document.getElementById('info');
    const a = live.list.find(x => x.hex === live.selected);
    if (!a || !liveActive()) {
      box.hidden = true;
      return;
    }
    const p = livePosition(a);
    document.getElementById('info-swatch').style.background = LIVE_COLOR;
    document.getElementById('info-name').textContent = callsign(a);
    document.getElementById('info-dest').textContent =
      [a.t ? `機材 ${a.t}` : '機材 不明', a.r ? `機体番号 ${a.r}` : ''].filter(Boolean).join(' ・ ');
    const r = liveRunwayOf(a);
    const move = p.ground
      ? `地上を走行中（${Math.round((a.gs || 0) * 1.852)} km/h）`
      : `高度 約${fmtInt(Math.round(p.alt / 10) * 10)} m ・ 速度 約${fmtInt(Math.round((a.gs || 0) * 1.852))} km/h`;
    document.getElementById('info-status').textContent =
      move + (r ? ` ・ ${r.airport.name} ${r.name} で${r.phase}（使用滑走路は推定）` : '');
    document.getElementById('info-detail').textContent =
      `実際の飛行機（ADS-B、${live.source}）・ ${Math.round(p.age)} 秒前の受信位置から推定` + (a.desc ? ` ・ ${a.desc}` : '');
    document.getElementById('info-stops').replaceChildren();
    document.getElementById('info-past').hidden = true;
    const followBtn = document.getElementById('info-follow');
    followBtn.textContent = state.follow ? '追跡をやめる' : 'この飛行機を追跡';
    followBtn.setAttribute('aria-pressed', String(state.follow));
    box.hidden = false;
  }

  function updateLiveSelection() {
    const a = live.list.find(x => x.hex === live.selected);
    if (a && state.follow && liveActive()) map.jumpTo({ center: livePosition(a).c });
  }

  // 空港のカード: 直近 10 分に観測した離着陸から、使っている滑走路を推定して表示する
  function renderAirportLive(ap) {
    const el = document.getElementById('airport-live');
    if (!live.on) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const recent = (live.seen[ap.id] || []).filter(x => Date.now() - x.at < 10 * 60000).sort((x, y) => y.at - x.at);
    live.seen[ap.id] = recent;
    if (!liveActive()) {
      el.textContent = '使用滑走路（ADS-B から推定）: 実時間・現在時刻のときに表示します';
    } else if (!recent.length) {
      el.textContent = '使用滑走路（ADS-B から推定）: この 10 分間に離着陸は観測されていません';
    } else {
      const ago = x => Math.max(0, Math.round((Date.now() - x.at) / 60000));
      el.textContent = '使用滑走路（ADS-B から推定）: ' +
        recent.slice(0, 3).map(x => `${x.name} ${x.phase}（${x.flight}・${ago(x) ? `${ago(x)}分前` : 'いま'}）`).join(' ／ ');
    }
  }

  function renderLiveNote() {
    const note = document.getElementById('live-note');
    liveBtn.setAttribute('aria-pressed', String(live.on));
    if (!live.on) {
      note.hidden = true;
      return;
    }
    note.hidden = false;
    if (live.available === false) {
      note.textContent = '実際の飛行機を表示するには、python -m http.server ではなく tools/serve.py で起動してください（README の「使い方」）。';
    } else if (!liveRealtime()) {
      note.textContent = '実際の飛行機は、時計が「実時間」で現在時刻のときだけ表示されます（「現在時刻」を押してください）。';
    } else if (live.error) {
      note.textContent = `ADS-B のデータを取得できません（${live.error}）。10 秒後にもう一度試します。`;
    } else if (live.available) {
      note.textContent = `実際の飛行機 ${live.list.length} 機を表示中（ADS-B、${live.source}・ODbL）。推計の航空便は隠しています。機体をクリックで便名・機材・推定の使用滑走路。`;
    } else {
      note.textContent = '実際の飛行機のデータを読み込み中…';
    }
  }

  liveBtn.addEventListener('click', () => {
    live.on = !live.on;
    clearInterval(live.timer);
    if (live.on) {
      live.timer = setInterval(pollLive, LIVE_INTERVAL);
      pollLive();
    } else {
      live.list = [];
      live.selected = null;
      renderInfo();
    }
    renderLiveNote();
    if (state.airport) renderAirportFlights();
  });
  document.getElementById('now').addEventListener('click', () => { if (live.on) pollLive(); });

  // ---------------------------------------------------------------- 路線バスの停留所と時刻表
  // 路線バスは動かさず、停留所をクリックしたときに時刻表データ (data/bus/*.json) を読み込んで、この先の発車時刻を出す
  const busTables = new Map(); // 読み込んだ時刻表 (ファイル番号 → データ または Promise)
  // 停留所名の表記ゆれを揃える (全角・半角、ヶ、空白、漢数字: 大通西三丁目 → 大通西3丁目)
  const kanjiNum = k => {
    let n = 0, cur = 0;
    for (const ch of k) {
      if (ch === '十') { n += (cur || 1) * 10; cur = 0; } else cur = '〇一二三四五六七八九'.indexOf(ch);
    }
    return String(n + cur);
  };
  const normName = n => n.normalize('NFKC').replace(/ヶ/g, 'ケ').replace(/[\s\u3000]/g, '').replace(/[〇一二三四五六七八九十]+/g, kanjiNum);

  function loadBusTable(k) {
    if (!busTables.has(k)) {
      busTables.set(k, fetch(BUS.timetables[k].file).then(r => r.json()).then(d => { busTables.set(k, d); return d; })
        .catch(() => { busTables.delete(k); return null; }));
    }
    return busTables.get(k);
  }

  // 同じ名前で 300m 以内 (または名前が違っても 40m 以内) の、時刻表データの停留所
  function busTimetableStops(name, c) {
    const n = normName(name);
    return BUS.ttStops.filter(([tn, tc]) => {
      const d = Sim.haversine(c, tc);
      return d < 40 || (d < 300 && normName(tn) === n);
    });
  }

  function openBusStop(i) {
    const [name, c, ops, routes] = BUS.stops[i];
    state.airport = null;
    renderAirport();
    state.selected = null;
    live.selected = null;
    state.follow = false;
    renderInfo();
    const tt = busTimetableStops(name, c);
    state.station = { name, c, bus: { ops: ops.map(o => BUS.operators[o]), routes: routes.map(r => BUS.routeNames[r]), tt } };
    renderStation();
    Promise.all(tt.map(([, , k]) => loadBusTable(k))).then(() => { if (state.station && state.station.name === name) renderStation(); });
  }

  // 今日のダイヤの種類: 1 平日 2 土曜 4 日祝 (「土休日ダイヤ」に切り替えたときは、今日が土曜なら土曜、それ以外は日祝)
  function busDayBit() {
    if (sim.dayType === 'weekday') return 1;
    const d = new Date(Date.now() + 9 * 3600 * 1000);
    return d.getUTCDay() === 6 && sim.dayTypeOf(todayYmd) === 'holiday' && !(NET.calendar.holidays || []).includes(todayYmd) ? 2 : 4;
  }

  function renderBusStop() {
    const b = state.station.bus;
    const now = Math.floor((((simTime() % 86400) + 86400) % 86400) / 60);
    const bit = busDayBit();
    const rows = [];
    let loading = false;
    for (const [, , k, si] of b.tt) {
      const t = busTables.get(k);
      if (!t || t instanceof Promise) { loading = true; continue; }
      for (const [m, r, h, mask] of t.stops[si][2]) {
        if (!(mask & bit)) continue;
        const wait = ((m - now) % 1440 + 1440) % 1440;
        if (wait > 180) continue;
        rows.push({ m, wait, route: t.routes[r], head: t.heads[h], op: t.op });
      }
    }
    rows.sort((x, y) => x.wait - y.wait);
    const list = document.getElementById('station-deps');
    list.replaceChildren(...rows.slice(0, 8).map(d => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="dep-time">${String(Math.floor(d.m / 60) % 24).padStart(2, '0')}:${String(d.m % 60).padStart(2, '0')}</span>
        <i class="dep-swatch"></i><span class="dep-name"></span>
        <span class="dep-wait">${d.wait === 0 ? 'まもなく' : `${d.wait}分後`}</span>`;
      li.querySelector('.dep-swatch').style.background = '#8d6e63';
      li.querySelector('.dep-name').textContent = `${d.route ? `${d.route} ` : ''}${d.head} 行`;
      li.title = d.op;
      return li;
    }));
    const empty = document.getElementById('station-empty');
    empty.hidden = rows.length > 0 || loading;
    empty.textContent = b.tt.length ? '3 時間以内に発車するバスはありません。' : 'この停留所の時刻表データはありません。';
    const day = { 1: '平日', 2: '土曜', 4: '日祝' }[bit];
    renderStationInfo([
      ['事業者', b.ops.join('・') || '不明'],
      ...(b.routes.length ? [['路線', `${b.routes.slice(0, 8).join('、')}${b.routes.length > 8 ? ` ほか ${b.routes.length - 8}` : ''}`]] : []),
      ['位置', `北緯 ${state.station.c[1].toFixed(4)}°・東経 ${state.station.c[0].toFixed(4)}°`],
    ]);
    document.getElementById('station-source').textContent = loading ? '時刻表を読み込み中…'
      : `${b.tt.length ? `発車時刻は事業者の時刻表データ（GTFS、${day}のダイヤ）です。` : ''}路線バスは地図上では動きません。`;
  }

  // ---------------------------------------------------------------- 平日 / 土休日ダイヤ
  const dayBtn = document.getElementById('daytype');
  function renderDayType() {
    dayBtn.textContent = sim.dayType === 'holiday' ? '土休日ダイヤ' : '平日ダイヤ';
  }
  dayBtn.addEventListener('click', () => {
    sim.setDayType(sim.dayType === 'holiday' ? 'weekday' : 'holiday');
    // 便の番号が変わるので、選択中の列車と到達圏は解除する
    state.selected = null;
    state.follow = false;
    renderInfo();
    if (state.reach) clearReach();
    dayKey = '';
    renderDayChart();
    if (state.station) renderStation();
    renderDayType();
  });
  renderDayType();

  // ---------------------------------------------------------------- 撮影モード・共有
  // 撮影モード: パネル類を隠し、カメラをゆっくり回転させる (動画・GIF 撮影用)
  let cinemaFrame = null;
  function setCinema(on) {
    document.body.classList.toggle('cinema', on);
    if (cinemaFrame) cancelAnimationFrame(cinemaFrame);
    cinemaFrame = null;
    if (!on) return;
    let last = performance.now();
    const spin = now => {
      const dt = now - last;
      last = now;
      // 利用者がドラッグ中のときは回さない (追跡中はカメラが常に動いているので回す)
      if (state.follow || !map.isMoving()) map.setBearing(map.getBearing() + dt * 0.004);
      cinemaFrame = requestAnimationFrame(spin);
    };
    cinemaFrame = requestAnimationFrame(spin);
  }
  document.getElementById('cinema').addEventListener('click', () => setCinema(true));
  document.getElementById('cinema-exit').addEventListener('click', () => setCinema(false));
  // キーボード操作: Space 一時停止 / 1-4 倍速 / N 現在時刻 / C 撮影モード / F 追跡 / Esc 閉じる
  document.addEventListener('keydown', e => {
    if (e.target.closest('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
    const cinema = document.body.classList.contains('cinema');
    if (e.key === 'Escape') {
      if (cinema) setCinema(false);
      else {
        state.selected = null;
        state.station = null;
        state.follow = false;
        renderInfo();
        renderStation();
      }
    } else if (e.key === ' ') {
      e.preventDefault();
      setClock(simTime(), state.clock.speed, !state.clock.paused);
    } else if (['1', '2', '3', '4'].includes(e.key)) {
      setClock(simTime(), SPEEDS[Number(e.key) - 1], false);
    } else if (e.key === 'n' || e.key === 'N') {
      setClock(jstNow(), 1, false);
    } else if (e.key === 'c' || e.key === 'C') {
      setCinema(!cinema);
    } else if ((e.key === 'f' || e.key === 'F') && state.selected) {
      document.getElementById('info-follow').click();
    }
  });
  if (params.has('cinema')) setCinema(true);

  document.getElementById('share').addEventListener('click', async () => {
    const url = new URL(location.href);
    url.searchParams.set('t', formatTime(simTime()).slice(0, 5));
    if (state.clock.speed !== 1) url.searchParams.set('speed', String(state.clock.speed));
    else url.searchParams.delete('speed');
    if (sim.dayType !== sim.dayTypeOf(todayYmd)) url.searchParams.set('day', sim.dayType);
    else url.searchParams.delete('day');
    const btn = document.getElementById('share');
    try {
      await navigator.clipboard.writeText(url.toString());
      btn.textContent = 'コピーしました';
    } catch (e) {
      window.prompt('このリンクをコピーしてください', url.toString());
    }
    setTimeout(() => { btn.textContent = 'この景色を共有'; }, 2000);
  });

  // スマートフォンでは最初はパネルを畳んでおく
  if (matchMedia('(max-width: 640px)').matches) document.getElementById('panel').classList.add('collapsed');

  document.getElementById('panel-toggle').addEventListener('click', () => {
    document.getElementById('panel').classList.toggle('collapsed');
  });

  // デバッグ・テスト用
  window.mm3d = { map, sim, state, setClock, simTime };
})();
