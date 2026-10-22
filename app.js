/* Adapted from xenon-xys/TravelMap (MIT). City boundaries and polyline decoder retained. */
'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const DATA = window.TRAVEL_MAP_DATA;
  const PROVINCES = window.TRAVEL_MAP_PROVINCES;
  if (!DATA || !PROVINCES) { $('emptyMap').hidden = false; return; }
  const NS = 'http://www.w3.org/2000/svg';
  const COLOR = { visited: '#479975', empty: '#ffffff', border: '#99afa1', bg: '#f4f7f6' };
  const STORAGE_KEY = 'travelmap_visited_v1';
  const CITY_ZOOM = 2;
  const units = DATA.units;
  const known = new Set(units.map(u => u.code));
  const provinceByName = new Map(PROVINCES.map(p => [p.name, p]));
  let visited = new Set(), current = null, selected = null, undo = null;
  let nationalMode = 'auto', renderedLayer = null;
  let storageBlocked = false, storageError = false, toastTimer;
  let width = 1, height = 1, scale = 1, zoom = 1, tx = 0, ty = 0;
  let viewBounds = [0, 0, DATA.w, DATA.h], initialScale = 1;
  let inset = null;
  const shapeNodes = new Map();
  const labelNodes = [];
  const map = $('map'), main = $('mainMap');

  function svg(tag, attrs = {}) {
    const node = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  }
  function decode(s) {
    const out = []; let i = 0, x = 0, y = 0;
    while (i < s.length) {
      let r = 0, sh = 0, b;
      do { b = s.charCodeAt(i++) - 63; r |= (b & 31) << sh; sh += 5; } while (b >= 32);
      x += (r & 1) ? ~(r >> 1) : r >> 1;
      r = 0; sh = 0;
      do { b = s.charCodeAt(i++) - 63; r |= (b & 31) << sh; sh += 5; } while (b >= 32);
      y += (r & 1) ? ~(r >> 1) : r >> 1;
      out.push(x / 10, y / 10);
    }
    return out;
  }
  function ringPath(ring, closed = true) {
    let path = '';
    for (let k = 0; k < ring.length; k += 2) path += (k ? 'L' : 'M') + ring[k] + ',' + ring[k + 1];
    return path + (closed ? 'Z' : '');
  }
  units.forEach(u => { u.rings = u.p.map(decode); u.path = u.rings.map(r => ringPath(r)).join(''); });
  const count = province => province.ids.reduce((n, i) => n + Number(visited.has(units[i].code)), 0);
  const isVisited = key => known.has(key) ? visited.has(key) : count(provinceByName.get(key)) > 0;
  const cityLayer = () => Boolean(current) || nationalMode === 'city' || (nationalMode === 'auto' && zoom >= CITY_ZOOM);

  function normalizeBackup(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('不是有效的足迹备份');
    if (Array.isArray(obj.visited)) {
      if (obj.schema !== 1 || obj.app !== 'travel-map-simple' || !obj.visited.every(c => typeof c === 'string')) throw new Error('备份格式或版本不支持');
      const codes = obj.visited.filter(c => known.has(c));
      if (obj.visited.length && !codes.length) throw new Error('备份中没有可识别的地区');
      return new Set(codes);
    }
    const states = obj.app === 'travel-map' ? obj.states : obj;
    if (!states || typeof states !== 'object' || Array.isArray(states)) throw new Error('不是有效的原版备份');
    let recognized = 0;
    const codes = new Set();
    for (const [code, state] of Object.entries(states)) {
      if (!known.has(code)) continue;
      recognized++;
      if (!Number.isInteger(state) || state < 0 || state > 5) throw new Error('原版备份中有无效的到访状态');
      if (state < 5) codes.add(code);
    }
    if (!recognized && Object.keys(states).length) throw new Error('备份中没有可识别的地区');
    return codes;
  }
  function setSaveStatus(failed) {
    storageError = failed;
    $('saveStatus').textContent = failed ? '保存不可用，请导出备份' : '已保存到本机浏览器';
    $('saveStatus').classList.toggle('error', failed);
  }
  function record() { return { app: 'travel-map-simple', schema: 1, visited: [...visited].sort() }; }
  function persist() {
    if (storageBlocked) { setSaveStatus(true); return false; }
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(record())); setSaveStatus(false); return true; }
    catch { setSaveStatus(true); return false; }
  }
  function restore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw !== null) { visited = normalizeBackup(JSON.parse(raw)); setSaveStatus(false); return; }
      const legacy = localStorage.getItem('travelmap_states');
      if (legacy) {
        const old = {};
        for (const entry of legacy.split(',')) {
          if (!entry) continue;
          const match = entry.match(/^(\d{6}):([0-5])$/);
          if (!match) throw new Error('旧版记录无法读取');
          old[match[1]] = Number(match[2]);
        }
        visited = normalizeBackup(old);
        persist();
      } else {
        // Probe storage once, so a blocked browser does not claim successful persistence.
        persist();
      }
    } catch {
      storageBlocked = true;
      setSaveStatus(true);
      showToast('本地记录读取失败，已保留原数据；新记录请导出备份。', false, 10000);
    }
  }
  function showToast(message, canUndo = false, duration = 3500) {
    clearTimeout(toastTimer);
    $('toastMessage').textContent = message;
    $('btnUndo').hidden = !canUndo;
    $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, duration);
  }
  function saveAndRender(message, snapshot) {
    undo = snapshot;
    const saved = persist();
    updateColors(); updateStats(); renderList();
    showToast(saved ? message : message + '；自动保存失败，请导出备份。', true, saved ? 4000 : 10000);
  }
  function toggleCity(code) {
    const unit = units.find(u => u.code === code);
    if (!unit) return;
    const before = new Set(visited);
    visited.has(code) ? visited.delete(code) : visited.add(code);
    selected = code;
    $('hoverTip').hidden = true;
    drawSelection();
    saveAndRender(unit.name + (visited.has(code) ? ' · 去过' : ' · 未去过'), before);
  }

  function addShape(key, path, group = $('shapes')) {
    const node = svg('path', { d: path, class: 'region-shape', fill: isVisited(key) ? COLOR.visited : COLOR.empty,
      stroke: COLOR.border, 'stroke-width': 0.85, 'stroke-linejoin': 'round', 'fill-rule': 'evenodd', 'vector-effect': 'non-scaling-stroke', 'data-region': key });
    group.appendChild(node);
    shapeNodes.set(key, node);
    return node;
  }
  function addLabel(text, x, y, kind, key, bounds) {
    const node = svg('text', { x, y, 'text-anchor': 'middle', 'dominant-baseline': 'middle', class: 'map-label ' + kind });
    node.textContent = text;
    $('labels').appendChild(node);
    labelNodes.push({ node, x, y, text, kind, key, bounds });
  }
  function renderMap({ preserveView = false } = {}) {
    if (!preserveView) zoom = 1;
    renderedLayer = cityLayer() ? 'city' : 'province';
    for (const id of ['shapes', 'boundaryLines', 'labels', 'selection', 'southSea', 'smallRegions']) $(id).replaceChildren();
    shapeNodes.clear(); labelNodes.length = 0; inset = null;
    if (!preserveView) selected = null;
    if (!current) {
      viewBounds = [0, 0, DATA.w, DATA.h];
      if (renderedLayer === 'city') {
        units.forEach(u => {
          if (u.f !== 0) return;
          addShape(u.code, u.path);
          addLabel(u.short, u.cx, u.cy, 'city-label', u.code, u.b);
        });
        // Keep province boundaries visible above city blocks.
        PROVINCES.forEach(p => $('boundaryLines').appendChild(svg('path', { d: p.path, fill: 'none', stroke: '#638671',
          'stroke-width': 1.35, 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke', 'pointer-events': 'none' })));
      } else {
        PROVINCES.forEach(p => {
          addShape(p.name, p.path);
          if (!['香港特别行政区', '澳门特别行政区'].includes(p.name)) addLabel(p.short, p.cx, p.cy, 'province-label', p.name, p.b);
        });
      }
      DATA.jd.forEach(encoded => $('boundaryLines').appendChild(svg('path', { d: ringPath(decode(encoded), false), fill: 'none', stroke: '#719b89', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' })));
      buildInset();
    } else {
      const province = provinceByName.get(current);
      viewBounds = province.b;
      province.ids.forEach(i => {
        const u = units[i];
        if (u.f !== 0) return;
        addShape(u.code, u.path);
        addLabel(u.short, u.cx, u.cy, 'city-label', u.code, u.b);
      });
      if (current === '海南省') buildInset();
    }
    $('map').setAttribute('aria-label', current ? current + '城市地图，点击城市切换去过状态，也可使用地区清单操作' : renderedLayer === 'city'
      ? '中国地级市地图，点击城市切换去过状态，也可使用地区清单操作' : '中国省级行政区地图，点击省份进入，也可使用地区清单操作');
    if (preserveView) { updateTransform(); layoutInset(); layoutSmallRegions(); }
    else resetView();
  }
  function buildInset() {
    const root = $('southSea');
    root.appendChild(svg('rect', { width: 100, height: 100, rx: 7, fill: '#fff', stroke: '#c1d0c7' }));
    const inner = svg('g');
    root.appendChild(inner);
    units.filter(u => u.f === 1).forEach(u => {
      const path = svg('path', { d: u.path, fill: visited.has(u.code) ? COLOR.visited : COLOR.empty,
        stroke: COLOR.border, 'stroke-width': .8, 'vector-effect': 'non-scaling-stroke', 'data-city': u.code });
      inner.appendChild(path);
      (u.d || []).forEach(p => inner.appendChild(svg('circle', { cx: p[0], cy: p[1], r: 16, fill: visited.has(u.code) ? COLOR.visited : COLOR.empty, stroke: COLOR.border, 'stroke-width': .6, 'vector-effect': 'non-scaling-stroke', 'data-city': u.code })));
    });
    DATA.jdInset.forEach(s => inner.appendChild(svg('path', { d: ringPath(decode(s), false), fill: 'none', stroke: '#719b89', 'stroke-width': .8, 'vector-effect': 'non-scaling-stroke' })));
    const text = svg('text', { 'text-anchor': 'middle', fill: '#718078', 'font-size': 9 });
    text.textContent = '南海诸岛'; root.appendChild(text);
    inset = { root, inner, text };
  }
  function layoutInset() {
    if (!inset) return;
    const w = Math.min(87, width * .18), h = w * DATA.inH / DATA.inW;
    const x = width - w - 13, y = height - h - 12;
    inset.x = x; inset.y = y; inset.w = w; inset.h = h;
    inset.root.setAttribute('transform', `translate(${x},${y})`);
    const rect = inset.root.firstChild;
    rect.setAttribute('width', w); rect.setAttribute('height', h);
    inset.inner.setAttribute('transform', `scale(${w / DATA.inW})`);
    inset.text.setAttribute('x', w / 2); inset.text.setAttribute('y', h - 4);
  }
  function layoutSmallRegions() {
    $('smallRegions').replaceChildren();
    if (current) return;
    // Keep the geographic polygons unchanged; provide readable targets for tiny regions.
    const x = Math.max(8, width - (width < 500 ? 86 : 104));
    ['香港特别行政区', '澳门特别行政区'].forEach((name, i) => {
      const p = provinceByName.get(name), key = p.name;
      const g = svg('g', { 'data-province-shortcut': name });
      const y = 14 + i * 31;
      g.appendChild(svg('rect', { x, y, width: width < 500 ? 75 : 93, height: 25, rx: 7, fill: isVisited(key) ? COLOR.visited : '#fff', stroke: '#b3c8bb' }));
      const label = svg('text', { x: x + (width < 500 ? 37.5 : 46.5), y: y + 16, 'text-anchor': 'middle', 'font-size': 11, fill: isVisited(key) ? '#fff' : '#385442' });
      label.textContent = p.short + ' ↗'; g.appendChild(label);
      $('smallRegions').appendChild(g);
    });
  }
  function resetView() {
    const b = viewBounds, padding = current ? 32 : 22;
    initialScale = Math.min(Math.max(1, width - padding * 2) / (b[2] - b[0]), Math.max(1, height - padding * 2) / (b[3] - b[1]));
    scale = initialScale; zoom = 1;
    tx = (width - (b[2] + b[0]) * scale) / 2;
    ty = (height - (b[3] + b[1]) * scale) / 2;
    updateTransform(); layoutInset(); layoutSmallRegions();
    updateStats();
  }
  function clampView() {
    const b = viewBounds, padding = 24;
    const contentW = (b[2] - b[0]) * scale, contentH = (b[3] - b[1]) * scale;
    tx = contentW <= width - padding * 2 ? (width - (b[0] + b[2]) * scale) / 2
      : Math.min(padding - b[0] * scale, Math.max(width - padding - b[2] * scale, tx));
    ty = contentH <= height - padding * 2 ? (height - (b[1] + b[3]) * scale) / 2
      : Math.min(padding - b[1] * scale, Math.max(height - padding - b[3] * scale, ty));
  }
  function updateTransform() {
    const expectedLayer = cityLayer() ? 'city' : 'province';
    if (renderedLayer !== expectedLayer) {
      renderMap({ preserveView: true });
      updateStats(); renderList();
      return;
    }
    main.setAttribute('transform', `translate(${tx},${ty}) scale(${scale})`);
    const occupied = [];
    // Screen sized, collision checked labels stay readable when zooming.
    for (const label of labelNodes) {
      const { node, x, y, text, kind, bounds, key } = label;
      const font = kind === 'province-label' ? (width < 500 ? 10 : 12) : 12;
      node.style.fontSize = (font / scale) + 'px';
      node.style.strokeWidth = (2.5 / scale) + 'px';
      const sx = tx + x * scale, sy = ty + y * scale;
      const bw = text.length * font, bh = font + 5;
      const box = [sx - bw / 2, sy - bh / 2, sx + bw / 2, sy + bh / 2];
      const outside = sx < 5 || sy < 5 || sx > width - 5 || sy > height - 5;
      const tooSmall = kind === 'city-label' && Math.min(bounds[2] - bounds[0], bounds[3] - bounds[1]) * scale < 12 && selected !== key;
      const collision = occupied.some(b => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]);
      node.setAttribute('display', outside || tooSmall || collision ? 'none' : '');
      node.setAttribute('fill', isVisited(key) ? '#173e2b' : '#334e40');
      if (!outside && !tooSmall && !collision) occupied.push(box);
    }
    $('btnOut').disabled = zoom <= 1;
    $('btnIn').disabled = zoom >= 24;
    drawSelection();
  }
  function zoomAt(x, y, factor) {
    const next = Math.max(1, Math.min(24, zoom * factor)), k = next / zoom;
    zoom = next; scale = initialScale * zoom;
    tx = x - (x - tx) * k; ty = y - (y - ty) * k;
    clampView(); updateTransform();
    updateStats();
  }
  function drawSelection() {
    $('selection').replaceChildren();
    const u = units.find(u => u.code === selected);
    if (!u || !cityLayer() || u.f !== 0) return;
    $('selection').appendChild(svg('path', { d: u.path, fill: 'none', stroke: '#246747', 'stroke-width': 2,
      'vector-effect': 'non-scaling-stroke', 'stroke-linejoin': 'round' }));
  }
  function updateColors() {
    shapeNodes.forEach((node, key) => node.setAttribute('fill', isVisited(key) ? COLOR.visited : COLOR.empty));
    $('southSea').querySelectorAll('[data-city]').forEach(n => n.setAttribute('fill', visited.has(n.getAttribute('data-city')) ? COLOR.visited : COLOR.empty));
    layoutSmallRegions(); updateTransform();
  }
  function updateStats() {
    const provinces = PROVINCES.filter(p => count(p) > 0).length;
    $('totalStats').textContent = `去过 ${visited.size} 个地区 · ${provinces} / 34 个省级行政区`;
    const cityView = cityLayer();
    const visitedTotal = cityView ? visited.size : provinces;
    const regionTotal = cityView ? units.length : PROVINCES.length;
    $('visitedCount').textContent = visitedTotal;
    $('unvisitedCount').textContent = regionTotal - visitedTotal;
    $('mapLegend').setAttribute('aria-label', cityView ? '城市／地区足迹状态' : '省级行政区足迹状态');
    $('viewTitle').textContent = current || '中国';
    $('btnBack').hidden = !current;
    $('btnPanelBack').hidden = !current && zoom === 1 && nationalMode === 'auto';
    $('layerControl').hidden = Boolean(current);
    document.querySelectorAll('[data-map-layer]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mapLayer === nationalMode)));
    $('viewStats').textContent = current ? `去过 ${count(provinceByName.get(current))} / ${provinceByName.get(current).ids.length} 个地区`
      : cityLayer() ? '地级市区块 · 点击城市标记' : '省级区块 · 点击进入省份';
    $('mapHint').textContent = cityLayer() ? '点城市切换“去过／未去过” · 拖动或双指缩放'
      : nationalMode === 'auto' ? '点省份进入 · 放大至 2 倍自动显示地级市区块' : '点省份进入 · 省级着色表示该省已有足迹';
    $('listTitle').textContent = current ? '地区清单' : cityLayer() ? '地级市清单' : '省级行政区';
    $('listHint').textContent = current ? '点击地图或清单即可标记，再点一次取消。'
      : cityLayer() ? '直接点选城市记录足迹；切换“省级”可进入各省。' : '选择省份进入；清单可向下滚动，或搜索地区。';
  }
  function setPanel(open) {
    $('placesPanel').classList.toggle('open', open);
    $('btnList').setAttribute('aria-expanded', String(open));
  }
  function enterProvince(name) {
    if (!provinceByName.has(name)) return;
    current = name; selected = null;
    $('search').value = ''; $('hoverTip').hidden = true;
    renderMap(); updateStats(); renderList(); setPanel(false);
  }
  function goHome() {
    current = null; nationalMode = 'auto'; selected = null; $('search').value = ''; $('hoverTip').hidden = true;
    renderMap(); updateStats(); renderList(); setPanel(false);
  }
  function makeRow(name, detail, on, action, province = false, code = null) {
    const row = document.createElement('button');
    row.type = 'button'; row.className = 'place-row' + (on ? ' is-visited' : '') + (province ? ' province-row' : '');
    if (code) { row.dataset.city = code; row.setAttribute('aria-pressed', String(on)); row.setAttribute('aria-label', name + '，' + (on ? '去过，点击取消' : '未去过，点击标记')); }
    else { row.dataset.province = name; row.setAttribute('aria-label', '进入' + name); }
    const symbol = document.createElement('span'); symbol.className = 'place-symbol'; symbol.textContent = province ? '↗' : '✓'; symbol.setAttribute('aria-hidden', 'true');
    const title = document.createElement('span'); title.className = 'place-name'; title.textContent = name;
    const stat = document.createElement('span'); stat.className = 'place-count'; stat.textContent = detail;
    row.append(symbol, title, stat); row.addEventListener('click', action);
    return row;
  }
  function renderList() {
    const query = $('search').value.trim().toLocaleLowerCase();
    const list = $('placesList');
    const scrollTop = list.scrollTop, activeCity = document.activeElement?.dataset.city;
    list.replaceChildren();
    let shown = 0;
    if (cityLayer()) {
      const candidates = current ? provinceByName.get(current).ids.map(i => units[i]) : units;
      candidates.forEach(u => {
        if (query && !u.name.toLocaleLowerCase().includes(query) && (current || !u.prov.toLocaleLowerCase().includes(query))) return;
        shown++; list.appendChild(makeRow(u.name, visited.has(u.code) ? '去过' : '未去过', visited.has(u.code), () => toggleCity(u.code), false, u.code));
      });
    } else {
      PROVINCES.forEach(p => {
        if (query && !p.name.toLocaleLowerCase().includes(query)) return;
        shown++; list.appendChild(makeRow(p.name, `${count(p)} / ${p.ids.length}`, count(p) > 0, () => enterProvince(p.name), true));
      });
      if (query) units.forEach(u => {
        if (!u.name.toLocaleLowerCase().includes(query)) return;
        shown++; list.appendChild(makeRow(u.name, u.prov, visited.has(u.code), () => { enterProvince(u.prov); selected = u.code; drawSelection(); }, false, u.code));
      });
    }
    if (!shown) { const empty = document.createElement('p'); empty.className = 'empty-results'; empty.textContent = '没有找到匹配的地区'; list.appendChild(empty); }
    $('listCount').textContent = current ? `共 ${provinceByName.get(current).ids.length} 个地区` : cityLayer() ? `共 ${units.length} 个地区` : '共 34 个省级行政区';
    list.scrollTop = scrollTop;
    if (activeCity) list.querySelector(`[data-city="${activeCity}"]`)?.focus({ preventScroll: true });
  }

  function inRing(x, y, r) {
    let inside = false;
    for (let i = 0, j = r.length / 2 - 1; i < r.length / 2; j = i++) {
      const xi = r[i * 2], yi = r[i * 2 + 1], xj = r[j * 2], yj = r[j * 2 + 1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function hitTest(x, y) {
    if (inset && x >= inset.x && x <= inset.x + inset.w && y >= inset.y && y <= inset.y + inset.h) return units.find(u => u.f === 1);
    const mx = (x - tx) / scale, my = (y - ty) / scale;
    const candidates = current ? provinceByName.get(current).ids.map(i => units[i]) : units;
    // Exact polygon hit takes precedence; small-region tolerance is only a fallback.
    for (let i = candidates.length - 1; i >= 0; i--) {
      const u = candidates[i]; if (u.f || mx < u.b[0] || mx > u.b[2] || my < u.b[1] || my > u.b[3]) continue;
      if (u.rings.some(r => inRing(mx, my, r))) return u;
    }
    let closest = null, distance = 9;
    for (const u of candidates) {
      if (u.f || Math.min(u.b[2] - u.b[0], u.b[3] - u.b[1]) * scale > 12) continue;
      const d = Math.hypot(tx + u.cx * scale - x, ty + u.cy * scale - y);
      if (d < distance) { closest = u; distance = d; }
    }
    return closest;
  }
  const pointers = new Map();
  let gestureMoved = false, movement = 0, last = null, lastPinch = null;
  map.addEventListener('pointerdown', e => {
    if (e.button && e.pointerType === 'mouse') return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) { gestureMoved = false; movement = 0; last = { x: e.clientX, y: e.clientY }; }
    if (pointers.size > 1) { gestureMoved = true; const [a,b] = [...pointers.values()]; lastPinch = Math.hypot(a.x-b.x,a.y-b.y); }
    map.setPointerCapture(e.pointerId); map.classList.add('dragging');
  });
  map.addEventListener('pointermove', e => {
    const rect = map.getBoundingClientRect(), x = e.clientX - rect.left, y = e.clientY - rect.top;
    if (!pointers.has(e.pointerId)) {
      if (e.pointerType === 'touch') return;
      const hit = hitTest(x, y);
      $('hoverTip').hidden = !hit;
      if (hit) $('hoverTip').textContent = cityLayer() ? hit.name + ' · ' + (visited.has(hit.code) ? '去过，点击取消' : '未去过，点击标记') : hit.prov + ' · 点击进入';
      return;
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a,b] = [...pointers.values()], dist = Math.hypot(a.x-b.x,a.y-b.y);
      if (lastPinch) zoomAt((a.x+b.x)/2-rect.left,(a.y+b.y)/2-rect.top,dist/lastPinch);
      lastPinch = dist; gestureMoved = true; return;
    }
    if (last) {
      const dx = e.clientX-last.x, dy = e.clientY-last.y;
      movement += Math.abs(dx) + Math.abs(dy);
      if (movement > 5 || gestureMoved) {
        gestureMoved = true; tx += dx; ty += dy; clampView(); updateTransform();
      }
      last = { x:e.clientX,y:e.clientY };
    }
  });
  function endPointer(e, canceled = false) {
    const tap = !canceled && !gestureMoved && pointers.size === 1;
    pointers.delete(e.pointerId); lastPinch = null;
    if (!pointers.size) { last = null; map.classList.remove('dragging'); }
    else { last = [...pointers.values()][0]; gestureMoved = true; }
    if (!tap) return;
    const rect = map.getBoundingClientRect(), x = e.clientX-rect.left, y = e.clientY-rect.top;
    const shortcut = document.elementFromPoint(e.clientX,e.clientY)?.closest('[data-province-shortcut]');
    if (shortcut) { enterProvince(shortcut.getAttribute('data-province-shortcut')); return; }
    const hit = hitTest(x,y);
    if (hit) cityLayer() ? toggleCity(hit.code) : enterProvince(hit.prov);
  }
  map.addEventListener('pointerup', e => endPointer(e));
  map.addEventListener('pointercancel', e => endPointer(e,true));
  map.addEventListener('pointerleave', () => { $('hoverTip').hidden = true; });
  map.addEventListener('wheel', e => { e.preventDefault(); const r=map.getBoundingClientRect(); zoomAt(e.clientX-r.left,e.clientY-r.top,e.deltaY<0?1.15:1/1.15); }, { passive:false });

  function download(blob, name) {
    const url=URL.createObjectURL(blob), a=document.createElement('a');
    a.href=url; a.download=name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),10000);
  }
  let posterContext=null, posterPreviewURL=null, posterBusy=false;
  function posterStatus(message,failed=false) {
    $('posterExportStatus').textContent=message;
    $('posterExportStatus').classList.toggle('error',failed);
  }
  function releasePosterPreview() {
    $('posterPreview').removeAttribute('src');
    if(posterPreviewURL)URL.revokeObjectURL(posterPreviewURL);
    posterPreviewURL=null;
  }
  function updatePosterPreview() {
    if(!posterContext)return;
    posterContext.showLabels=$('posterLabels').checked;
    const result=FootprintPoster.build(posterContext);
    releasePosterPreview();
    posterPreviewURL=URL.createObjectURL(new Blob([result.svg],{type:'image/svg+xml;charset=utf-8'}));
    $('posterPreview').src=posterPreviewURL;
    $('posterPreview').alt=result.description;
    $('posterScope').textContent=result.scope;
    $('posterSummary').textContent=`${result.stats.provinces} 个省级行政区\n${result.stats.cities} 个城市 / 地区`;
  }
  function updatePosterFormat() {
    const format=FootprintPoster.FORMATS[$('posterFormat').value];
    posterStatus(format?`导出 ${format.width} × ${format.height} 像素 PNG，清晰度不受窗口大小影响。`:'导出 SVG 矢量图，可继续放大或用于印刷排版。');
  }
  function openPosterDialog() {
    if(posterBusy)return;
    try {
      // Snapshot records and the displayed administrative level; never move the live map.
      posterContext={data:DATA,provinces:PROVINCES,visited:[...visited],provinceName:current,layer:cityLayer()?'city':'province',showLabels:$('posterLabels').checked};
      updatePosterPreview();updatePosterFormat();$('posterDialog').showModal();
    } catch(error) {showToast(error.message||'成就图片预览失败，请重试');}
  }
  async function exportImage() {
    if(!posterContext||posterBusy)return;
    posterBusy=true;
    $('btnDownloadPoster').disabled=$('btnImage').disabled=$('posterFormat').disabled=$('posterLabels').disabled=true;
    $('btnDownloadPoster').textContent='正在生成…';
    let canvas=null,image=null,imageURL=null;
    try {
      const key=$('posterFormat').value, format=FootprintPoster.FORMATS[key];
      const result=FootprintPoster.build({...posterContext,...(format?{pixelWidth:format.width,pixelHeight:format.height}:{})});
      const name=`足迹成就-${posterContext.provinceName||'中国'}-${posterContext.layer==='city'?'市级':'省级'}`;
      if(key==='svg') {
        download(new Blob([result.svg],{type:'image/svg+xml;charset=utf-8'}),name+'.svg');
      } else {
        if(!format)throw new Error('请选择导出画质');
        posterStatus(`正在生成 ${format.width} × ${format.height} PNG，请稍候…`);
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        await document.fonts.ready;
        image=new Image();
        imageURL=URL.createObjectURL(new Blob([result.svg],{type:'image/svg+xml;charset=utf-8'}));
        await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(new Error('地图图片生成失败'));image.src=imageURL;});
        canvas=document.createElement('canvas');canvas.width=format.width;canvas.height=format.height;
        const ctx=canvas.getContext('2d');
        if(!ctx)throw new Error('浏览器无法创建大尺寸图片');
        ctx.drawImage(image,0,0,format.width,format.height);
        const png=await new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('浏览器无法编码大尺寸图片')),'image/png'));
        download(png,`${name}-${format.width}x${format.height}.png`);
      }
      posterStatus('已生成并开始下载。');showToast('成就图片已导出');
    } catch(error) {
      posterStatus(`${error.message||'图片导出失败'}。请重试，或选择高清 PNG / SVG 矢量图。`,true);
    } finally {
      if(canvas){canvas.width=0;canvas.height=0;}
      if(image){image.onload=image.onerror=null;image.src='';}
      if(imageURL)URL.revokeObjectURL(imageURL);
      posterBusy=false;
      $('btnDownloadPoster').disabled=$('btnImage').disabled=$('posterFormat').disabled=$('posterLabels').disabled=false;
      $('btnDownloadPoster').textContent='下载成就图片';
    }
  }
  $('posterLabels').onchange=updatePosterPreview;
  $('posterFormat').onchange=updatePosterFormat;
  $('btnDownloadPoster').onclick=exportImage;
  $('posterDialog').addEventListener('close',releasePosterPreview);
  $('btnBack').onclick=goHome;
  $('btnPanelBack').onclick=goHome;
  document.querySelectorAll('[data-map-layer]').forEach(button => button.addEventListener('click', () => {
    nationalMode = button.dataset.mapLayer;
    $('hoverTip').hidden = true;
    renderMap({ preserveView: true }); updateStats(); renderList();
  }));
  $('btnIn').onclick=()=>zoomAt(width/2,height/2,1.4);
  $('btnOut').onclick=()=>zoomAt(width/2,height/2,1/1.4);
  $('btnFit').onclick=resetView;
  $('search').addEventListener('input',renderList);
  $('btnList').onclick=()=>setPanel(!$('placesPanel').classList.contains('open'));
  $('btnCloseList').onclick=()=>setPanel(false);
  $('btnData').onclick=()=>$('dataDialog').showModal();
  document.querySelectorAll('[data-close]').forEach(b=>{b.onclick=()=>$(b.dataset.close).close();});
  $('btnClear').onclick=()=>$('clearDialog').showModal();
  $('btnConfirmClear').onclick=()=>{const before=new Set(visited);visited.clear();$('clearDialog').close();saveAndRender('已清空全部足迹',before);};
  $('btnUndo').onclick=()=>{if(!undo)return;visited=new Set(undo);undo=null;persist();updateColors();updateStats();renderList();showToast(storageError?'已撤销；保存失败，请导出备份。':'已撤销');};
  $('btnExport').onclick=()=>{
    const now=new Date();
    const date=[now.getFullYear(),String(now.getMonth()+1).padStart(2,'0'),String(now.getDate()).padStart(2,'0')].join('-');
    download(new Blob([JSON.stringify({...record(),exportedAt:now.toISOString()},null,2)],{type:'application/json'}),`足迹地图-备份${date}.json`);
    showToast('备份已导出');
  };
  $('btnImport').onclick=()=>$('importFile').click();
  $('importFile').onchange=async e=>{
    const file=e.target.files[0];e.target.value='';if(!file)return;
    try {
      if(file.size>2*1024*1024)throw new Error('备份文件过大，请选择足迹 JSON 文件');
      const incoming=normalizeBackup(JSON.parse(await file.text()));
      const before=new Set(visited);incoming.forEach(c=>visited.add(c));
      $('dataDialog').close();saveAndRender(`已合并备份，新增 ${visited.size-before.size} 个地区`,before);
    } catch(error){showToast('导入失败：'+(error instanceof SyntaxError?'JSON 格式错误':error.message),false,6000);}
  };
  $('btnImage').onclick=openPosterDialog;
  window.addEventListener('storage',e=>{
    if(e.key!==STORAGE_KEY)return;
    try {visited=e.newValue?normalizeBackup(JSON.parse(e.newValue)):new Set();undo=null;storageBlocked=false;setSaveStatus(false);updateColors();updateStats();renderList();showToast('已同步本浏览器其他标签页的足迹');}
    catch {setSaveStatus(true);showToast('其他标签页的记录格式异常，请先备份。');}
  });
  document.addEventListener('keydown',e=>{if(e.key==='Escape')setPanel(false);});
  new ResizeObserver(()=>{
    const rect=$('mapArea').getBoundingClientRect();if(rect.width<20||rect.height<20)return;
    width=Math.round(rect.width);height=Math.round(rect.height);map.setAttribute('viewBox',`0 0 ${width} ${height}`);resetView();
  }).observe($('mapArea'));
  restore();renderMap();updateStats();renderList();
})();
