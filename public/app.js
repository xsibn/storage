(function(){
  "use strict";

  const API_BASE = ""; // same-origin: server serves both the API and this page

  const state = {
    records: [],   // {id, cell, article, name, qty, mfg, exp, isService, row, rack, level}
    sourceLabel: "подключение…",
    lastSync: null,
    layout: {},    // {row: {minRack, maxRack, levels}} — full known warehouse structure
    abcClasses: {}, // {article: 'A'|'B'|'C'} — fixed classification, not computed
    zones: []      // [{name, isolate, records, qty, articles}] — authoritative zone list from server
  };

  const CELL_RE = /^(\d{2})-(\d{2})-([A-Za-zА-Яа-я0-9]+)$/;
  const LEVEL_ORDER = ["01","02","03","04","05","06","07","08","A1","B1"];

  function classify(cellRaw){
    const m = cellRaw.match(CELL_RE);
    if(m){
      return {isService:false, row:m[1], rack:parseInt(m[2],10), level:m[3]};
    }
    return {isService:true, row:null, rack:null, level:null};
  }

  // Extract per-unit volume/weight (litres or kg) from the product name.
  // Pattern 1: number at the very start of the name, e.g. "0.33Х12 ЖБ ..." or "10.0 БИБ ...".
  // Pattern 2 (fallback): number immediately followed by Л or КГ anywhere in the name,
  // e.g. "БАЛЛОН ДЛЯ СО2 20 Л", "CO2 12 КГ В 20 Л БАЛЛОНЕ".
  // Returns null when no reliable volume can be found (treated as lightest / last in pick order).
  function parseVolume(name){
    if(!name) return null;
    const startMatch = name.match(/^\s*(\d+[.,]\d+|\d+)/);
    if(startMatch) return parseFloat(startMatch[1].replace(',','.'));
    const unitMatch = name.match(/(\d+[.,]\d+|\d+)\s*(Л|л|КГ|кг)\b/);
    if(unitMatch) return parseFloat(unitMatch[1].replace(',','.'));
    return null;
  }

  // Classify a product into a broad merchandise category from its name, so that
  // items of the same kind (juices, water, soda, etc.) are grouped together on the map.
  const CATEGORY_COLORS = {
    'Кофе': '#8B5E34',
    'Вода': '#2C5CE0',
    'Энергетики': '#DB2777',
    'Чай холодный': '#65A30D',
    'Тоники и миксеры': '#0D9488',
    'Газировка (Кола)': '#7C3AED',
    'Одноразовая посуда': '#64748B',
    'Газ CO2 / баллоны': '#334155',
    'Соки и нектары': '#16A34A'
  };
  // Classify a product into its packaging MATERIAL, parsed from the standard
  // code that follows the volume/weight at the start of the name (e.g.
  // "0.5Х12 ПЭТ ...", "0.33Х12 ЖБ ...", "1Х12 ТП ..."). This is the primary
  // grouping used for picking adjacency: same material must stand together
  // (PET with PET, tin with tin, etc.) — see MATERIAL_COLORS below.
  const MATERIAL_COLORS = {
    'ПЭТ': '#2C5CE0',
    'Жесть': '#94A3B8',
    'Стекло': '#16A34A',
    'Тетрапак': '#DB2777',
    'Картон': '#B45309',
    'Bag-in-Box': '#7C3AED',
    'Весовой (без тары)': '#334155',
    'Прочее': '#64748B'
  };
  function classifyMaterial(name){
    if(!name) return 'Прочее';
    const n = name.toUpperCase();
    // weight-based goods (coffee sold by kg, no container material): "0.2 КГ ..."
    if(/^\s*[\d.,]+\s*КГ\b/.test(n)) return 'Весовой (без тары)';
    const has = (...codes)=> codes.some(c=> new RegExp('(^|[^А-Я])'+c+'([^А-Я]|$)').test(n));
    if(has('ПЭТ','ПЕТ')) return 'ПЭТ';
    if(has('ЖБ')) return 'Жесть';
    if(has('СТН')) return 'Стекло';
    if(has('ТП')) return 'Тетрапак';
    if(has('ГМ','КМБ')) return 'Картон';
    if(has('БИБ')) return 'Bag-in-Box';
    return 'Прочее';
  }

  function classifyCategory(name){
    if(!name) return 'Соки и нектары';
    const n = name.toUpperCase();
    const has = (...keys)=> keys.some(k=>n.includes(k));
    if(has('КОФЕ','ЭСПРЕССО','КАПУЧИНО','ЛАТТЕ','АМЕРИКАНО','КАПСУЛ','ЗЕРНО','ВЕРНЬЯНО','САНТА РИЧИ','МОЛОТЫЙ')) return 'Кофе';
    if(has('АКВА')) return 'Вода';
    if(has('БЕРН')) return 'Энергетики';
    if(has('ЧАЙ')) return 'Чай холодный';
    if(has('ТОНИК','БИТТЕР','СПРИТЦ','АПЕРИТИВ')) return 'Тоники и миксеры';
    if(has('КОЛА')) return 'Газировка (Кола)';
    if(has('СТАКАН','КРЫШКА','СОЛОМКА')) return 'Одноразовая посуда';
    if(has('БАЛЛОН','CO2','СО2')) return 'Газ CO2 / баллоны';
    return 'Соки и нектары';
  }

  // Map a DB row (from /api/records) into the shape the rest of the app expects.
  function fromServerRow(r){
    return {
      id: r.id,
      cell: r.cell,
      article: r.article,
      name: r.name || '',
      qty: Number(r.qty) || 0,
      mfg: r.mfg || '',
      exp: r.exp || '',
      te: r.te || '',
      isService: !!r.is_service,
      row: r.row_code, rack: r.rack, level: r.level_code
    };
  }

  function setSyncStatus(text, isError){
    const el = document.getElementById('sync-status');
    if(el){ el.textContent = text; el.style.color = isError ? 'var(--danger)' : 'var(--ink-soft)'; }
  }

  // ---------- PROGRESS BAR ----------
  // Two modes: indeterminate (quick JSON calls — we don't know real duration,
  // just show something is happening) and determinate (file upload/download,
  // where we can track real bytes transferred).
  let progressDepth = 0; // supports nested/overlapping async calls
  function progressStart(label){
    progressDepth++;
    const bar = document.getElementById('progress-bar');
    bar.classList.add('active','indeterminate');
    bar.style.width = '';
    if(label){
      const lbl = document.getElementById('progress-label');
      lbl.textContent = label;
      lbl.classList.add('active');
    }
  }
  function progressSet(pct, label){
    const bar = document.getElementById('progress-bar');
    bar.classList.remove('indeterminate');
    bar.classList.add('active');
    bar.style.width = Math.max(2, Math.min(100, pct)) + '%';
    if(label){
      const lbl = document.getElementById('progress-label');
      lbl.textContent = label;
      lbl.classList.add('active');
    }
  }
  function progressEnd(){
    progressDepth = Math.max(0, progressDepth-1);
    if(progressDepth>0) return; // another operation still running, keep the bar up
    const bar = document.getElementById('progress-bar');
    bar.classList.remove('indeterminate');
    bar.style.width = '100%';
    setTimeout(()=>{
      bar.classList.remove('active');
      bar.style.width = '0%';
      document.getElementById('progress-label').classList.remove('active');
    }, 300);
  }
  // Wrap any async operation with the indeterminate bar — used for the many
  // quick JSON calls (save a field, delete a row, swap rows/racks, rename...).
  async function withProgress(label, taskFn){
    progressStart(label);
    try{
      return await taskFn();
    } finally {
      progressEnd();
    }
  }

  async function fetchRecords(){
    const res = await fetch(API_BASE + '/api/records');
    if(!res.ok) throw new Error('Сервер вернул ошибку ' + res.status);
    const data = await res.json();
    state.records = data.records.map(fromServerRow);
    state.sourceLabel = data.meta.source || 'база данных';
    state.layout = data.meta.layout || {};
    state.abcClasses = data.meta.abcClasses || {};
    state.zones = data.meta.zones || [];
    state.lastSync = new Date();
  }

  async function syncFromServer(showAlert){
    try{
      setSyncStatus('синхронизация…');
      await withProgress('Синхронизация…', fetchRecords);
      renderAll();
      setSyncStatus('обновлено ' + state.lastSync.toLocaleTimeString('ru-RU'));
    }catch(err){
      setSyncStatus('нет связи с сервером', true);
      if(showAlert) alert('Не удалось получить данные с сервера: ' + err.message);
    }
  }

  // ---------- helpers ----------
  function fmtNum(n){ return n.toLocaleString('ru-RU'); }

  function addressRecords(){ return state.records.filter(r=>!r.isService); }

  // Select the row holding these records on the currently-rendered scheme,
  // scroll to the cell(s) and pulse-highlight them so they're easy to spot.
  // Shared by the global search ("Показать на схеме"), the in-map search box
  // and the barcode scanner — all three should land the user in exactly the
  // same place with the same accent, no matter how the article was entered.
  function pulseAddressesOnMap(records){
    if(!records.length) return false;
    records = records.slice().sort((a,b)=> a.row===b.row ? (a.rack===b.rack ? String(a.level).localeCompare(String(b.level)) : a.rack-b.rack) : a.row.localeCompare(b.row));
    const target = records[0];
    const targetAddresses = new Set(records.map(r=>`${r.row}-${zpad(r.rack)}-${r.level}`));

    currentAisle = target.row;
    renderAisleChips();
    renderGrid();

    requestAnimationFrame(()=>{
      const cells = Array.from(document.querySelectorAll('#rack-grid .cell[data-address]'))
        .filter(el=> targetAddresses.has(el.dataset.address));
      cells.forEach(el=> el.classList.add('just-found'));
      if(cells[0]) cells[0].scrollIntoView({behavior:'smooth', block:'center', inline:'center'});
      setTimeout(()=> cells.forEach(el=> el.classList.remove('just-found')), 3200);
    });
    return true;
  }

  // Match a typed/scanned code against address cells only (schema search), same
  // priority as findRecordsByCode below: exact article/cell/ТЕ first, then a
  // case-insensitive exact match, then a loose "contains" fallback.
  function findAddressMatches(term){
    const c = String(term || '').trim();
    if(!c) return [];
    const lc = c.toLowerCase();
    let matches = addressRecords().filter(r => r.article === c || r.cell === c || (r.te && r.te === c));
    if(!matches.length){
      matches = addressRecords().filter(r =>
        r.article.toLowerCase() === lc || r.cell.toLowerCase() === lc || (r.te && r.te.toLowerCase() === lc)
      );
    }
    if(!matches.length){
      matches = addressRecords().filter(r =>
        r.article.toLowerCase().includes(lc) || r.cell.toLowerCase().includes(lc) ||
        r.name.toLowerCase().includes(lc) || (r.te && r.te.toLowerCase().includes(lc))
      );
    }
    return matches;
  }

  // Called from the map's own search box (typing an exact code, or pressing
  // Enter) and from the barcode scanner when it's opened from the map view —
  // jumps straight to the right row and pulses the matching cell(s).
  function jumpOnMap(term){
    return pulseAddressesOnMap(findAddressMatches(term));
  }

  function serviceRecords(){ return state.records.filter(r=>r.isService); }

  function aisleList(){
    const fromLayout = Object.keys(state.layout || {});
    if(fromLayout.length) return fromLayout.sort();
    // fallback for a server that hasn't returned a layout yet
    const rows = new Set();
    addressRecords().forEach(r=>rows.add(r.row));
    return Array.from(rows).sort();
  }

  // Full known extent of a row (racks + levels), independent of what's occupied
  // right now — this is what keeps a rack from "disappearing" once it's empty.
  // `racks` is an explicit, user-orderable list (not necessarily ascending).
  function aisleExtent(row){
    const L = state.layout && state.layout[row];
    if(L) return { racks: L.racks.slice(), levels: L.levels.slice() };
    // fallback: derive from whatever is currently occupied
    const rows = addressRecords().filter(r=>r.row===row);
    if(!rows.length) return null;
    const racks = Array.from(new Set(rows.map(r=>r.rack))).sort((a,b)=>a-b);
    const levels = Array.from(new Set(rows.map(r=>r.level)));
    return { racks, levels };
  }

  // ---------- header stats ----------
  function renderStats(){
    const addr = addressRecords(), svc = serviceRecords();
    const totalQty = state.records.reduce((s,r)=>s+r.qty,0);
    const uniqArticles = new Set(state.records.map(r=>r.article)).size;
    const uniqCells = new Set(addr.map(r=>r.cell)).size;
    document.getElementById('stats').innerHTML = `
      <div class="stat"><span class="num">${fmtNum(totalQty)}</span><span class="lbl">шт всего</span></div>
      <div class="stat"><span class="num">${fmtNum(uniqArticles)}</span><span class="lbl">артикулов</span></div>
      <div class="stat"><span class="num">${fmtNum(uniqCells)}</span><span class="lbl">ячеек занято</span></div>
      <div class="stat"><span class="num">${fmtNum(svc.length)}</span><span class="lbl">строк в служ. зонах</span></div>
    `;
    document.getElementById('src-tag').textContent = state.sourceLabel;
  }

  // ---------- MAP VIEW ----------
  let currentAisle = null;
  let mapFilterTerm = "";
  let dragSourceAisle = null;

  // Tap-to-select mode: native HTML5 drag-and-drop doesn't work on touch
  // screens, so this gives phones a two-tap alternative (select, then tap the
  // target) for the same three actions: move a cell, swap two rows, swap two
  // racks. Off by default so desktop click behaviour (open drawer, switch
  // aisle) stays unchanged.
  let moveMode = false;
  let tapSourceAddress = null;
  let tapSourceAisleSel = null;
  let tapSourceRackSel = null;

  // Row multi-select mode: pick several row chips, then delete them all at
  // once instead of opening the row manager one row at a time.
  let rowSelectMode = false;
  let rowSelection = new Set();

  function setRowSelectMode(on){
    rowSelectMode = on;
    rowSelection.clear();
    document.getElementById('row-select-mode-btn').classList.toggle('active', rowSelectMode);
    document.getElementById('row-select-mode-btn').textContent = rowSelectMode ? '✕ Отменить выбор' : '☑ Выбрать ряды';
    updateDeleteSelectedBtn();
    // Row multi-select and tap-move-mode are two different tap interpretations
    // of the same chip click — keep only one active at a time.
    if(rowSelectMode && moveMode) setMoveMode(false); else renderAisleChips();
  }

  function updateDeleteSelectedBtn(){
    const btn = document.getElementById('delete-selected-rows-btn');
    document.getElementById('delete-selected-count').textContent = rowSelection.size;
    btn.style.display = (rowSelectMode && rowSelection.size>0) ? '' : 'none';
  }

  async function deleteSelectedRows(){
    const rows = Array.from(rowSelection).sort();
    if(!rows.length) return;
    if(!confirm(`Удалить выбранные ряды (${rows.join(', ')})? Это возможно только для рядов без товара. Действие необратимо.`)) return;
    progressStart('Удаление рядов…');
    const failed = [];
    for(const row of rows){
      try{
        const res = await fetch(`${API_BASE}/api/layout/${row}`, { method:'DELETE' });
        const payload = await res.json().catch(()=>({}));
        if(!res.ok) throw new Error(payload.error || ('HTTP '+res.status));
      }catch(err){
        failed.push(`${row} (${err.message})`);
      }
    }
    progressEnd();
    setRowSelectMode(false);
    currentAisle = null;
    await fetchRecords();
    renderAll();
    if(failed.length){
      alert('Не удалось удалить ряд(ы): ' + failed.join(', '));
      setSyncStatus('часть рядов не удалена', true);
    }else{
      setSyncStatus(`удалено рядов: ${rows.length} · ` + new Date().toLocaleTimeString('ru-RU'));
    }
  }


  function setMoveMode(on){
    moveMode = on;
    tapSourceAddress = null; tapSourceAisleSel = null; tapSourceRackSel = null;
    document.getElementById('move-mode-btn').classList.toggle('active', moveMode);
    if(moveMode && rowSelectMode) setRowSelectMode(false);
    renderAisleChips();
    renderGrid();
  }

  function renderAisleChips(){
    const aisles = aisleList();
    if(!currentAisle || !aisles.includes(currentAisle)) currentAisle = aisles[0];
    const box = document.getElementById('aisle-chips');
    // Пока в поиске по схеме что-то введено — считаем, сколько ячеек каждого
    // ряда совпадает с запросом, и показываем это счётчиком рядом с рядом,
    // чтобы было видно, в каких рядах ещё встречается артикул.
    const term = mapFilterTerm.trim().toLowerCase();
    let matchesByRow = null;
    if(term){
      matchesByRow = {};
      findAddressMatches(term).forEach(r=>{
        (matchesByRow[r.row] = matchesByRow[r.row] || new Set()).add(r.cell);
      });
    }
    box.innerHTML = aisles.map(a=>{
      const n = addressRecords().filter(r=>r.row===a);
      const cells = new Set(n.map(r=>r.cell)).size;
      const sel = moveMode && a===tapSourceAisleSel ? 'tap-selected' : '';
      const delSel = rowSelectMode && rowSelection.has(a) ? 'del-selected' : '';
      const matchCount = matchesByRow && matchesByRow[a] ? matchesByRow[a].size : 0;
      const matchCls = matchCount ? 'has-match' : '';
      const badge = matchCount ? `<span class="match-badge" title="Совпадений с поиском: ${matchCount}">${matchCount}</span>` : '';
      return `<button class="aisle-chip ${a===currentAisle?'active':''} ${sel} ${delSel} ${matchCls}" draggable="${rowSelectMode?'false':'true'}" data-aisle="${a}" title="Перетащите на другой ряд, чтобы поменять их местами целиком">Ряд ${a}<span class="n">· ${cells}</span>${badge}</button>`;
    }).join('');
    box.querySelectorAll('.aisle-chip').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        if(rowSelectMode){
          const a = btn.dataset.aisle;
          if(rowSelection.has(a)) rowSelection.delete(a); else rowSelection.add(a);
          renderAisleChips();
          updateDeleteSelectedBtn();
          return;
        }
        if(moveMode){
          const a = btn.dataset.aisle;
          if(tapSourceAisleSel===null){ tapSourceAisleSel = a; renderAisleChips(); }
          else if(tapSourceAisleSel===a){ tapSourceAisleSel = null; renderAisleChips(); }
          else { const src = tapSourceAisleSel; tapSourceAisleSel = null; await swapAisles(src, a); }
          return;
        }
        const aisle = btn.dataset.aisle;
        const term = mapFilterTerm.trim();
        if(term){
          // Если в поиске что-то введено — переходим не просто на ряд, а сразу
          // к совпавшим в нём ячейкам (та же подсветка, что и при переходе из
          // общего поиска или сканера).
          const matches = findAddressMatches(term).filter(r => r.row === aisle);
          if(matches.length){ pulseAddressesOnMap(matches); return; }
        }
        currentAisle = aisle; renderAisleChips(); renderGrid();
      });

      btn.addEventListener('dragstart', (e)=>{
        dragSourceAisle = btn.dataset.aisle;
        btn.classList.add('drag-source');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', dragSourceAisle);
      });
      btn.addEventListener('dragend', ()=>{
        btn.classList.remove('drag-source');
        dragSourceAisle = null;
      });
      btn.addEventListener('dragover', (e)=>{
        if(!dragSourceAisle || dragSourceAisle===btn.dataset.aisle) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        btn.classList.add('drag-over');
      });
      btn.addEventListener('dragleave', ()=>{
        btn.classList.remove('drag-over');
      });
      btn.addEventListener('drop', async (e)=>{
        e.preventDefault();
        btn.classList.remove('drag-over');
        const source = dragSourceAisle;
        const target = btn.dataset.aisle;
        dragSourceAisle = null;
        if(!source || source===target) return;
        await swapAisles(source, target);
      });
    });
  }

  async function swapAisles(rowA, rowB){
    if(!confirm(`Поменять местами весь товар ряда ${rowA} и ряда ${rowB}? Это затронет все ячейки обоих рядов и сохранится сразу для всех.`)) return;
    setSyncStatus('обмен рядами…');
    progressStart(`Обмен рядами ${rowA} ⇄ ${rowB}…`);
    try{
      const res = await fetch(`${API_BASE}/api/records/swap-rows`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ rowA, rowB })
      });
      const payload = await res.json().catch(()=>({}));
      if(!res.ok) throw new Error(payload.error || ('HTTP '+res.status));
      currentAisle = rowB; // follow the row we dragged to where it now lives
      await fetchRecords();
      renderAll();
      setSyncStatus(`ряды ${rowA} и ${rowB} обменяны (${fmtNum(payload.movedA)} / ${fmtNum(payload.movedB)} записей) · ` + new Date().toLocaleTimeString('ru-RU'));
    }catch(err){
      setSyncStatus('ошибка обмена рядами', true);
      alert('Не удалось поменять ряды местами: ' + err.message);
      await fetchRecords(); renderAll();
    } finally {
      progressEnd();
    }
  }

  let dragSourceAddress = null;
  let dragSourceRack = null;

  async function swapRacks(row, rackA, rackB){
    if(!confirm(`Поменять местами стеллаж ${rackA} и стеллаж ${rackB} в ряду ${row}? Затронет все ярусы обоих стеллажей.`)) return;
    setSyncStatus('обмен стеллажами…');
    progressStart(`Обмен стеллажами ${rackA} ⇄ ${rackB}…`);
    try{
      const res = await fetch(`${API_BASE}/api/records/swap-racks`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ row, rackA, rackB })
      });
      const payload = await res.json().catch(()=>({}));
      if(!res.ok) throw new Error(payload.error || ('HTTP '+res.status));
      await fetchRecords();
      renderAll();
      setSyncStatus(`стеллажи ${rackA} и ${rackB} обменяны (${fmtNum(payload.movedA)} / ${fmtNum(payload.movedB)}) · ` + new Date().toLocaleTimeString('ru-RU'));
    }catch(err){
      setSyncStatus('ошибка обмена стеллажами', true);
      alert('Не удалось поменять стеллажи местами: ' + err.message);
      await fetchRecords(); renderAll();
    } finally {
      progressEnd();
    }
  }


  function renderGrid(){
    const grid = document.getElementById('rack-grid');
    if(!currentAisle){ grid.innerHTML = '<div class="empty-note">Нет адресных ячеек в данных</div>'; return; }
    const extent = aisleExtent(currentAisle);
    if(!extent){ grid.innerHTML = '<div class="empty-note">Пусто</div>'; return; }
    const rows = addressRecords().filter(r=>r.row===currentAisle);

    const fullRacks = extent.racks;
    const levels = LEVEL_ORDER.filter(l=>extent.levels.includes(l)).reverse();

    // group by rack-level
    const byPos = {};
    rows.forEach(r=>{
      const key = r.rack+"|"+r.level;
      (byPos[key] = byPos[key] || []).push(r);
    });

    const term = mapFilterTerm.trim().toLowerCase();

    let html = `<div style="display:grid; grid-template-columns:34px repeat(${fullRacks.length}, var(--cell-size,22px)); gap:3px;">`;
    html += `<div></div>`;
    fullRacks.forEach(rk=> {
      const sel = moveMode && String(rk)===tapSourceRackSel ? 'tap-selected' : '';
      html += `<div class="rack-label ${sel}" draggable="true" data-rack="${rk}" title="Перетащите на другой стеллаж, чтобы поменять их местами целиком">${rk}</div>`;
    });
    levels.forEach(lv=>{
      html += `<div class="level-label">${lv}</div>`;
      fullRacks.forEach(rk=>{
        const key = rk+"|"+lv;
        const items = byPos[key];
        const addr = `${currentAisle}-${zpad(rk)}-${lv}`;
        const selCell = moveMode && addr===tapSourceAddress ? 'tap-selected' : '';
        if(!items){
          html += `<div class="cell ${selCell}" data-rack="${rk}" data-level="${lv}" data-address="${addr}" title="${addr} · свободно — сюда можно перетащить товар"></div>`;
          return;
        }
        const arts = Array.from(new Set(items.map(i=>i.article)));
        const matches = term && (
          items.some(i=> i.article.toLowerCase().includes(term) || i.cell.toLowerCase().includes(term) || i.name.toLowerCase().includes(term) || (i.te && i.te.toLowerCase().includes(term)))
        );
        const cls = arts.length>1 ? 'multi' : 'filled';
        const dim = term && !matches ? 'opacity:.25;' : '';
        const ring = matches ? 'box-shadow:0 0 0 2px var(--danger);' : '';
        html += `<div class="cell ${cls} ${selCell}" style="${dim}${ring}" draggable="true" data-rack="${rk}" data-level="${lv}" data-address="${addr}" title="${items[0].cell} · ${arts.length} артикул(ов) · перетащите, чтобы переместить"></div>`;
      });
    });
    html += `</div>`;
    grid.innerHTML = html;

    // Every cell (empty or filled) responds to a click — in move-mode that's
    // tap-to-select-then-target; otherwise only filled cells open the drawer.
    grid.querySelectorAll('.cell[data-address]').forEach(el=>{
      const rk = el.dataset.rack, lv = el.dataset.level;
      const items = byPos[rk+"|"+lv];
      el.addEventListener('click', async ()=>{
        if(moveMode){
          const addr = el.dataset.address;
          if(tapSourceAddress===null){
            if(!items) return; // nothing to move from an empty cell
            tapSourceAddress = addr; renderGrid();
          } else if(tapSourceAddress===addr){
            tapSourceAddress = null; renderGrid();
          } else {
            const src = tapSourceAddress; tapSourceAddress = null;
            await moveCellContents(src, addr);
          }
          return;
        }
        if(items) openDrawer(items[0].cell, items);
      });
      el.addEventListener('dragstart', (e)=>{
        if(!items) { e.preventDefault(); return; }
        dragSourceAddress = el.dataset.address;
        el.classList.add('drag-source');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', dragSourceAddress);
      });
      el.addEventListener('dragend', ()=>{
        el.classList.remove('drag-source');
        dragSourceAddress = null;
      });
      el.addEventListener('dragover', (e)=>{
        if(!dragSourceAddress) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        el.classList.add('drag-over');
        el.classList.toggle('drop-invalid', el.dataset.address===dragSourceAddress);
      });
      el.addEventListener('dragleave', ()=>{
        el.classList.remove('drag-over','drop-invalid');
      });
      el.addEventListener('drop', async (e)=>{
        e.preventDefault();
        el.classList.remove('drag-over','drop-invalid');
        const source = dragSourceAddress;
        const target = el.dataset.address;
        dragSourceAddress = null;
        if(!source || source===target) return;
        await moveCellContents(source, target);
      });
    });

    grid.querySelectorAll('.rack-label[data-rack]').forEach(el=>{
      el.addEventListener('click', async ()=>{
        if(!moveMode) return;
        const rk = el.dataset.rack;
        if(tapSourceRackSel===null){ tapSourceRackSel = rk; renderGrid(); }
        else if(tapSourceRackSel===rk){ tapSourceRackSel = null; renderGrid(); }
        else { const src = tapSourceRackSel; tapSourceRackSel = null; await swapRacks(currentAisle, src, rk); }
      });
      el.addEventListener('dragstart', (e)=>{
        e.stopPropagation();
        dragSourceRack = el.dataset.rack;
        el.classList.add('drag-source');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', dragSourceRack);
      });
      el.addEventListener('dragend', ()=>{
        el.classList.remove('drag-source');
        dragSourceRack = null;
      });
      el.addEventListener('dragover', (e)=>{
        if(!dragSourceRack || dragSourceRack===el.dataset.rack) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        el.classList.add('drag-over');
      });
      el.addEventListener('dragleave', ()=>{
        el.classList.remove('drag-over');
      });
      el.addEventListener('drop', async (e)=>{
        e.preventDefault();
        el.classList.remove('drag-over');
        const source = dragSourceRack;
        const target = el.dataset.rack;
        dragSourceRack = null;
        if(!source || source===target) return;
        await swapRacks(currentAisle, source, target);
      });
    });
  }

  async function moveCellContents(sourceAddress, targetAddress){
    const recs = state.records.filter(r=>r.cell===sourceAddress);
    if(!recs.length) return;
    setSyncStatus('перемещение…');
    progressStart(`Перемещение в ${targetAddress}…`);
    try{
      for(let i=0;i<recs.length;i++){
        const res = await fetch(`${API_BASE}/api/records/${recs[i].id}`, {
          method:'PATCH', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ cell: targetAddress })
        });
        if(!res.ok) throw new Error('HTTP '+res.status);
        if(recs.length>1) progressSet((i+1)/recs.length*100, `Перемещение в ${targetAddress}… ${i+1}/${recs.length}`);
      }
      await fetchRecords();
      renderAll();
      setSyncStatus(`перемещено в ${targetAddress} · ` + new Date().toLocaleTimeString('ru-RU'));
    }catch(err){
      setSyncStatus('ошибка перемещения', true);
      alert('Не удалось переместить товар: ' + err.message);
      await fetchRecords(); renderAll();
    } finally {
      progressEnd();
    }
  }

  // ---------- DRAWER ----------
  function openDrawer(title, items){
    document.getElementById('drawer-title').textContent = title;
    const body = document.getElementById('drawer-body');
    body.innerHTML = items.map(it=>`
      <div class="rec-card">
        <div class="art">${it.article}</div>
        <div class="name">${it.name}</div>
        <dl>
          <dt>Остаток</dt><dd>${fmtNum(it.qty)} шт</dd>
          <dt>Дата изготовления</dt><dd>${it.mfg||'—'}</dd>
          <dt>Срок годности</dt><dd>${it.exp||'—'}</dd>
          ${it.te ? `<dt>ТЕ</dt><dd>${it.te}</dd>` : ''}
        </dl>
      </div>
    `).join('');
    document.getElementById('drawer').classList.add('open');
    document.getElementById('drawer-backdrop').classList.add('open');
  }
  function closeDrawer(){
    document.getElementById('drawer').classList.remove('open');
    document.getElementById('drawer-backdrop').classList.remove('open');
  }
  document.getElementById('drawer-close').addEventListener('click', closeDrawer);
  document.getElementById('drawer-backdrop').addEventListener('click', closeDrawer);

  // ---------- GENERIC MODAL ----------
  function openModal(title, bodyHtml, footerHtml){
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').innerHTML = bodyHtml;
    document.getElementById('modal-footer').innerHTML = footerHtml || '';
    document.getElementById('modal-backdrop').classList.add('open');
  }
  function closeModal(){
    document.getElementById('modal-backdrop').classList.remove('open');
    stopBarcodeScanner();
  }
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-backdrop').addEventListener('click', (e)=>{
    if(e.target.id==='modal-backdrop') closeModal();
  });

  function escHtml(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  // ---------- BARCODE SCANNER (поиск товара по штрих-коду через камеру) ----------
  let barcodeScanner = null;

  async function stopBarcodeScanner(){
    if(!barcodeScanner) return;
    const s = barcodeScanner;
    barcodeScanner = null;
    try{ await s.stop(); }catch(e){ /* уже остановлен или не запускался */ }
    try{ s.clear(); }catch(e){}
  }

  // Ищем совпадения по коду: сначала точное совпадение с артикулом/ТЕ/ячейкой,
  // затем — на случай если код содержит служебные префиксы/суффиксы (GS1 и т.п.) —
  // частичное вхождение.
  function findRecordsByCode(code){
    const c = String(code || '').trim();
    if(!c) return [];
    const lc = c.toLowerCase();
    let matches = state.records.filter(r =>
      r.article === c || r.cell === c || (r.te && r.te === c)
    );
    if(!matches.length){
      matches = state.records.filter(r =>
        r.article.toLowerCase() === lc || (r.te && r.te.toLowerCase() === lc)
      );
    }
    if(!matches.length){
      matches = state.records.filter(r =>
        r.article.toLowerCase().includes(lc) || (r.te && r.te.toLowerCase().includes(lc))
      );
    }
    return matches;
  }

  function handleScannedCode(rawCode, context){
    const code = String(rawCode || '').trim();
    if(!code) return;
    const matches = findRecordsByCode(code);
    if(!matches.length){
      alert(`Товар со штрихкодом «${code}» не найден в текущих данных склада.`);
      return;
    }
    if(context === 'map'){
      // остаёмся на схеме склада: сразу переходим на нужный ряд и подсвечиваем ячейку(и)
      document.querySelector('nav.tabs button[data-view="map"]').click();
      document.getElementById('map-search').value = code;
      mapFilterTerm = code;
      const addressMatches = matches.filter(r => !r.isService);
      if(!addressMatches.length){
        renderGrid();
        alert(`Товар со штрихкодом «${code}» найден только в служебной зоне — на схеме склада его нет.`);
        return;
      }
      pulseAddressesOnMap(addressMatches);
      return;
    }
    // переключаемся на вкладку "Таблица данных" и подставляем код в поиск
    document.querySelector('nav.tabs button[data-view="table"]').click();
    tableTerm = code;
    document.getElementById('table-search').value = code;
    renderAll();
    // и сразу открываем карточку найденного товара
    openDrawer(`Найдено по коду «${code}»`, matches.map(r=>({
      article: r.article, name: r.name, qty: r.qty, mfg: r.mfg, exp: r.exp,
      te: r.te, cell: r.cell
    })));
  }

  function openBarcodeScanner(context){
    const body = `
      <div id="barcode-reader"></div>
      <div id="barcode-status" style="margin-top:10px; font-size:12.5px; color:var(--ink-soft);">Наведите камеру на штрих-код товара…</div>
      <div class="form-field" style="margin-top:14px;">
        <label>Или введите код вручную</label>
        <input type="text" id="barcode-manual-input" placeholder="Артикул, код ТЕ или ячейка…">
      </div>
    `;
    const footer = `<button class="btn" id="barcode-manual-submit">Найти</button><button class="btn primary" id="barcode-cancel">Закрыть</button>`;
    openModal('Поиск товара по штрих-коду', body, footer);

    document.getElementById('barcode-cancel').addEventListener('click', closeModal);

    const manualInput = document.getElementById('barcode-manual-input');
    const submitManual = ()=>{
      const val = manualInput.value.trim();
      if(!val) return;
      closeModal();
      handleScannedCode(val, context);
    };
    document.getElementById('barcode-manual-submit').addEventListener('click', submitManual);
    manualInput.addEventListener('keydown', (e)=>{ if(e.key==='Enter') submitManual(); });

    if(typeof Html5Qrcode === 'undefined'){
      document.getElementById('barcode-status').textContent = 'Сканер камеры недоступен (нет соединения с CDN) — введите код вручную.';
      return;
    }

    barcodeScanner = new Html5Qrcode('barcode-reader', {
      formatsToSupport: [
        Html5QrcodeSupportedFormats.EAN_13, Html5QrcodeSupportedFormats.EAN_8,
        Html5QrcodeSupportedFormats.CODE_128, Html5QrcodeSupportedFormats.CODE_39,
        Html5QrcodeSupportedFormats.UPC_A, Html5QrcodeSupportedFormats.UPC_E,
        Html5QrcodeSupportedFormats.ITF, Html5QrcodeSupportedFormats.QR_CODE
      ],
      verbose: false
    });

    let lastCode = null, lastTime = 0;
    barcodeScanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: { width: 260, height: 160 } },
      (decodedText)=>{
        const now = Date.now();
        if(decodedText === lastCode && now - lastTime < 1500) return; // антидребезг повторных кадров
        lastCode = decodedText; lastTime = now;
        const statusEl = document.getElementById('barcode-status');
        if(statusEl) statusEl.textContent = `Считано: ${decodedText}`;
        closeModal(); // остановит сканер (см. closeModal) и закроет окно
        handleScannedCode(decodedText, context);
      },
      ()=>{ /* игнорируем неудачные попытки распознавания в очередном кадре */ }
    ).catch(err=>{
      const statusEl = document.getElementById('barcode-status');
      if(statusEl) statusEl.textContent = 'Не удалось открыть камеру: ' + (err && err.message ? err.message : err) + '. Введите код вручную или проверьте разрешение на использование камеры.';
    });
  }

  document.getElementById('scan-barcode-btn').addEventListener('click', ()=> openBarcodeScanner('table'));
  document.getElementById('map-scan-btn').addEventListener('click', ()=> openBarcodeScanner('map'));

  // ---------- ЖУРНАЛ ИЗМЕНЕНИЙ (отдельное окно) ----------
  const ACTIVITY_LABELS = {
    'update': 'Правка', 'create': 'Добавление', 'delete': 'Удаление',
    'swap-rows': 'Обмен рядами', 'rename-row': 'Переим. ряда', 'set-racks': 'Стеллажи',
    'swap-racks': 'Обмен стеллажами', 'bulk-move': 'Массовый перенос', 'bulk-delete': 'Массовое удаление',
    'create-zone': 'Новая зона', 'rename-zone': 'Переим. зоны', 'delete-zone': 'Удаление зоны',
    'import': 'Загрузка файла'
  };
  function fmtActivityTime(ts){
    // Сервер отдаёт время в UTC (SQLite datetime('now')); показываем локально.
    const d = new Date(ts.replace(' ', 'T') + 'Z');
    if(isNaN(d.getTime())) return ts;
    return d.toLocaleString('ru-RU', { day:'2-digit', month:'2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit' });
  }
  async function openActivityLog(){
    openModal('Журнал изменений', '<div id="activity-log-hint">Хранится за последние 14 дней.</div><div id="activity-log-list"><div id="activity-log-empty">Загрузка…</div></div>', '<button class="btn" id="activity-log-close">Закрыть</button>');
    document.getElementById('activity-log-close').addEventListener('click', closeModal);
    try{
      const res = await fetch(`${API_BASE}/api/activity?limit=1000`);
      const payload = await res.json().catch(()=>({}));
      if(!res.ok) throw new Error(payload.error || ('HTTP '+res.status));
      const entries = payload.entries || [];
      const listEl = document.getElementById('activity-log-list');
      if(!listEl) return; // окно уже закрыли, пока грузились данные
      if(!entries.length){
        listEl.innerHTML = '<div id="activity-log-empty">За последние 14 дней изменений не было.</div>';
        return;
      }
      listEl.innerHTML = entries.map(e => `
        <div class="activity-row">
          <span class="a-time">${fmtActivityTime(e.ts)}</span>
          <span class="a-action">${escHtml(ACTIVITY_LABELS[e.action] || e.action)}</span>
          <span class="a-summary">${escHtml(e.summary)}</span>
        </div>
      `).join('');
    }catch(err){
      const listEl = document.getElementById('activity-log-list');
      if(listEl) listEl.innerHTML = `<div id="activity-log-empty">Не удалось загрузить журнал: ${err.message}</div>`;
    }
  }
  document.getElementById('activity-log-btn').addEventListener('click', openActivityLog);

  // ---------- CELL PICKER (visual map to choose an address) ----------
  // Used both by the pin button next to each table row and by the "add product" form.
  let pickerAisle = null;
  function openCellPicker(onPick, currentValue){
    const aisles = aisleList();
    pickerAisle = (currentValue && classify(currentValue).row) || pickerAisle || aisles[0];
    if(!aisles.includes(pickerAisle)) pickerAisle = aisles[0];

    const body = `
      <div class="aisles" id="picker-aisle-chips"></div>
      <div class="grid-wrap" style="margin-top:12px;"><div class="rack-grid" id="picker-grid"></div></div>
      <div class="legend">
        <span><i class="swatch" style="background:var(--accent-soft);border:1px solid var(--accent);"></i>занята</span>
        <span><i class="swatch" style="background:var(--empty);"></i>свободна — можно выбрать</span>
      </div>
    `;
    openModal('Выберите ячейку на схеме склада', body, '');

    function renderPickerAisles(){
      const box = document.getElementById('picker-aisle-chips');
      box.innerHTML = aisles.map(a=>`<button class="aisle-chip ${a===pickerAisle?'active':''}" data-aisle="${a}">Ряд ${a}</button>`).join('');
      box.querySelectorAll('.aisle-chip').forEach(btn=>{
        btn.addEventListener('click', ()=>{ pickerAisle = btn.dataset.aisle; renderPickerAisles(); renderPickerGrid(); });
      });
    }

    function renderPickerGrid(){
      const grid = document.getElementById('picker-grid');
      const extent = aisleExtent(pickerAisle);
      if(!extent){ grid.innerHTML = '<div class="empty-note">Пусто</div>'; return; }
      const rows = addressRecords().filter(r=>r.row===pickerAisle);
      const racks = extent.racks;
      const levels = LEVEL_ORDER.filter(l=>extent.levels.includes(l)).reverse();
      const byPos = {};
      rows.forEach(r=>{ (byPos[r.rack+'|'+r.level] = byPos[r.rack+'|'+r.level] || []).push(r); });

      let html = `<div style="display:grid; grid-template-columns:34px repeat(${racks.length}, var(--cell-size,22px)); gap:3px;">`;
      html += `<div></div>`;
      racks.forEach(rk=> html += `<div class="rack-label">${rk}</div>`);
      levels.forEach(lv=>{
        html += `<div class="level-label">${lv}</div>`;
        racks.forEach(rk=>{
          const addr = `${pickerAisle}-${zpad(rk)}-${lv}`;
          const items = byPos[rk+'|'+lv];
          const cls = items ? (new Set(items.map(i=>i.article)).size>1 ? 'multi' : 'filled') : '';
          const current = addr===currentValue ? 'box-shadow:0 0 0 2px var(--danger);' : '';
          const title = items ? `${addr} · занята (${items.length} запис.)` : `${addr} · свободна`;
          html += `<div class="cell ${cls}" style="cursor:pointer; ${current}" data-address="${addr}" title="${title}"></div>`;
        });
      });
      html += `</div>`;
      grid.innerHTML = html;
      grid.querySelectorAll('.cell[data-address]').forEach(el=>{
        el.addEventListener('click', ()=>{
          onPick(el.dataset.address);
          closeModal();
        });
      });
    }

    renderPickerAisles();
    renderPickerGrid();
  }


  let tableTerm = "";
  let tableFilter = "all";
  let tableCategoryFilter = new Set(); // пусто = все категории
  let tableSort = { field: null, dir: 'asc' }; // dir: 'asc' | 'desc'
  const selectedIds = new Set();

  // Даты в базе хранятся строками формата "дд.мм.гггг[, ЧЧ:ММ:СС]" (или пустые) —
  // для сортировки переводим их в сравнимое число, пустые/нераспознанные уходят в конец.
  function parseRuDateForSort(v){
    if(!v) return null;
    const m = String(v).match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    if(!m) return null;
    return new Date(Number(m[3]), Number(m[2])-1, Number(m[1])).getTime();
  }

  function updateBulkToolbar(){
    const bar = document.getElementById('bulk-toolbar');
    if(selectedIds.size>0){
      bar.style.display = 'flex';
      document.getElementById('bulk-count').textContent = `Выбрано: ${selectedIds.size}`;
    } else {
      bar.style.display = 'none';
    }
  }

  document.getElementById('bulk-clear-btn').addEventListener('click', ()=>{
    selectedIds.clear(); renderTable();
  });

  document.getElementById('bulk-delete-btn').addEventListener('click', async ()=>{
    const ids = Array.from(selectedIds);
    if(!ids.length) return;
    if(!confirm(`Удалить ${ids.length} выбранных записей?`)) return;
    progressStart(`Удаление ${ids.length} записей…`);
    try{
      const res = await fetch(`${API_BASE}/api/records/bulk-delete`, {
        method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ ids })
      });
      const payload = await res.json().catch(()=>({}));
      if(!res.ok) throw new Error(payload.error || ('HTTP '+res.status));
      selectedIds.clear();
      await fetchRecords(); renderAll();
      setSyncStatus(`удалено ${payload.deleted} записей · ` + new Date().toLocaleTimeString('ru-RU'));
    }catch(err){
      alert('Не удалось удалить: ' + err.message);
    } finally { progressEnd(); }
  });

  document.getElementById('bulk-move-btn').addEventListener('click', ()=>{
    const ids = Array.from(selectedIds);
    if(!ids.length) return;
    const body = `
      <div class="form-field with-pin">
        <div><label>Новая ячейка или служебная зона</label><input id="bulk-move-target" type="text" placeholder="напр. 01-12-02 или Карантин"></div>
        <button class="pin-btn" id="bulk-move-pick" style="height:34px;">📍</button>
      </div>
      <div class="form-error" id="bulk-move-error"></div>
    `;
    const footer = `<button class="btn" id="bulk-move-cancel">Отмена</button><button class="btn primary" id="bulk-move-submit">Переместить</button>`;
    openModal(`Переместить ${ids.length} записей`, body, footer);
    document.getElementById('bulk-move-cancel').addEventListener('click', closeModal);
    document.getElementById('bulk-move-pick').addEventListener('click', ()=>{
      openCellPicker((addr)=>{ document.getElementById('bulk-move-target').value = addr; }, '');
    });
    document.getElementById('bulk-move-submit').addEventListener('click', async ()=>{
      const errEl = document.getElementById('bulk-move-error');
      const target = document.getElementById('bulk-move-target').value.trim();
      if(!target){ errEl.textContent='Укажите ячейку или зону.'; errEl.classList.add('show'); return; }
      progressStart(`Перемещение ${ids.length} записей…`);
      try{
        const res = await fetch(`${API_BASE}/api/records/bulk-move`, {
          method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ ids, cell: target })
        });
        const payload = await res.json().catch(()=>({}));
        if(!res.ok) throw new Error(payload.error || ('HTTP '+res.status));
        closeModal();
        selectedIds.clear();
        await fetchRecords(); renderAll();
        setSyncStatus(`перемещено ${payload.moved} записей в ${target} · ` + new Date().toLocaleTimeString('ru-RU'));
      }catch(err){
        errEl.textContent = err.message; errEl.classList.add('show');
      } finally { progressEnd(); }
    });
  });

  // ---------- UNDO LAST ACTION ----------
  document.getElementById('undo-btn').addEventListener('click', async ()=>{
    progressStart('Отмена последнего действия…');
    try{
      const res = await fetch(`${API_BASE}/api/activity/undo`, { method:'POST' });
      const payload = await res.json().catch(()=>({}));
      if(!res.ok) throw new Error(payload.error || ('HTTP '+res.status));
      await fetchRecords(); renderAll();
      setSyncStatus(`отменено: ${payload.summary} · ` + new Date().toLocaleTimeString('ru-RU'));
    }catch(err){
      setSyncStatus('нечего отменять', true);
      alert('Не удалось отменить: ' + err.message);
    } finally { progressEnd(); }
  });


  // Строит выпадающее меню мультивыбора категорий с чекбоксами и счётчиком
  // по каждой (в рамках уже применённых поиска/фильтра "адресные/служебные"),
  // и обновляет подпись на кнопке-переключателе.
  function renderCategoryFilterMenu(baseRows){
    const menu = document.getElementById('category-filter-menu');
    const toggleBtn = document.getElementById('category-filter-toggle');
    if(!menu || !toggleBtn) return;

    const counts = {};
    baseRows.forEach(r=>{
      const cat = classifyCategory(r.name);
      counts[cat] = (counts[cat] || 0) + 1;
    });
    const known = Object.keys(CATEGORY_COLORS).filter(c => counts[c]);
    const rest = Object.keys(counts).filter(c => !known.includes(c)).sort((a,b)=>a.localeCompare(b,'ru'));
    const cats = [...known, ...rest];

    toggleBtn.textContent = tableCategoryFilter.size ? `Категория (${tableCategoryFilter.size}) ▾` : 'Категория ▾';
    toggleBtn.classList.toggle('active', tableCategoryFilter.size > 0);

    if(!cats.length){
      menu.innerHTML = `<div style="padding:10px; font-size:12px; color:var(--ink-soft);">Нет категорий</div>`;
      return;
    }
    menu.innerHTML = `
      <div class="cat-menu-actions">
        <button type="button" id="cat-select-all">Выбрать все</button>
        <button type="button" id="cat-select-none">Сбросить</button>
      </div>
    ` + cats.map(c=>{
      const color = CATEGORY_COLORS[c] || '#94A3B8';
      const checked = tableCategoryFilter.has(c) ? 'checked' : '';
      return `<label class="cat-menu-item">
        <input type="checkbox" data-category="${c}" ${checked}>
        <span class="cat-swatch" style="background:${color};"></span>
        <span class="cat-name">${c}</span>
        <span class="cat-count">${counts[c]}</span>
      </label>`;
    }).join('');

    menu.querySelectorAll('input[type="checkbox"]').forEach(cb=>{
      cb.addEventListener('change', ()=>{
        const cat = cb.dataset.category;
        if(cb.checked) tableCategoryFilter.add(cat); else tableCategoryFilter.delete(cat);
        renderTable();
      });
    });
    const selAll = document.getElementById('cat-select-all');
    const selNone = document.getElementById('cat-select-none');
    if(selAll) selAll.addEventListener('click', ()=>{ tableCategoryFilter = new Set(cats); renderTable(); });
    if(selNone) selNone.addEventListener('click', ()=>{ tableCategoryFilter.clear(); renderTable(); });
  }

  function renderTable(){
    let rows = state.records;
    if(tableFilter==='address') rows = rows.filter(r=>!r.isService);
    if(tableFilter==='service') rows = rows.filter(r=>r.isService);
    const term = tableTerm.trim().toLowerCase();
    if(term){
      rows = rows.filter(r=> r.article.toLowerCase().includes(term) || r.name.toLowerCase().includes(term) || r.cell.toLowerCase().includes(term) || (r.te && r.te.toLowerCase().includes(term)));
    }

    renderCategoryFilterMenu(rows);
    if(tableCategoryFilter.size){
      rows = rows.filter(r => tableCategoryFilter.has(classifyCategory(r.name)));
    }

    if(tableSort.field){
      const f = tableSort.field, dir = tableSort.dir==='asc' ? 1 : -1;
      rows = rows.slice().sort((a,b)=>{
        let av, bv;
        if(f==='qty'){ av = a.qty; bv = b.qty; }
        else if(f==='mfg' || f==='exp'){
          av = parseRuDateForSort(a[f]); bv = parseRuDateForSort(b[f]);
          if(av===null && bv===null) return 0;
          if(av===null) return 1;  // пустые даты — всегда в конец, независимо от направления
          if(bv===null) return -1;
        } else if(f==='isService'){ av = a.isService ? 1 : 0; bv = b.isService ? 1 : 0; }
        else if(f==='category'){ av = classifyCategory(a.name); bv = classifyCategory(b.name); }
        else { av = String(a[f]||'').toLowerCase(); bv = String(b[f]||'').toLowerCase(); }
        if(av < bv) return -1*dir;
        if(av > bv) return 1*dir;
        return 0;
      });
    }

    document.getElementById('table-count').textContent = `${fmtNum(rows.length)} записей`;
    document.querySelectorAll('#view-table thead th.sortable').forEach(th=>{
      const active = th.dataset.sort === tableSort.field;
      th.classList.toggle('sorted', active);
      th.querySelector('.sort-arrow')?.remove();
      const arrow = document.createElement('span');
      arrow.className = 'sort-arrow';
      arrow.textContent = active ? (tableSort.dir==='asc' ? '▲' : '▼') : '↕';
      th.appendChild(arrow);
    });

    const body = document.getElementById('table-body');
    // cap rendered rows for performance, keep it responsive
    const MAX = 600;
    const shown = rows.slice(0, MAX);
    body.innerHTML = shown.map(r=>`
      <tr data-id="${r.id}">
        <td><input type="checkbox" class="row-select" data-id="${r.id}" ${selectedIds.has(r.id)?'checked':''}></td>
        <td class="cellcode">
          <div style="display:flex; gap:5px; align-items:center;">
            <input class="edit-input cellinput" data-field="cell" value="${r.cell}">
            <button class="pin-btn map-pick-btn" title="Выбрать на карте склада">📍</button>
          </div>
        </td>
        <td class="article">${r.article}</td>
        <td>${r.name}</td>
        <td>${classifyCategory(r.name)}</td>
        <td><input class="edit-input" data-field="qty" type="number" value="${r.qty}"></td>
        <td>${r.mfg||'—'}</td>
        <td>${r.exp||'—'}</td>
        <td class="cellcode" style="font-size:11px;">${r.te||'—'}</td>
        <td>${r.isService ? '<span class="badge service">служебная</span>' : '<span class="badge ok">адресная</span>'}</td>
        <td><button class="pin-btn row-delete-btn" title="Удалить запись">🗑</button></td>
      </tr>
    `).join('') + (rows.length>MAX ? `<tr><td colspan="11" style="text-align:center;color:var(--ink-soft);padding:14px;">Показаны первые ${MAX} из ${fmtNum(rows.length)} — уточните поиск, чтобы увидеть остальные</td></tr>` : '');

    body.querySelectorAll('.row-select').forEach(cb=>{
      cb.addEventListener('change', ()=>{
        const id = parseInt(cb.dataset.id,10);
        if(cb.checked) selectedIds.add(id); else selectedIds.delete(id);
        updateBulkToolbar();
      });
    });
    const selectAll = document.getElementById('table-select-all');
    selectAll.checked = shown.length>0 && shown.every(r=>selectedIds.has(r.id));
    selectAll.onchange = ()=>{
      shown.forEach(r=> selectAll.checked ? selectedIds.add(r.id) : selectedIds.delete(r.id));
      renderTable();
    };
    updateBulkToolbar();

    body.querySelectorAll('.map-pick-btn').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const tr = btn.closest('tr');
        const id = parseInt(tr.dataset.id,10);
        const rec = state.records.find(r=>r.id===id);
        const input = tr.querySelector('input[data-field="cell"]');
        openCellPicker((address)=>{
          input.value = address;
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }, rec.cell);
      });
    });

    body.querySelectorAll('.row-delete-btn').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        const tr = btn.closest('tr');
        const id = parseInt(tr.dataset.id,10);
        const rec = state.records.find(r=>r.id===id);
        if(!rec) return;
        if(!confirm(`Удалить запись «${rec.article}» из ячейки ${rec.cell}?`)) return;
        progressStart('Удаление записи…');
        try{
          const res = await fetch(`${API_BASE}/api/records/${id}`, { method:'DELETE' });
          if(!res.ok) throw new Error('HTTP '+res.status);
          selectedIds.delete(id);
          await fetchRecords();
          renderAll();
          setSyncStatus('запись удалена · ' + new Date().toLocaleTimeString('ru-RU'));
        }catch(err){
          alert('Не удалось удалить запись: ' + err.message);
        } finally {
          progressEnd();
        }
      });
    });

    body.querySelectorAll('input.edit-input').forEach(inp=>{
      inp.addEventListener('change', async (e)=>{
        const tr = e.target.closest('tr');
        const id = parseInt(tr.dataset.id,10);
        const rec = state.records.find(r=>r.id===id);
        const field = e.target.dataset.field;
        const prevValue = field==='qty' ? rec.qty : rec.cell;
        const patch = {};
        if(field==='qty'){
          rec.qty = Math.max(0, Number(e.target.value)||0);
          patch.qty = rec.qty;
        } else if(field==='cell'){
          rec.cell = e.target.value.trim();
          const cls = classify(rec.cell);
          rec.isService = cls.isService; rec.row = cls.row; rec.rack = cls.rack; rec.level = cls.level;
          patch.cell = rec.cell;
        }
        renderAll(); // optimistic recalc everything
        progressStart('Сохранение…');
        try{
          const res = await fetch(`${API_BASE}/api/records/${id}`, {
            method:'PATCH',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify(patch)
          });
          if(!res.ok) throw new Error('HTTP '+res.status);
          setSyncStatus('сохранено ' + new Date().toLocaleTimeString('ru-RU'));
        }catch(err){
          // revert on failure so the UI doesn't lie about what's saved
          if(field==='qty') rec.qty = prevValue;
          else { rec.cell = prevValue; const cls = classify(rec.cell); rec.isService = cls.isService; rec.row = cls.row; rec.rack = cls.rack; rec.level = cls.level; }
          renderAll();
          setSyncStatus('не удалось сохранить', true);
          alert('Не удалось сохранить изменение на сервере: ' + err.message);
        } finally {
          progressEnd();
        }
      });
    });
  }

  // ---------- ROW MANAGEMENT (rename + add/remove/reorder racks) ----------
  // Real warehouses don't always run 1,2,3...N in order (e.g. 75,74,73,1,2,3...),
  // rows sometimes need relabelling, and the number of racks in a row changes
  // when shelving is added or removed — this one panel covers all three.
  function openAddRowForm(){
    const existing = new Set(aisleList());
    const body = `
      <div class="form-field" style="margin-bottom:16px;">
        <label>Название ряда (2 цифры)</label>
        <input id="new-row-code" type="text" maxlength="2" placeholder="напр. 07" style="width:80px; padding:8px 10px; border:1px solid var(--line); border-radius:7px; font-family:var(--mono); font-size:14px;">
      </div>
      <div class="form-field" style="margin-bottom:6px;">
        <label>Стеллажи ряда</label>
        <div class="form-grid">
          <div class="form-field"><label>От</label><input id="new-row-from" type="number" min="1" placeholder="напр. 1"></div>
          <div class="form-field"><label>До</label><input id="new-row-to" type="number" min="1" placeholder="напр. 20"></div>
        </div>
        <p style="font-size:11.5px; color:var(--ink-soft); margin:6px 0 0;">Создаст стеллажи по порядку от «От» до «До» включительно — состав и порядок можно поменять потом через «Управление рядом».</p>
      </div>
      <div class="form-error" id="add-row-error"></div>
    `;
    const footer = `<button class="btn" id="add-row-cancel">Отмена</button><button class="btn primary" id="add-row-save">Создать ряд</button>`;
    openModal('Добавить ряд', body, footer);
    document.getElementById('add-row-cancel').addEventListener('click', closeModal);
    document.getElementById('add-row-save').addEventListener('click', async ()=>{
      const errEl = document.getElementById('add-row-error');
      errEl.classList.remove('show');
      const code = document.getElementById('new-row-code').value.trim().padStart(2,'0');
      const from = parseInt(document.getElementById('new-row-from').value, 10);
      const to = parseInt(document.getElementById('new-row-to').value, 10);
      if(!/^\d{2}$/.test(code)){ errEl.textContent = 'Название ряда должно быть числом (1-2 цифры).'; errEl.classList.add('show'); return; }
      if(existing.has(code)){ errEl.textContent = `Ряд ${code} уже существует.`; errEl.classList.add('show'); return; }
      if(!Number.isInteger(from) || !Number.isInteger(to) || from<1 || to<from){ errEl.textContent = 'Укажите корректный диапазон стеллажей («От» ≤ «До»).'; errEl.classList.add('show'); return; }
      const racks = [];
      for(let i=from; i<=to; i++) racks.push(i);
      progressStart('Создание ряда…');
      try{
        const res = await fetch(`${API_BASE}/api/layout`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ row: code, racks })
        });
        const payload = await res.json().catch(()=>({}));
        if(!res.ok) throw new Error(payload.error || ('HTTP '+res.status));
        closeModal();
        currentAisle = code;
        await fetchRecords();
        renderAll();
        setSyncStatus(`ряд ${code} создан · ` + new Date().toLocaleTimeString('ru-RU'));
      }catch(err){
        errEl.textContent = 'Не удалось создать ряд: ' + err.message;
        errEl.classList.add('show');
      } finally {
        progressEnd();
      }
    });
  }

  document.getElementById('add-row-btn').addEventListener('click', openAddRowForm);

  function openRowManager(row){
    const targetRow = (typeof row === 'string') ? row : currentAisle;
    if(!targetRow){ alert('Сначала выберите ряд.'); return; }
    const extent = aisleExtent(targetRow);
    if(!extent){ alert('Для этого ряда пока нет структуры склада.'); return; }
    const originalRow = targetRow;
    let orderDraft = extent.racks.slice();
    let dragIdx = null;

    function occupiedRacksInDraftRow(){
      // ranks that currently hold stock in THIS row — removing them needs a warning
      const set = new Set();
      addressRecords().filter(r=>r.row===originalRow).forEach(r=>set.add(r.rack));
      return set;
    }

    function renderChips(){
      const occupied = occupiedRacksInDraftRow();
      const list = document.getElementById('modal-body').querySelector('.order-list');
      list.innerHTML = orderDraft.map((rk,idx)=>`
        <div class="order-chip" draggable="true" data-idx="${idx}" data-rack="${rk}" title="${occupied.has(rk)?'В этом стеллаже есть товар':'Пусто'}">
          <span class="oc-move" data-dir="-1" title="Сдвинуть влево">◀</span>
          ${rk}${occupied.has(rk)?'':' <span class="rm" style="opacity:.5;">×</span>'}
          <span class="oc-move" data-dir="1" title="Сдвинуть вправо">▶</span>
        </div>
      `).join('');

      list.querySelectorAll('.order-chip').forEach(chip=>{
        chip.addEventListener('dragstart', (e)=>{
          dragIdx = parseInt(chip.dataset.idx,10);
          chip.classList.add('drag-source');
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(dragIdx));
        });
        chip.addEventListener('dragend', ()=>{ chip.classList.remove('drag-source'); dragIdx = null; });
        chip.addEventListener('dragover', (e)=>{
          if(dragIdx===null) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          chip.classList.add('drag-over');
        });
        chip.addEventListener('dragleave', ()=>{ chip.classList.remove('drag-over'); });
        chip.addEventListener('drop', (e)=>{
          e.preventDefault();
          chip.classList.remove('drag-over');
          const targetIdx = parseInt(chip.dataset.idx,10);
          if(dragIdx===null || dragIdx===targetIdx) return;
          const [moved] = orderDraft.splice(dragIdx,1);
          orderDraft.splice(targetIdx,0,moved);
          dragIdx = null;
          renderChips();
        });
        // ◀▶ buttons: touch-friendly reorder alternative to drag (phones can't drag)
        chip.querySelectorAll('.oc-move').forEach(btn=>{
          btn.addEventListener('click', (e)=>{
            e.stopPropagation();
            const idx = parseInt(chip.dataset.idx,10);
            const dir = parseInt(btn.dataset.dir,10);
            const newIdx = idx + dir;
            if(newIdx<0 || newIdx>=orderDraft.length) return;
            [orderDraft[idx], orderDraft[newIdx]] = [orderDraft[newIdx], orderDraft[idx]];
            renderChips();
          });
        });
        // click the × to remove — only shown for racks with no stock
        const rmBtn = chip.querySelector('.rm');
        if(rmBtn){
          rmBtn.addEventListener('click', (e)=>{
            e.stopPropagation();
            const rk = parseInt(chip.dataset.rack,10);
            orderDraft = orderDraft.filter(r=>r!==rk);
            renderChips();
          });
        }
      });
    }

    const body = `
      <div class="form-field" style="margin-bottom:16px;">
        <label>Название ряда (2 цифры)</label>
        <input id="row-rename-input" type="text" maxlength="2" value="${originalRow}" style="width:80px; padding:8px 10px; border:1px solid var(--line); border-radius:7px; font-family:var(--mono); font-size:14px;">
      </div>
      <div class="form-field" style="margin-bottom:10px;">
        <label>Стеллажи ряда — перетаскивайте, чтобы задать порядок; × убирает пустой стеллаж</label>
        <div class="order-list"></div>
      </div>
      <div class="form-field with-pin" style="max-width:260px;">
        <div><input id="add-rack-input" type="number" min="1" placeholder="Номер нового стеллажа"></div>
        <button class="btn" id="add-rack-btn" style="height:34px;">+ Добавить</button>
      </div>
      <div class="form-error" id="row-mgr-error"></div>
    `;
    const footer = `
      <button class="btn danger" id="row-mgr-delete">Удалить ряд</button>
      <button class="btn" id="order-reset">По возрастанию</button>
      <button class="btn" id="row-mgr-cancel">Отмена</button>
      <button class="btn primary" id="row-mgr-save">Сохранить</button>
    `;
    openModal(`Управление рядом ${originalRow}`, body, footer);
    renderChips();

    document.getElementById('row-mgr-delete').addEventListener('click', async ()=>{
      const errEl = document.getElementById('row-mgr-error');
      errEl.classList.remove('show');
      if(!confirm(`Удалить ряд ${originalRow} целиком? Это возможно только если в нём нет товара. Действие необратимо.`)) return;
      progressStart('Удаление ряда…');
      try{
        const res = await fetch(`${API_BASE}/api/layout/${originalRow}`, { method:'DELETE' });
        const payload = await res.json().catch(()=>({}));
        if(!res.ok) throw new Error(payload.error || ('HTTP '+res.status));
        closeModal();
        currentAisle = null;
        await fetchRecords();
        renderAll();
        setSyncStatus(`ряд ${originalRow} удалён · ` + new Date().toLocaleTimeString('ru-RU'));
      }catch(err){
        errEl.textContent = 'Не удалось удалить ряд: ' + err.message;
        errEl.classList.add('show');
      } finally {
        progressEnd();
      }
    });

    document.getElementById('order-reset').addEventListener('click', ()=>{
      orderDraft = [...orderDraft].sort((a,b)=>a-b);
      renderChips();
    });
    document.getElementById('add-rack-btn').addEventListener('click', ()=>{
      const inp = document.getElementById('add-rack-input');
      const v = parseInt(inp.value,10);
      if(!Number.isInteger(v) || v<=0) return;
      if(!orderDraft.includes(v)) orderDraft.push(v);
      inp.value = '';
      renderChips();
    });
    document.getElementById('row-mgr-cancel').addEventListener('click', closeModal);

    document.getElementById('row-mgr-save').addEventListener('click', async ()=>{
      const errEl = document.getElementById('row-mgr-error');
      errEl.classList.remove('show');
      const newRow = document.getElementById('row-rename-input').value.trim().padStart(2,'0');
      if(!/^\d{2}$/.test(newRow)){
        errEl.textContent = 'Название ряда должно быть числом (1-2 цифры).';
        errEl.classList.add('show');
        return;
      }
      progressStart('Сохранение структуры ряда…');
      try{
        let workingRow = originalRow;
        if(newRow !== originalRow){
          const res = await fetch(`${API_BASE}/api/layout/${originalRow}/rename`, {
            method:'PUT', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ newRow })
          });
          const payload = await res.json().catch(()=>({}));
          if(!res.ok) throw new Error(payload.error || ('HTTP '+res.status));
          workingRow = newRow;
        }
        const res2 = await fetch(`${API_BASE}/api/layout/${workingRow}/racks`, {
          method:'PUT', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ racks: orderDraft })
        });
        const payload2 = await res2.json().catch(()=>({}));
        if(!res2.ok) throw new Error(payload2.error || ('HTTP '+res2.status));

        closeModal();
        currentAisle = workingRow;
        await fetchRecords();
        renderAll();
        setSyncStatus(`ряд ${workingRow} обновлён · ` + new Date().toLocaleTimeString('ru-RU'));
      }catch(err){
        errEl.textContent = 'Не удалось сохранить: ' + err.message;
        errEl.classList.add('show');
      } finally {
        progressEnd();
      }
    });
  }

  document.getElementById('rack-order-btn').addEventListener('click', openRowManager);
  document.getElementById('reco-add-row-btn').addEventListener('click', openAddRowForm);
  document.getElementById('row-select-mode-btn').addEventListener('click', ()=> setRowSelectMode(!rowSelectMode));
  document.getElementById('delete-selected-rows-btn').addEventListener('click', deleteSelectedRows);
  document.getElementById('reco-manage-row-btn').addEventListener('click', ()=> openRowManager(recoAisle));
  document.getElementById('move-mode-btn').addEventListener('click', ()=> setMoveMode(!moveMode));


  function openAddProductForm(){
    const draft = { cell:'', article:'', name:'', qty:'', mfg:'', exp:'', te:'' };

    function renderForm(){
      const body = `
        <div class="form-grid">
          <div class="form-field with-pin full">
            <div>
              <label>Ячейка</label>
              <input id="f-cell" type="text" placeholder="напр. 01-12-02" value="${draft.cell}">
            </div>
            <button class="pin-btn" id="f-cell-pick" title="Выбрать на карте склада" style="height:34px;">📍</button>
          </div>
          <div class="form-field">
            <label>Артикул *</label>
            <input id="f-article" type="text" value="${draft.article}">
          </div>
          <div class="form-field">
            <label>Остаток, шт</label>
            <input id="f-qty" type="number" min="0" value="${draft.qty}">
          </div>
          <div class="form-field full">
            <label>Наименование</label>
            <input id="f-name" type="text" value="${draft.name}">
          </div>
          <div class="form-field">
            <label>Дата изготовления</label>
            <input id="f-mfg" type="text" placeholder="дд.мм.гггг" value="${draft.mfg}">
          </div>
          <div class="form-field">
            <label>Срок годности</label>
            <input id="f-exp" type="text" placeholder="дд.мм.гггг" value="${draft.exp}">
          </div>
          <div class="form-field full">
            <label>ТЕ</label>
            <input id="f-te" type="text" value="${draft.te}">
          </div>
        </div>
        <div class="form-error" id="f-error"></div>
      `;
      const footer = `
        <button class="btn" id="f-cancel">Отмена</button>
        <button class="btn primary" id="f-submit">Добавить</button>
      `;
      openModal('Добавить товар в ячейку', body, footer);

      document.getElementById('f-cell-pick').addEventListener('click', ()=>{
        // remember what's typed so far, open the picker, come back to this form on pick
        syncDraft();
        openCellPicker((address)=>{
          draft.cell = address;
          renderForm();
        }, draft.cell);
      });
      document.getElementById('f-cancel').addEventListener('click', closeModal);
      document.getElementById('f-submit').addEventListener('click', submitForm);

      function syncDraft(){
        draft.cell = document.getElementById('f-cell').value.trim();
        draft.article = document.getElementById('f-article').value.trim();
        draft.name = document.getElementById('f-name').value.trim();
        draft.qty = document.getElementById('f-qty').value;
        draft.mfg = document.getElementById('f-mfg').value.trim();
        draft.exp = document.getElementById('f-exp').value.trim();
        draft.te = document.getElementById('f-te').value.trim();
      }

      async function submitForm(){
        syncDraft();
        const errEl = document.getElementById('f-error');
        if(!draft.cell || !draft.article){
          errEl.textContent = 'Заполните минимум «Ячейка» и «Артикул».';
          errEl.classList.add('show');
          return;
        }
        errEl.classList.remove('show');
        progressStart('Добавление товара…');
        try{
          const res = await fetch(`${API_BASE}/api/records`, {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({
              cell: draft.cell, article: draft.article, name: draft.name,
              qty: Number(draft.qty)||0, mfg: draft.mfg, exp: draft.exp, te: draft.te
            })
          });
          const payload = await res.json().catch(()=>({}));
          if(!res.ok) throw new Error(payload.error || ('HTTP '+res.status));
          closeModal();
          await fetchRecords();
          renderAll();
          setSyncStatus('товар добавлен · ' + new Date().toLocaleTimeString('ru-RU'));
        }catch(err){
          errEl.textContent = 'Не удалось сохранить: ' + err.message;
          errEl.classList.add('show');
        } finally {
          progressEnd();
        }
      }
    }

    renderForm();
  }

  document.getElementById('add-product-btn').addEventListener('click', openAddProductForm);


  let recoAisle = null;
  let recoSearchTerm = "";
  // Only rows 01-06 physically exist; 07-12 are stale rows left in the DB from
  // the old warehouse and must never be offered for new placements or ranges.
  const ACTIVE_ROWS = ['06','05','04','03','02','01'];

  // Within each active row, only this rack range is the actual STORAGE zone used
  // for picking/replenishment. Racks outside this range (in the same row) belong
  // to other zones (staging, return, etc.) by default — confirmed by warehouse
  // layout — but the boundary is editable per row in the UI (schema panel) so the
  // zone can be stretched to cover more (or fewer) rack columns, persisted per-browser.
  const STORAGE_RANGE_DEFAULT = {
    '06': [28, 66],
    '05': [25, 66],
    '04': [25, 84],
    '03': [19, 66],
    '02': [19, 66],
    '01': [13, 66]
  };
  function rowMaxRack(row){
    const extent = aisleExtent(row);
    if(!extent || !extent.racks.length) return STORAGE_RANGE_DEFAULT[row] ? STORAGE_RANGE_DEFAULT[row][1] : 999;
    return Math.max(...extent.racks);
  }
  function rowMinRack(row){
    const extent = aisleExtent(row);
    if(!extent || !extent.racks.length) return STORAGE_RANGE_DEFAULT[row] ? STORAGE_RANGE_DEFAULT[row][0] : 1;
    return Math.min(...extent.racks);
  }
  function clampStorageBound(row, v, fallback){
    v = parseInt(v, 10);
    if(!Number.isFinite(v)) return fallback;
    return Math.max(rowMinRack(row), Math.min(rowMaxRack(row), v));
  }
  function loadStorageRange(){
    const out = {...STORAGE_RANGE_DEFAULT};
    try{
      const saved = JSON.parse(localStorage.getItem('storageRange'));
      if(saved && typeof saved === 'object'){
        Object.keys(out).forEach(row=>{
          const s = saved[row];
          if(Array.isArray(s) && s.length===2){
            const lo = clampStorageBound(row, s[0], out[row][0]);
            const hi = clampStorageBound(row, s[1], out[row][1]);
            out[row] = lo<=hi ? [lo, hi] : [hi, lo];
          }
        });
      }
    }catch(e){}
    return out;
  }
  function saveStorageRange(){ try{ localStorage.setItem('storageRange', JSON.stringify(STORAGE_RANGE)); }catch(e){} }
  let STORAGE_RANGE = loadStorageRange();
  function racksInStorageZone(row, racks){
    const range = STORAGE_RANGE[row];
    if(!range) return racks;
    const [lo, hi] = range;
    return racks.filter(r=> r>=lo && r<=hi);
  }

  // Picking-face footprint per ABC class: A-class articles are fast movers and
  // get 3 rack columns of pick face by default, B gets 2, C gets 1 — wider face =
  // fewer trips to replenish that slot during a shift. Editable in the UI (ABC-классы
  // panel) and persisted per-browser; clamped to 1..6 columns.
  const ABC_COLS_DEFAULT = {A:3, B:2, C:1};
  const ABC_COLS_MIN = 1, ABC_COLS_MAX = 6;
  function clampAbcCols(v){
    v = parseInt(v, 10);
    if(!Number.isFinite(v)) return ABC_COLS_MIN;
    return Math.max(ABC_COLS_MIN, Math.min(ABC_COLS_MAX, v));
  }
  function loadAbcCols(){
    try{
      const saved = JSON.parse(localStorage.getItem('abcCols'));
      if(saved && typeof saved === 'object'){
        return {A: clampAbcCols(saved.A ?? ABC_COLS_DEFAULT.A), B: clampAbcCols(saved.B ?? ABC_COLS_DEFAULT.B), C: clampAbcCols(saved.C ?? ABC_COLS_DEFAULT.C)};
      }
    }catch(e){}
    return {...ABC_COLS_DEFAULT};
  }
  function saveAbcCols(){ try{ localStorage.setItem('abcCols', JSON.stringify(ABC_COLS)); }catch(e){} }
  let ABC_COLS = loadAbcCols();

  let recoCache = null; // {sorted:[...], posPool:[...]}

  function zpad(n){ return n<10 ? '0'+n : String(n); }

  function computeRecommendation(){
    const addr = addressRecords();
    // aggregate per article
    const byArt = {};
    state.records.forEach(r=>{
      if(!byArt[r.article]) byArt[r.article] = {article:r.article, name:r.name, qty:0};
      byArt[r.article].qty += r.qty;
      if(!byArt[r.article].name) byArt[r.article].name = r.name;
    });
    const articles = Object.values(byArt).map(a=>({...a, vol: parseVolume(a.name)}));

    // ABC class comes from a fixed, externally-supplied classification (not
    // computed here) — volShare/cumShare are still calculated purely as
    // informational stats (share of total stock volume), they just no longer
    // determine the class itself. Articles missing from the source file
    // default to C.
    articles.forEach(a=>{ a.stockVolume = a.qty * (a.vol==null?0:a.vol); });
    const grandVolume = articles.reduce((s,a)=>s+a.stockVolume,0);
    const abcSorted = [...articles].sort((a,b)=>b.stockVolume-a.stockVolume);
    let cum = 0;
    abcSorted.forEach(a=>{
      a.volShare = grandVolume>0 ? a.stockVolume/grandVolume*100 : 0;
      cum += a.volShare;
      a.cumShare = cum;
      a.abcClass = (state.abcClasses && state.abcClasses[a.article]) || 'C';
    });
    const abcByArticle = {};
    abcSorted.forEach(a=>{ abcByArticle[a.article] = a; });

    // material = packaging material (ПЭТ, жесть, стекло, тетрапак, картон, BIB, весовой) —
    // THIS is the grouping that must stay physically adjacent on the shelf.
    // merchandise category (juices/water/soda/etc.) is kept only as an informational
    // label shown in the UI — it no longer drives placement or adjacency.
    articles.forEach(a=>{ a.category = classifyCategory(a.name); a.material = classifyMaterial(a.name); });
    const materialVolume = {};
    articles.forEach(a=>{ materialVolume[a.material] = (materialVolume[a.material]||0) + a.stockVolume; });
    const materialOrder = Object.entries(materialVolume).sort((x,y)=>y[1]-x[1]).map(([k])=>k);
    const materialRank = {}; materialOrder.forEach((c,i)=>materialRank[c]=i);

    // Placement priority: 1) packaging material (ПЭТ с ПЭТ, жесть с жестью, стекло
    // со стеклом и т.д. — материал никогда не разбивается классом ABC, весь его
    // пробег на маршруте идёт одним непрерывным блоком), 2) фасовка / объём
    // единицы — 2л стоит с 2л, 1.5л с 1.5л и т.д., эта группа тоже не
    // разбивается, 3) продаваемость / оборачиваемость — класс ABC определяет
    // порядок И между самими группами объёма (какая фасовка идёт раньше по
    // пробегу), И между товарами внутри одной группы объёма (A — ходовые
    // товары первыми, далее B, затем C). Порядок групп объёма НЕ зависит от
    // количества литров — только от того, насколько ходовой в среднем товар
    // в этой фасовке. Merchandise category is NOT part of the ordering.
    const abcRank = {A:0, B:1, C:2};
    const volKey = a => a.vol==null ? '\u2205' : a.vol.toFixed(2);
    const volGroupStats = {}; // material+volKey -> {minAbcRank, countA, qty}
    articles.forEach(a=>{
      const k = a.material+'|'+volKey(a);
      const abc = abcByArticle[a.article].abcClass;
      if(!volGroupStats[k]) volGroupStats[k] = {minAbcRank:3, countA:0, qty:0};
      const st = volGroupStats[k];
      st.minAbcRank = Math.min(st.minAbcRank, abcRank[abc]);
      if(abc==='A') st.countA++;
      st.qty += a.qty;
    });
    function placementComparator(a,b){
      if(materialRank[a.material] !== materialRank[b.material]) return materialRank[a.material]-materialRank[b.material];
      const ka = a.material+'|'+volKey(a), kb = b.material+'|'+volKey(b);
      if(ka !== kb){
        const sa = volGroupStats[ka], sb = volGroupStats[kb];
        if(sa.minAbcRank !== sb.minAbcRank) return sa.minAbcRank-sb.minAbcRank; // фасовка с более ходовым товаром — раньше
        if(sb.countA !== sa.countA) return sb.countA-sa.countA;
        if(sb.qty !== sa.qty) return sb.qty-sa.qty;
        const av = a.vol==null ? -Infinity : a.vol, bv = b.vol==null ? -Infinity : b.vol;
        return bv - av; // last-resort tie-break between equally-selling volume groups
      }
      const aAbc = abcByArticle[a.article].abcClass, bAbc = abcByArticle[b.article].abcClass;
      if(abcRank[aAbc] !== abcRank[bAbc]) return abcRank[aAbc]-abcRank[bAbc]; // ходовые товары (A) — первыми внутри одной фасовки
      return b.qty - a.qty; // final stable tie-break
    }
    articles.sort(placementComparator);

    // Fixed business rule: 0.5 L bottles always go to row 04 — but row 04 is not
    // exclusive to them; whatever cells the 0.5 L group doesn't use are still
    // fair game for the normal route. Add more entries here if other
    // volumes/rows need the same kind of pin.
    const FORCED_ROW_BY_VOLUME = { '0.50': '04' };
    function forcedRowFor(a){ return a.vol==null ? null : (FORCED_ROW_BY_VOLUME[a.vol.toFixed(2)] || null); }

    // Physical walking path ("змейка"): only rows 01–06 are real (07–12 are stale
    // leftovers from the old warehouse in the DB and are never used for new
    // placements). Picking starts at the far end of row 06 (lowest rack in that
    // row, e.g. 06-28-01, next to "начало пикинга"/"зона возврата" на layout)
    // and runs in ASCENDING rack order through row 06 (28→66, confirmed), then
    // zig-zags back and forth through rows 05→01, reversing direction each row
    // (05 descending, 04 ascending, 03 descending, 02 ascending, 01 descending)
    // so the path never jumps across the warehouse.
    const rowRacks = {}; // row -> ordered [{row,rack}] in that row's own walking direction
    const walkIndex = {}; // "row-rack" -> position in the true physical walking order
    let walkPtr = 0;
    ACTIVE_ROWS.forEach((row, idx)=>{
      const extent = aisleExtent(row);
      let racks = extent ? extent.racks.slice().sort((a,b)=>a-b) : [];
      racks = racksInStorageZone(row, racks);
      if(idx % 2 === 1) racks = racks.reverse(); // odd idx (rows 05,03,01): descending
      rowRacks[row] = racks.map(rack=>{ walkIndex[`${row}-${rack}`] = walkPtr++; return {row, rack}; });
    });

    function assignFromPool(list, queue, startPtr){
      let ptr = startPtr || 0;
      const results = list.map(a=>{
        const abc = abcByArticle[a.article];
        const width = ABC_COLS[abc.abcClass] || 1;
        const positions = [];
        for(let i=0; i<width && ptr<queue.length; i++, ptr++) positions.push(queue[ptr]);
        const pos = positions[0] || null;
        return {
          ...a,
          volShare: abc.volShare, cumShare: abc.cumShare, abcClass: abc.abcClass, stockVolume: abc.stockVolume,
          materialColor: MATERIAL_COLORS[a.material] || '#64748B',
          pickAddress: pos ? `${pos.row}-${zpad(pos.rack)}-01` : null,
          pickAddresses: positions.map(p=>`${p.row}-${zpad(p.rack)}-01`),
          replenish: pos ? `${pos.row}-${zpad(pos.rack)} · ярусы выше 01` : null,
          replenishRow: pos ? pos.row : null, replenishRack: pos ? pos.rack : null,
          positions // every {row,rack} column this article's pick face occupies (width per ABC class)
        };
      });
      return { results, usedPtr: ptr };
    }

    // For each pinned row: place its pinned group first, taking cells from the
    // START of that row's own rack sequence; whatever's left in that row after
    // the pinned group is satisfied goes back into the general route's pool at
    // this row's normal spot, so other materials can still land in row 04.
    const pinnedRows = new Set(Object.values(FORCED_ROW_BY_VOLUME));
    let assigned = [];
    const pool = [];
    ACTIVE_ROWS.forEach(row=>{
      const queue = rowRacks[row] || [];
      if(pinnedRows.has(row)){
        const pinned = articles.filter(a=>forcedRowFor(a)===row).sort(placementComparator);
        const {results, usedPtr} = assignFromPool(pinned, queue, 0);
        assigned = assigned.concat(results);
        for(let i=usedPtr; i<queue.length; i++) pool.push(queue[i]); // leftover cells rejoin the general route
      } else {
        queue.forEach(cell=> pool.push(cell));
      }
    });
    const generalArticles = articles.filter(a=>!forcedRowFor(a));
    assigned = assigned.concat(assignFromPool(generalArticles, pool, 0).results);

    // Re-rank everything in true physical walking order (06→05→04→03→02→01) so
    // the "№"/queue rank shown in the UI matches the order you'd actually walk it.
    assigned.sort((a,b)=>{
      const ia = a.positions[0] ? walkIndex[`${a.positions[0].row}-${a.positions[0].rack}`] : Infinity;
      const ib = b.positions[0] ? walkIndex[`${b.positions[0].row}-${b.positions[0].rack}`] : Infinity;
      return ia - ib;
    });
    assigned.forEach((a,idx)=>{ a.rank = idx+1; });

    const abcTotals = {A:{n:0,vol:0}, B:{n:0,vol:0}, C:{n:0,vol:0}};
    assigned.forEach(a=>{ abcTotals[a.abcClass].n++; abcTotals[a.abcClass].vol += a.stockVolume; });

    recoCache = {assigned, pool, abcTotals, grandVolume, materialOrder};
    return recoCache;
  }

  function renderRecoAisleChips(){
    if(!recoCache) computeRecommendation();
    const aisles = aisleList();
    if(!recoAisle || !aisles.includes(recoAisle)) recoAisle = aisles[0];
    const box = document.getElementById('reco-aisle-chips');
    box.innerHTML = aisles.map(a=>{
      const n = addressRecords().filter(r=>r.row===a);
      const racks = new Set(n.map(r=>r.rack)).size;
      return `<button class="aisle-chip ${a===recoAisle?'active':''}" data-aisle="${a}">Ряд ${a}<span class="n">· ${racks}</span></button>`;
    }).join('');
    box.querySelectorAll('.aisle-chip').forEach(btn=>{
      btn.addEventListener('click', ()=>{ recoAisle = btn.dataset.aisle; renderRecoAisleChips(); renderStorageRangeControl(); renderRecoScheme(); });
    });
    renderStorageRangeControl();
  }

  // Editable rack-range boundary for the currently selected row's storage zone —
  // lets the zone be stretched (or shrunk) to cover more/fewer rack columns
  // instead of being stuck at the hardcoded default from STORAGE_RANGE_DEFAULT.
  function renderStorageRangeControl(){
    const box = document.getElementById('storage-range-inline');
    if(!box) return;
    if(!recoAisle || !STORAGE_RANGE[recoAisle]){ box.innerHTML = ''; return; }
    const [lo, hi] = STORAGE_RANGE[recoAisle];
    const min = rowMinRack(recoAisle), max = rowMaxRack(recoAisle);
    box.innerHTML = `
      <span class="lbl">Диапазон стеллажей зоны хранения, ряд ${recoAisle} (доступно ${min}–${max}):</span>
      <div class="grp"><span class="lbl">от</span><input type="number" class="abc-cols-input" id="range-lo-input" min="${min}" max="${max}" step="1" value="${lo}"></div>
      <div class="grp"><span class="lbl">до</span><input type="number" class="abc-cols-input" id="range-hi-input" min="${min}" max="${max}" step="1" value="${hi}"></div>
      <button type="button" class="abc-cols-inline-reset" id="storage-range-reset-btn">Сбросить ряд</button>
    `;
    function apply(){
      const loInp = document.getElementById('range-lo-input');
      const hiInp = document.getElementById('range-hi-input');
      let newLo = clampStorageBound(recoAisle, loInp.value, lo);
      let newHi = clampStorageBound(recoAisle, hiInp.value, hi);
      if(newLo > newHi){ const t = newLo; newLo = newHi; newHi = t; }
      STORAGE_RANGE[recoAisle] = [newLo, newHi];
      saveStorageRange();
      recoCache = null;
      renderReco();
    }
    box.querySelector('#range-lo-input').addEventListener('change', apply);
    box.querySelector('#range-hi-input').addEventListener('change', apply);
    box.querySelector('#storage-range-reset-btn').addEventListener('click', ()=>{
      if(STORAGE_RANGE_DEFAULT[recoAisle]) STORAGE_RANGE[recoAisle] = [...STORAGE_RANGE_DEFAULT[recoAisle]];
      saveStorageRange();
      recoCache = null;
      renderReco();
    });
  }

  function renderAbcSummary(){
    if(!recoCache) computeRecommendation();
    const t = recoCache.abcTotals;
    const colors = {A:'var(--danger)', B:'var(--multi)', C:'var(--service)'};
    const softs = {A:'#FBEAE7', B:'var(--multi-soft)', C:'var(--service-soft)'};
    const box = document.getElementById('abc-summary');
    box.innerHTML = ['A','B','C'].map(k=>{
      const share = recoCache.grandVolume>0 ? (t[k].vol/recoCache.grandVolume*100) : 0;
      return `<div class="zone-card" data-abc="${k}" style="cursor:pointer; border-color:${colors[k]};">
        <div class="name" style="color:${colors[k]};">Класс ${k}</div>
        <div class="row"><span>Артикулов</span><b>${fmtNum(t[k].n)}</b></div>
        <div class="row"><span>Доля объёма стока</span><b>${share.toFixed(1)}%</b></div>
        <div class="row"><span>Колонок на пик-лицо</span><input type="number" class="abc-cols-input" data-abc="${k}" min="${ABC_COLS_MIN}" max="${ABC_COLS_MAX}" step="1" value="${ABC_COLS[k]}"></div>
      </div>`;
    }).join('');
    box.querySelectorAll('.zone-card[data-abc]').forEach(card=>{
      card.addEventListener('click', (e)=>{
        if(e.target.closest('.abc-cols-input')) return; // don't trigger card select from the input
        recoAbcFilter = card.dataset.abc;
        const sel = document.getElementById('reco-abc-filter');
        if(sel) sel.value = recoAbcFilter;
        renderRecoTable();
        document.getElementById('reco-body').closest('.panel').scrollIntoView({behavior:'smooth', block:'start'});
      });
    });
    box.querySelectorAll('.abc-cols-input').forEach(inp=>{
      inp.addEventListener('click', e=> e.stopPropagation());
      inp.addEventListener('change', ()=>{
        const cls = inp.dataset.abc;
        ABC_COLS[cls] = clampAbcCols(inp.value);
        inp.value = ABC_COLS[cls]; // reflect clamped value
        saveAbcCols();
        recoCache = null; // force recompute with new column widths
        renderReco();
      });
    });
  }

  document.getElementById('abc-cols-reset-btn')?.addEventListener('click', ()=>{
    ABC_COLS = {...ABC_COLS_DEFAULT};
    saveAbcCols();
    recoCache = null;
    renderReco();
  });

  // Compact version of the same A/B/C column-width control, shown right above the
  // rack schema so it can be adjusted without scrolling up to the ABC-классы panel.
  function renderAbcColsInline(){
    const box = document.getElementById('abc-cols-inline');
    if(!box) return;
    const colors = {A:'var(--danger)', B:'var(--multi)', C:'var(--service)'};
    box.innerHTML = `<span class="lbl">Колонок на пик-лицо:</span>` +
      ['A','B','C'].map(k=>`
        <div class="grp">
          <span class="cls-dot" style="background:${colors[k]};"></span>
          <span class="lbl">${k}</span>
          <input type="number" class="abc-cols-input" data-abc="${k}" min="${ABC_COLS_MIN}" max="${ABC_COLS_MAX}" step="1" value="${ABC_COLS[k]}">
        </div>`).join('') +
      `<button type="button" class="abc-cols-inline-reset" id="abc-cols-inline-reset-btn">Сбросить</button>`;
    box.querySelectorAll('.abc-cols-input').forEach(inp=>{
      inp.addEventListener('change', ()=>{
        const cls = inp.dataset.abc;
        ABC_COLS[cls] = clampAbcCols(inp.value);
        inp.value = ABC_COLS[cls];
        saveAbcCols();
        recoCache = null;
        renderReco();
      });
    });
    box.querySelector('#abc-cols-inline-reset-btn')?.addEventListener('click', ()=>{
      ABC_COLS = {...ABC_COLS_DEFAULT};
      saveAbcCols();
      recoCache = null;
      renderReco();
    });
  }

  function hexToRgb(hex){
    const m = hex.replace('#','');
    return {r:parseInt(m.substr(0,2),16), g:parseInt(m.substr(2,2),16), b:parseInt(m.substr(4,2),16)};
  }
  function shade(hex, t){
    // t=0 -> original (heaviest), t=1 -> lightened toward white (lightest)
    const {r,g,b} = hexToRgb(hex);
    const nr = Math.round(r + (255-r)*t*0.78);
    const ng = Math.round(g + (255-g)*t*0.78);
    const nb = Math.round(b + (255-b)*t*0.78);
    return `rgb(${nr},${ng},${nb})`;
  }
  function withAlpha(rgbStr, alpha){
    const m = rgbStr.match(/\d+/g);
    return `rgba(${m[0]},${m[1]},${m[2]},${alpha})`;
  }

  // Full recommended scheme per aisle: level 01 = pick face (colour hue = category,
  // shade = pick order within category, heavy->light), levels above = replenishment
  // reserve for the SAME article that owns that rack's pick slot (whole rack column
  // dedicated to one article; exact per-level split is not knowable from the data).
  function renderRecoScheme(){
    if(!recoCache) computeRecommendation();
    const strip = document.getElementById('reco-strip');
    if(!recoAisle){ strip.innerHTML = '<div class="empty-note">Нет адресных ячеек в данных</div>'; return; }

    const extent = aisleExtent(recoAisle);
    if(!extent){ strip.innerHTML = '<div class="empty-note">Пусто</div>'; return; }
    const racks = extent.racks;

    let levels = LEVEL_ORDER.filter(l=>extent.levels.includes(l));
    if(!levels.includes('01')) levels = ['01', ...levels];
    levels = levels.reverse(); // same visual convention as the actual scheme tab

    const assigned = recoCache.assigned;
    const maxUnitVol = assigned.length ? (assigned[0].vol==null?1:assigned[0].vol) : 1;
    const byRack = {}; // rack -> assigned article (pick face owner for this aisle+rack)
    assigned.forEach(a=>{
      (a.positions||[]).forEach(p=>{ if(p.row===recoAisle) byRack[p.rack] = a; });
    });

    // fallback: what is actually stored at a given address today, for cells that
    // received no picking recommendation (more physical slots than articles to place)
    const actualByAddr = {};
    addressRecords().filter(r=>r.row===recoAisle).forEach(r=>{
      const key = r.rack+'|'+r.level;
      (actualByAddr[key] = actualByAddr[key] || []).push(r);
    });

    const abcRing = {A:'var(--danger)', B:'var(--multi)', C:'none'};

    const term = recoSearchTerm.trim().toLowerCase();

    let html = `<div style="display:grid; grid-template-columns:34px repeat(${racks.length}, var(--cell-size,22px)); gap:3px;">`;
    html += `<div></div>`;
    racks.forEach(rk=> html += `<div class="rack-label">${rk}</div>`);
    levels.forEach(lv=>{
      html += `<div class="level-label">${lv}</div>`;
      racks.forEach(rk=>{
        const a = byRack[rk];
        if(a){
          const t = a.vol==null ? 1 : (maxUnitVol>0 ? 1 - Math.min(1, a.vol/maxUnitVol) : 0);
          const base = shade(a.materialColor, t);
          const isPickLevel = (lv==='01');
          const bg = isPickLevel ? base : withAlpha(base, 0.32);
          const matches = term && (a.article.toLowerCase().includes(term) || a.name.toLowerCase().includes(term));
          const dim = term && !matches ? 'opacity:.2;' : '';
          const ring = matches ? `box-shadow:0 0 0 2px var(--danger);` : (isPickLevel && abcRing[a.abcClass]!=='none' ? `box-shadow:inset 0 0 0 2px ${abcRing[a.abcClass]};` : '');
          const label = isPickLevel ? `#${a.rank} · ПИКИНГ · ${a.article} · ${a.material}` : `Пополнение · ${a.article} · ${a.material} · резерв ${fmtNum(a.qty)} шт всего`;
          html += `<div class="cell" style="background:${bg}; border-color:${bg}; ${dim}${ring}" data-rack="${rk}" data-level="${lv}" data-kind="reco" title="${label} · класс ${a.abcClass}"></div>`;
          return;
        }
        const actual = actualByAddr[rk+'|'+lv];
        if(actual){
          const arts = Array.from(new Set(actual.map(i=>i.article)));
          const matches = term && actual.some(i=> i.article.toLowerCase().includes(term) || i.name.toLowerCase().includes(term));
          const dim = term && !matches ? 'opacity:.2;' : '';
          const ring = matches ? 'box-shadow:0 0 0 2px var(--danger);' : '';
          const cls = arts.length>1 ? 'multi' : 'filled';
          html += `<div class="cell ${cls}" style="${dim}${ring}" data-rack="${rk}" data-level="${lv}" data-kind="actual" title="Без рекомендации · сейчас: ${actual[0].article} · ${actual.length>1?'+ ещё '+(actual.length-1):''}"></div>`;
          return;
        }
        html += `<div class="cell"></div>`;
      });
    });
    html += `</div>`;
    strip.innerHTML = html;

    strip.querySelectorAll('.cell[data-rack]').forEach(el=>{
      el.addEventListener('click', ()=>{
        const rk = parseInt(el.dataset.rack,10), lv = el.dataset.level;
        const addr = `${recoAisle}-${zpad(rk)}-${lv}`;
        if(el.dataset.kind==='reco'){
          const a = byRack[rk];
          if(!a) return;
          const role = lv==='01' ? `Пикинг (очередь #${a.rank})` : 'Пополнение / резерв';
          openDrawer(addr, [{article:a.article, name:a.name, qty:a.qty, mfg:'', exp:`${role} · ${a.material} · ${a.category} · класс ABC: ${a.abcClass} (${a.volShare.toFixed(1)}% объёма стока) · колонок на пик-лицо: ${(a.positions||[]).length || 1}`}]);
        } else {
          const actual = actualByAddr[rk+'|'+lv];
          if(!actual) return;
          openDrawer(addr, actual.map(it=>({article:it.article, name:it.name, qty:it.qty, mfg:it.mfg, exp:`Без пикинг-рекомендации · факт. остаток ${fmtNum(it.qty)} шт · срок годности: ${it.exp||'—'}`})));
        }
      });
    });
  }

  function renderRecoTable(){
    if(!recoCache) computeRecommendation();
    let rows = recoCache.assigned;
    const term = recoSearchTerm.trim().toLowerCase();
    if(term){
      rows = rows.filter(r=> r.article.toLowerCase().includes(term) || r.name.toLowerCase().includes(term));
    }
    if(recoAbcFilter!=='all') rows = rows.filter(r=>r.abcClass===recoAbcFilter);
    if(recoMaterialFilter!=='all') rows = rows.filter(r=>r.material===recoMaterialFilter);
    document.getElementById('reco-count').textContent = `${fmtNum(rows.length)} артикулов`;
    const MAX = 400;
    const shown = rows.slice(0, MAX);
    const abcBadgeClass = {A:'multi', B:'multi', C:'service'};
    document.getElementById('reco-body').innerHTML = shown.map(r=>`
      <tr>
        <td>${r.rank}</td>
        <td class="article">${r.article}</td>
        <td>${r.name}</td>
        <td><span style="display:inline-flex;align-items:center;gap:5px;"><i class="swatch" style="background:${r.materialColor};"></i>${r.material}</span></td>
        <td>${r.vol!=null ? r.vol+' л/кг' : '—'}</td>
        <td>${fmtNum(r.qty)}</td>
        <td>${r.volShare.toFixed(1)}%</td>
        <td><span class="badge ${r.abcClass==='A'?'service':abcBadgeClass[r.abcClass]}" style="${r.abcClass==='A'?'background:#FBEAE7;color:var(--danger);':''}">${r.abcClass}</span></td>
        <td class="cellcode">${r.pickAddress || '<span class="badge service">нет свободного адреса</span>'}</td>
        <td class="cellcode" style="color:var(--ink-soft);">${r.replenish || '—'}</td>
      </tr>
    `).join('') + (rows.length>MAX ? `<tr><td colspan="10" style="text-align:center;color:var(--ink-soft);padding:14px;">Показаны первые ${MAX} из ${fmtNum(rows.length)} — уточните поиск</td></tr>` : '');
  }

  function renderRecoCategoryLegend(){
    if(!recoCache) computeRecommendation();
    const box = document.getElementById('category-legend');
    box.innerHTML = recoCache.materialOrder.map(c=>
      `<span><i class="swatch" style="background:${MATERIAL_COLORS[c]||'#64748B'};"></i>${c}</span>`
    ).join('');
    const filterSel = document.getElementById('reco-category-filter');
    filterSel.innerHTML = `<option value="all">Все материалы</option>` +
      recoCache.materialOrder.map(c=>`<option value="${c}">${c}</option>`).join('');
    filterSel.value = recoMaterialFilter;
  }


  let recoAbcFilter = 'all';
  let recoMaterialFilter = 'all';

  // Recommended physical separation for service-zone stock: each status becomes its
  // own dedicated zone (never mixed), ordered isolation-critical zones first (quarantine,
  // customer-return/defect), then by size (bigger zones need to be allocated first).
  const ISOLATION_KEYWORDS = ['КАРАНТИН','БРАК','ВОЗВРАТ'];
  function isIsolationZone(name){
    const n = name.toUpperCase();
    return ISOLATION_KEYWORDS.some(k=>n.includes(k));
  }
  function renderServiceZoneReco(){
    const svc = serviceRecords();
    const groups = {};
    svc.forEach(r=>{
      if(!groups[r.cell]) groups[r.cell] = {name:r.cell, items:[], qty:0};
      groups[r.cell].items.push(r);
      groups[r.cell].qty += r.qty;
    });
    const zones = Object.values(groups).map(z=>({...z, isolate:isIsolationZone(z.name), arts:new Set(z.items.map(i=>i.article)).size}));
    zones.sort((a,b)=>{
      if(a.isolate !== b.isolate) return a.isolate ? -1 : 1;
      return b.qty - a.qty;
    });
    const box = document.getElementById('svc-reco-grid');
    box.innerHTML = zones.map((z,idx)=>`
      <div class="zone-card" data-zone="${z.name}" style="cursor:pointer; ${z.isolate?'border-color:var(--danger);':''}">
        <div class="name" style="${z.isolate?'color:var(--danger);':''}">Зона ${idx+1} · ${z.name}</div>
        <div class="row"><span>Статус</span><b>${z.isolate?'изолированная':'рабочая'}</b></div>
        <div class="row"><span>Артикулов</span><b>${fmtNum(z.arts)}</b></div>
        <div class="row"><span>Остаток, шт</span><b>${fmtNum(z.qty)}</b></div>
      </div>
    `).join('');
    box.querySelectorAll('.zone-card[data-zone]').forEach(card=>{
      card.addEventListener('click', ()=>{
        const z = zones.find(x=>x.name===card.dataset.zone);
        if(!z) return;
        openDrawer(z.name, z.items.slice(0,80).map(it=>({article:it.article, name:it.name, qty:it.qty, mfg:it.mfg, exp:it.exp})));
      });
    });
  }

  function renderReco(){
    computeRecommendation();
    renderAbcSummary();
    renderAbcColsInline();
    renderRecoCategoryLegend();
    renderRecoAisleChips();
    renderRecoScheme();
    renderRecoTable();
    renderServiceZoneReco();
  }

  document.getElementById('reco-search').addEventListener('input', (e)=>{
    recoSearchTerm = e.target.value; renderRecoScheme(); renderRecoTable();
  });
  document.getElementById('reco-abc-filter').addEventListener('change', (e)=>{
    recoAbcFilter = e.target.value; renderRecoTable();
  });
  document.getElementById('reco-category-filter').addEventListener('change', (e)=>{
    recoMaterialFilter = e.target.value; renderRecoTable();
  });

  // ---------- ZONES VIEW ----------
  function renderZones(){
    const svc = serviceRecords();
    const itemsByZone = {};
    svc.forEach(r=>{ (itemsByZone[r.cell] = itemsByZone[r.cell] || []).push(r); });

    const box = document.getElementById('zones-grid');
    const zones = state.zones.length ? state.zones : Object.keys(itemsByZone).map(name=>({name, isolate:0, records:itemsByZone[name].length, qty:itemsByZone[name].reduce((s,i)=>s+i.qty,0), articles:new Set(itemsByZone[name].map(i=>i.article)).size}));

    box.innerHTML = zones.map(z=>`
      <div class="zone-card" data-zone="${z.name}" style="${z.isolate?'border-color:var(--danger);':''}">
        <div class="zc-actions">
          <button class="zc-edit" data-zone="${z.name}" title="Переименовать / изоляция">✏</button>
          <button class="zc-del" data-zone="${z.name}" title="Удалить зону">🗑</button>
        </div>
        <div class="name" style="${z.isolate?'color:var(--danger);':''}">${z.name}${z.isolate?' · изолир.':''}</div>
        <div class="row"><span>Строк</span><b>${fmtNum(z.records)}</b></div>
        <div class="row"><span>Артикулов</span><b>${fmtNum(z.articles)}</b></div>
        <div class="row"><span>Всего, шт</span><b>${fmtNum(z.qty)}</b></div>
      </div>
    `).join('') || `<div class="empty-note">Зон пока нет — нажмите «+ Добавить зону»</div>`;

    box.querySelectorAll('.zone-card').forEach(card=>{
      card.addEventListener('click', (e)=>{
        if(e.target.closest('.zc-actions')) return;
        const items = itemsByZone[card.dataset.zone] || [];
        openDrawer(card.dataset.zone, items.slice(0,50));
      });
    });
    box.querySelectorAll('.zc-edit').forEach(btn=>{
      btn.addEventListener('click', (e)=>{ e.stopPropagation(); openZoneEditForm(btn.dataset.zone); });
    });
    box.querySelectorAll('.zc-del').forEach(btn=>{
      btn.addEventListener('click', async (e)=>{
        e.stopPropagation();
        const name = btn.dataset.zone;
        const z = zones.find(x=>x.name===name);
        let force = false;
        if(z && z.records>0){
          if(!confirm(`В зоне «${name}» ещё ${z.records} записей (${fmtNum(z.qty)} шт). Удалить зону вместе со всем содержимым?`)) return;
          force = true;
        } else if(!confirm(`Удалить пустую зону «${name}»?`)){
          return;
        }
        progressStart('Удаление зоны…');
        try{
          const res = await fetch(`${API_BASE}/api/zones/${encodeURIComponent(name)}?force=${force}`, {method:'DELETE'});
          const payload = await res.json().catch(()=>({}));
          if(!res.ok) throw new Error(payload.error || ('HTTP '+res.status));
          await fetchRecords(); renderAll();
          setSyncStatus(`зона «${name}» удалена · ` + new Date().toLocaleTimeString('ru-RU'));
        }catch(err){
          alert('Не удалось удалить зону: ' + err.message);
        } finally { progressEnd(); }
      });
    });
  }

  // ---------- ADD / EDIT ZONE ----------
  function openAddZoneForm(){
    const body = `
      <div class="form-field" style="margin-bottom:12px;">
        <label>Название зоны</label>
        <input id="zone-name-input" type="text" placeholder="напр. Возврат поставщику">
      </div>
      <label style="display:flex; align-items:center; gap:8px; font-size:13px; cursor:pointer;">
        <input id="zone-isolate-input" type="checkbox"> Изолированная зона (как Карантин, Брак)
      </label>
      <div class="form-error" id="zone-error"></div>
    `;
    const footer = `<button class="btn" id="zone-cancel">Отмена</button><button class="btn primary" id="zone-save">Создать</button>`;
    openModal('Новая служебная зона', body, footer);
    document.getElementById('zone-cancel').addEventListener('click', closeModal);
    document.getElementById('zone-save').addEventListener('click', async ()=>{
      const errEl = document.getElementById('zone-error');
      const name = document.getElementById('zone-name-input').value.trim();
      const isolate = document.getElementById('zone-isolate-input').checked;
      if(!name){ errEl.textContent='Укажите название.'; errEl.classList.add('show'); return; }
      progressStart('Создание зоны…');
      try{
        const res = await fetch(`${API_BASE}/api/zones`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name, isolate})});
        const payload = await res.json().catch(()=>({}));
        if(!res.ok) throw new Error(payload.error || ('HTTP '+res.status));
        closeModal();
        await fetchRecords(); renderAll();
        setSyncStatus(`зона «${name}» создана · ` + new Date().toLocaleTimeString('ru-RU'));
      }catch(err){
        errEl.textContent = err.message; errEl.classList.add('show');
      } finally { progressEnd(); }
    });
  }

  function openZoneEditForm(zoneName){
    const z = state.zones.find(x=>x.name===zoneName) || {name:zoneName, isolate:0};
    const body = `
      <div class="form-field" style="margin-bottom:12px;">
        <label>Название зоны</label>
        <input id="zone-rename-input" type="text" value="${z.name}">
      </div>
      <label style="display:flex; align-items:center; gap:8px; font-size:13px; cursor:pointer;">
        <input id="zone-isolate-edit" type="checkbox" ${z.isolate?'checked':''}> Изолированная зона (как Карантин, Брак)
      </label>
      <div class="form-error" id="zone-error"></div>
    `;
    const footer = `<button class="btn" id="zone-cancel">Отмена</button><button class="btn primary" id="zone-save">Сохранить</button>`;
    openModal(`Зона «${zoneName}»`, body, footer);
    document.getElementById('zone-cancel').addEventListener('click', closeModal);
    document.getElementById('zone-save').addEventListener('click', async ()=>{
      const errEl = document.getElementById('zone-error');
      const newName = document.getElementById('zone-rename-input').value.trim();
      const isolate = document.getElementById('zone-isolate-edit').checked;
      if(!newName){ errEl.textContent='Укажите название.'; errEl.classList.add('show'); return; }
      progressStart('Сохранение зоны…');
      try{
        const res = await fetch(`${API_BASE}/api/zones/${encodeURIComponent(zoneName)}`, {
          method:'PATCH', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ newName: newName!==zoneName?newName:undefined, isolate })
        });
        const payload = await res.json().catch(()=>({}));
        if(!res.ok) throw new Error(payload.error || ('HTTP '+res.status));
        closeModal();
        await fetchRecords(); renderAll();
        setSyncStatus(`зона обновлена · ` + new Date().toLocaleTimeString('ru-RU'));
      }catch(err){
        errEl.textContent = err.message; errEl.classList.add('show');
      } finally { progressEnd(); }
    });
  }

  document.getElementById('add-zone-btn').addEventListener('click', openAddZoneForm);

  // ---------- MOVE ROW/RACK/CELL INTO A ZONE ----------
  function openMoveToZoneForm(){
    if(!state.zones.length){ alert('Сначала создайте хотя бы одну зону.'); return; }
    let srcType = 'row';
    let pickedCell = '';

    function fieldsHtml(){
      const aisles = aisleList();
      if(srcType==='row'){
        return `<div class="form-field"><label>Ряд</label>
          <select id="mz-row">${aisles.map(a=>`<option value="${a}">Ряд ${a}</option>`).join('')}</select>
        </div>`;
      }
      if(srcType==='rack'){
        const row = aisles[0];
        const extent = row ? aisleExtent(row) : null;
        const racks = extent ? extent.racks : [];
        return `<div class="form-grid">
          <div class="form-field"><label>Ряд</label>
            <select id="mz-row">${aisles.map(a=>`<option value="${a}">Ряд ${a}</option>`).join('')}</select>
          </div>
          <div class="form-field"><label>Стеллаж</label>
            <select id="mz-rack">${racks.map(r=>`<option value="${r}">${r}</option>`).join('')}</select>
          </div>
        </div>`;
      }
      return `<div class="form-field with-pin">
        <div><label>Ячейка</label><input id="mz-cell" type="text" placeholder="напр. 01-12-02" value="${pickedCell}"></div>
        <button class="pin-btn" id="mz-cell-pick" style="height:34px;">📍</button>
      </div>`;
    }

    function renderBody(){
      const body = `
        <div class="form-field" style="margin-bottom:14px;">
          <label>Что переносим</label>
          <select id="mz-type">
            <option value="row" ${srcType==='row'?'selected':''}>Весь ряд</option>
            <option value="rack" ${srcType==='rack'?'selected':''}>Стеллаж</option>
            <option value="cell" ${srcType==='cell'?'selected':''}>Одну ячейку</option>
          </select>
        </div>
        <div id="mz-fields" style="margin-bottom:14px;">${fieldsHtml()}</div>
        <div class="form-field">
          <label>Куда (зона)</label>
          <select id="mz-zone">${state.zones.map(z=>`<option value="${z.name}">${z.name}</option>`).join('')}</select>
        </div>
        <div class="form-error" id="mz-error"></div>
      `;
      const footer = `<button class="btn" id="mz-cancel">Отмена</button><button class="btn primary" id="mz-submit">Перенести</button>`;
      openModal('Перенести в служебную зону', body, footer);

      document.getElementById('mz-type').addEventListener('change', (e)=>{ srcType = e.target.value; renderBody(); });
      document.getElementById('mz-cancel').addEventListener('click', closeModal);
      if(srcType==='row'){
        document.getElementById('mz-row').addEventListener('change', ()=>{}); // no-op, just keep selection
      }
      if(srcType==='rack'){
        const rowSel = document.getElementById('mz-row');
        rowSel.addEventListener('change', ()=>{
          const extent = aisleExtent(rowSel.value);
          document.getElementById('mz-rack').innerHTML = (extent?extent.racks:[]).map(r=>`<option value="${r}">${r}</option>`).join('');
        });
      }
      if(srcType==='cell'){
        document.getElementById('mz-cell-pick').addEventListener('click', ()=>{
          openCellPicker((addr)=>{ pickedCell = addr; renderBody(); }, pickedCell);
        });
      }

      document.getElementById('mz-submit').addEventListener('click', async ()=>{
        const errEl = document.getElementById('mz-error');
        const zone = document.getElementById('mz-zone').value;
        let ids = [];
        if(srcType==='row'){
          const row = document.getElementById('mz-row').value;
          ids = addressRecords().filter(r=>r.row===row).map(r=>r.id);
        } else if(srcType==='rack'){
          const row = document.getElementById('mz-row').value;
          const rack = parseInt(document.getElementById('mz-rack').value,10);
          ids = addressRecords().filter(r=>r.row===row && r.rack===rack).map(r=>r.id);
        } else {
          const cell = document.getElementById('mz-cell').value.trim();
          ids = state.records.filter(r=>r.cell===cell).map(r=>r.id);
        }
        if(!ids.length){ errEl.textContent='В выбранном месте сейчас нет товара — переносить нечего.'; errEl.classList.add('show'); return; }
        progressStart(`Перенос ${ids.length} записей в «${zone}»…`);
        try{
          const res = await fetch(`${API_BASE}/api/records/bulk-move`, {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ ids, cell: zone })
          });
          const payload = await res.json().catch(()=>({}));
          if(!res.ok) throw new Error(payload.error || ('HTTP '+res.status));
          closeModal();
          await fetchRecords(); renderAll();
          setSyncStatus(`перенесено ${payload.moved} записей в «${zone}» · ` + new Date().toLocaleTimeString('ru-RU'));
        }catch(err){
          errEl.textContent = err.message; errEl.classList.add('show');
        } finally { progressEnd(); }
      });
    }

    renderBody();
  }

  document.getElementById('move-to-zone-btn').addEventListener('click', openMoveToZoneForm);

  // ---------- TABS ----------
  document.querySelectorAll('nav.tabs button').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('nav.tabs button').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
      document.getElementById('view-'+btn.dataset.view).classList.add('active');
    });
  });

  // ---------- SEARCH BINDINGS ----------
  document.getElementById('map-search').addEventListener('input', (e)=>{
    mapFilterTerm = e.target.value; renderGrid(); renderAisleChips();
    // Введённый (в т.ч. набранный сканером как "клавиатура") код, точно
    // совпавший с артикулом, ячейкой или ТЕ, сразу переносит на нужный ряд
    // и подсвечивает ячейку — не дожидаясь Enter.
    const val = e.target.value.trim();
    if(val.length >= 3){
      const lc = val.toLowerCase();
      const exact = addressRecords().some(r =>
        r.article.toLowerCase() === lc || r.cell.toLowerCase() === lc || (r.te && r.te.toLowerCase() === lc)
      );
      if(exact) jumpOnMap(val);
    }
  });
  document.getElementById('map-search').addEventListener('keydown', (e)=>{
    if(e.key !== 'Enter') return;
    e.preventDefault();
    const val = e.target.value.trim();
    if(!val) return;
    if(!jumpOnMap(val)) alert(`На схеме склада не найдено: «${val}»`);
  });
  document.getElementById('table-search').addEventListener('input', (e)=>{
    tableTerm = e.target.value; renderTable();
  });
  document.getElementById('table-filter').addEventListener('change', (e)=>{
    tableFilter = e.target.value; renderTable();
  });
  const categoryDropdown = document.getElementById('category-filter-dropdown');
  document.getElementById('category-filter-toggle').addEventListener('click', (e)=>{
    e.stopPropagation();
    categoryDropdown.classList.toggle('open');
  });
  document.addEventListener('click', (e)=>{
    if(categoryDropdown.classList.contains('open') && !categoryDropdown.contains(e.target)){
      categoryDropdown.classList.remove('open');
    }
  });
  document.querySelectorAll('#view-table thead th.sortable').forEach(th=>{
    th.addEventListener('click', ()=>{
      const field = th.dataset.sort;
      if(tableSort.field === field){
        tableSort.dir = tableSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        tableSort = { field, dir: 'asc' };
      }
      renderTable();
    });
  });

  // ---------- DB ACTIONS DROPDOWN (import + export grouped together) ----------
  const dbDropdown = document.getElementById('db-actions-dropdown');
  document.getElementById('db-actions-toggle').addEventListener('click', (e)=>{
    e.stopPropagation();
    dbDropdown.classList.toggle('open');
  });
  document.addEventListener('click', (e)=>{
    if(dbDropdown.classList.contains('open') && !dbDropdown.contains(e.target)){
      dbDropdown.classList.remove('open');
    }
  });
  document.getElementById('export-btn').addEventListener('click', ()=> dbDropdown.classList.remove('open'));
  // note: file-input's own change handler closes the menu once a file is picked (see below)

  // ---------- FILE UPLOAD (sent to the server — replaces the DB for everyone) ----------
  document.getElementById('file-input').addEventListener('change', async (e)=>{
    dbDropdown.classList.remove('open');
    const file = e.target.files[0];
    if(!file) return;
    setSyncStatus('загрузка файла на сервер…');
    progressStart(`Загрузка ${file.name}… 0%`);
    try{
      const form = new FormData();
      form.append('file', file);
      const payload = await new Promise((resolve, reject)=>{
        const xhr = new XMLHttpRequest();
        xhr.open('POST', API_BASE + '/api/import');
        xhr.upload.addEventListener('progress', (ev)=>{
          if(ev.lengthComputable){
            const pct = ev.loaded/ev.total*100;
            progressSet(pct, `Загрузка ${file.name}… ${Math.round(pct)}%`);
          }
        });
        xhr.onload = ()=>{
          let data = {};
          try{ data = JSON.parse(xhr.responseText); }catch(_){}
          if(xhr.status>=200 && xhr.status<300) resolve(data);
          else reject(new Error(data.error || ('HTTP '+xhr.status)));
        };
        xhr.onerror = ()=> reject(new Error('сетевая ошибка при загрузке'));
        xhr.send(form);
      });
      progressSet(100, 'Обработка на сервере…');
      currentAisle = null; recoAisle = null;
      await fetchRecords();
      renderAll();
      setSyncStatus(`загружено ${fmtNum(payload.imported)} строк · ${state.lastSync.toLocaleTimeString('ru-RU')}`);
    }catch(err){
      setSyncStatus('ошибка загрузки', true);
      alert('Не удалось загрузить файл на сервер: '+err.message);
    }finally{
      e.target.value = '';
      progressEnd();
    }
  });

  // ---------- EXPORT (server builds the .xlsx from the current database state) ----------
  document.getElementById('export-btn').addEventListener('click', async ()=>{
    progressStart('Формирование файла на сервере…');
    try{
      const res = await fetch(API_BASE + '/api/export');
      if(!res.ok) throw new Error('HTTP '+res.status);
      const total = parseInt(res.headers.get('Content-Length')||'0', 10);
      const reader = res.body ? res.body.getReader() : null;
      let filename = 'адресное_хранение.xlsx';
      const disp = res.headers.get('Content-Disposition') || '';
      const starMatch = disp.match(/filename\*=UTF-8''([^;]+)/i);
      if(starMatch) filename = decodeURIComponent(starMatch[1]);

      let blob;
      if(reader && total){
        const chunks = [];
        let received = 0;
        while(true){
          const {done, value} = await reader.read();
          if(done) break;
          chunks.push(value);
          received += value.length;
          progressSet(received/total*100, `Скачивание… ${Math.round(received/total*100)}%`);
        }
        blob = new Blob(chunks, {type: res.headers.get('Content-Type')||'application/octet-stream'});
      } else {
        blob = await res.blob(); // fallback if streaming isn't available
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(()=>URL.revokeObjectURL(url), 2000);
      setSyncStatus('экспорт скачан · ' + new Date().toLocaleTimeString('ru-RU'));
    }catch(err){
      setSyncStatus('ошибка экспорта', true);
      alert('Не удалось скачать экспорт: ' + err.message);
    } finally {
      progressEnd();
    }
  });

  // ---------- MANUAL / PERIODIC SYNC ----------
  document.getElementById('sync-btn').addEventListener('click', ()=> syncFromServer(true));

  // Poll for changes made by other users, but don't yank the table out from under
  // someone who is mid-edit (an input is focused) or looking at a cell's detail drawer.
  setInterval(()=>{
    const active = document.activeElement;
    const isEditing = active && active.classList && active.classList.contains('edit-input');
    const drawerOpen = document.getElementById('drawer').classList.contains('open');
    if(!isEditing && !drawerOpen) syncFromServer(false);
  }, 60000);

  // ---------- MASTER RENDER ----------
  function renderAll(){
    recoCache = null;
    renderStats();
    renderAisleChips();
    renderGrid();
    renderTable();
    renderZones();
    renderReco();
  }

  // ---------- BOOTSTRAP ----------
  (async function init(){
    await syncFromServer(true);
  })();
})();

// Theme Toggle Logic
const themeToggleBtn = document.getElementById('theme-toggle-btn');
const currentTheme = localStorage.getItem('theme') || 'light';

if (currentTheme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
    if(themeToggleBtn) themeToggleBtn.textContent = '☀️';
}

if(themeToggleBtn) {
    themeToggleBtn.addEventListener('click', () => {
        const theme = document.documentElement.getAttribute('data-theme');
        if (theme === 'dark') {
            document.documentElement.removeAttribute('data-theme');
            localStorage.setItem('theme', 'light');
            themeToggleBtn.textContent = '🌙';
        } else {
            document.documentElement.setAttribute('data-theme', 'dark');
            localStorage.setItem('theme', 'dark');
            themeToggleBtn.textContent = '☀️';
        }
    });
}

