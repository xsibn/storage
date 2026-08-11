(function(){
  "use strict";

  const API_BASE = ""; // same-origin: server serves both the API and this page

  // Background polling (sync, badges) must not hit the API before login —
  // otherwise every interval tick 401s while the auth screen is open, and
  // auth.js's 401-interceptor yanks the person back to the login card even
  // if they're filling out the registration form. Flips to true once
  // window.__whenAuthed resolves.
  let isAuthed = false;
  if (window.__whenAuthed) window.__whenAuthed.then(() => { isAuthed = true; });

  const state = {
    records: [],   // {id, cell, article, name, qty, mfg, exp, isService, row, rack, level}
    sourceLabel: "подключение…",
    lastSync: null,
    layout: {},    // {row: {minRack, maxRack, levels}} — full known warehouse structure
    abcClasses: {}, // {article: 'A'|'B'|'C'} — fixed classification, not computed
    barcodeCatalog: [], // [{article, barcode, name}] — справочник ВГХ (реальные штрихкоды товара)
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

  // ---------- CONNECTION STATUS (online / offline indicator) ----------
  // Independent of setSyncStatus above (which shows the *last action*, e.g.
  // "сохранено 18:17:34"). This dot+label always reflects whether we can
  // currently reach the server, based on the continuous background sync.
  let connState = 'connecting'; // 'online' | 'offline' | 'connecting'

  function setConnStatus(nextState, detail){
    connState = nextState;
    const dot = document.getElementById('conn-dot');
    const label = document.getElementById('conn-text');
    if(dot) dot.classList.remove('online','offline','connecting');
    if(dot) dot.classList.add(nextState);
    if(label){
      if(nextState === 'online') label.textContent = 'онлайн' + (detail ? ' · ' + detail : '');
      else if(nextState === 'offline') label.textContent = 'офлайн · нет связи с сервером' + (detail ? ' · ' + detail : '');
      else label.textContent = 'подключение…';
    }
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
    state.barcodeCatalog = data.meta.barcodeCatalog || [];
    rebuildBarcodeCatalogIndex();
    state.zones = data.meta.zones || [];
    state.lastSync = new Date();
    // Storage-range / ABC-column settings live server-side (see /api/settings)
    // so they're the same on every device, not stuck in this browser's
    // localStorage. Only apply them if this is the first load or nothing has
    // been changed locally since — applySettingsFromServer() handles merging.
    applySettingsFromServer(data.meta.storageRange, data.meta.abcCols, data.meta.pickRowOrder, data.meta.halfBottleRow);
  }

  async function syncFromServer(showAlert){
    try{
      if(showAlert){
        setSyncStatus('синхронизация…');
        await withProgress('Синхронизация…', fetchRecords);
      } else {
        await fetchRecords();
      }
      renderAll();
      const time = state.lastSync.toLocaleTimeString('ru-RU');
      if(showAlert) setSyncStatus('обновлено ' + time);
      setConnStatus('online', 'обновлено ' + time);
    }catch(err){
      if(showAlert) setSyncStatus('нет связи с сервером', true);
      setConnStatus('offline');
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

  // A handheld scanner (ТСД) just "types" the raw decoded string into whatever
  // field has focus and sends Enter — unlike the camera scanner, it doesn't
  // tell us which symbology it read. Different symbologies can encode the
  // exact same article under different-looking strings:
  //  - UPC-A (12 digits) is the same number as EAN-13 with a leading zero
  //  - GTIN-14 (14 digits, used by ITF-14/some GS1 labels) is EAN-13 with two
  //    leading zeros, or is itself zero-padded
  //  - GS1-128 / GS1 DataBar scans often carry an AI prefix, e.g. "(01)" or
  //    raw "01" before the 14-digit GTIN, sometimes with an AIM symbology ID
  //    like "]C1" glued on the front by the scanner's driver
  // so a single strict `===` against the stored article silently misses scans
  // that decode "correctly" but in a different (still valid) representation.
  // This expands one scanned string into every equivalent form worth trying.
  // Справочник ВГХ (весогабаритных характеристик) хранит настоящие
  // штрихкоды товара (base/группа1/группа2), а не только артикул. Строим
  // индекс "штрихкод -> артикул" один раз при загрузке/синхронизации данных,
  // чтобы сканер и любой ручной ввод могли перевести реальный штрихкод в
  // артикул склада, даже если сам штрихкод нигде в stock_records не хранится.
  let barcodeToArticle = new Map();
  function rebuildBarcodeCatalogIndex(){
    barcodeToArticle = new Map();
    (state.barcodeCatalog || []).forEach(row => {
      if(!row.barcode || !row.article) return;
      barcodeToArticle.set(String(row.barcode), String(row.article));
    });
  }

  function barcodeCandidates(raw){
    let s = String(raw || '');
    s = s.replace(/^\]\w\d/, '');   // strip AIM symbology identifier, e.g. "]C1", "]E0"
    s = s.replace(/[\x1D\x1C\x1E]/g, ''); // strip GS1 FNC1/segment separators some drivers emit
    const trimmed = s.trim();
    const candidates = new Set();
    if(trimmed) candidates.add(trimmed);

    // GS1 Application Identifier 01 = GTIN-14, sometimes wrapped in parens
    const aiMatch = trimmed.match(/\(?01\)?(\d{14})/);
    if(aiMatch) candidates.add(aiMatch[1]);

    const digitsOnly = trimmed.replace(/\D/g, '');
    if(digitsOnly) candidates.add(digitsOnly);

    Array.from(candidates).forEach(code=>{
      if(!/^\d+$/.test(code)) return;
      // GTIN-14 <-> EAN-13 <-> UPC-A: each strips one more leading zero
      if(code.length === 14 && code.startsWith('0')) candidates.add(code.slice(1));
      if(code.length === 13 && code.startsWith('0')) candidates.add(code.slice(1));
      // going the other way: pad a shorter code up in case the article is
      // stored in its longer zero-padded form
      if(code.length === 12) candidates.add('0'+code);
      if(code.length === 13) candidates.add('0'+code);
    });

    // Сверяем каждый вариант кода со справочником ВГХ (артикул ↔ штрихкод):
    // если отсканированный/введённый код — это реальный штрихкод товара
    // (EAN/UPC/GS1 и т.п.), а не сам артикул, добавляем в кандидаты ещё и
    // соответствующий артикул — дальше он ищется в stock_records как обычно.
    Array.from(candidates).forEach(code=>{
      const article = barcodeToArticle.get(code);
      if(article) candidates.add(article);
    });
    return Array.from(candidates);
  }

  // Match a typed/scanned code against address cells only (schema search), same
  // priority as findRecordsByCode below: exact article/cell/ТЕ first (tried
  // against every EAN/UPC/GS1 variant of the scanned code), then a
  // case-insensitive exact match, then a loose "contains" fallback.
  function findAddressMatches(term){
    const c = String(term || '').trim();
    if(!c) return [];
    const candidates = barcodeCandidates(c);
    const lcCandidates = candidates.map(x=>x.toLowerCase());
    const lc = c.toLowerCase();
    let matches = addressRecords().filter(r =>
      candidates.includes(r.article) || candidates.includes(r.cell) || (r.te && candidates.includes(r.te))
    );
    if(!matches.length){
      matches = addressRecords().filter(r =>
        lcCandidates.includes(r.article.toLowerCase()) || lcCandidates.includes(r.cell.toLowerCase()) ||
        (r.te && lcCandidates.includes(r.te.toLowerCase()))
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
    if(!(await confirmDialog(`Удалить выбранные ряды (${rows.join(', ')})? Это возможно только для рядов без товара. Действие необратимо.`, { title: 'Удаление рядов', okLabel: 'Удалить', danger: true }))) return;
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
    const ok = await confirmDialog(
      `Поменять местами весь товар ряда ${rowA} и ряда ${rowB}? Это затронет все ячейки обоих рядов и сохранится сразу для всех.`,
      { title: 'Обмен рядами', okLabel: 'Поменять местами', icon: '⇄' }
    );
    if(!ok) return;
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
    const ok = await confirmDialog(
      `Поменять местами стеллаж ${rackA} и стеллаж ${rackB} в ряду ${row}? Затронет все ярусы обоих стеллажей.`,
      { title: 'Обмен стеллажами', okLabel: 'Поменять местами', icon: '⇄' }
    );
    if(!ok) return;
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
        const candLower = term ? barcodeCandidates(mapFilterTerm.trim()).map(x=>x.toLowerCase()) : [];
        const matches = term && (
          items.some(i=> candLower.includes(i.article.toLowerCase()) || (i.te && candLower.includes(i.te.toLowerCase())) ||
            i.article.toLowerCase().includes(term) || i.cell.toLowerCase().includes(term) || i.name.toLowerCase().includes(term) || (i.te && i.te.toLowerCase().includes(term)))
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

  // ---------- КАСТОМНОЕ ОКНО ПОДТВЕРЖДЕНИЯ (замена confirm()) ----------
  // confirmDialog(text, {title, okLabel, cancelLabel, danger}) → Promise<boolean>.
  // Отдельный оверлей поверх #modal-backdrop (z-index выше), поэтому спокойно
  // работает и как самостоятельное окно, и поверх уже открытой модалки.
  const confirmBackdropEl = document.getElementById('confirm-backdrop');
  const confirmBoxEl = document.getElementById('confirm-box');
  const confirmTitleEl = document.getElementById('confirm-title');
  const confirmTextEl = document.getElementById('confirm-text');
  const confirmOkBtn = document.getElementById('confirm-ok-btn');
  const confirmCancelBtn = document.getElementById('confirm-cancel-btn');
  let confirmResolve = null;
  function settleConfirm(result){
    if(!confirmResolve) return;
    confirmBackdropEl.classList.remove('open');
    const resolve = confirmResolve;
    confirmResolve = null;
    resolve(result);
  }
  function confirmDialog(text, opts){
    opts = opts || {};
    return new Promise(resolve => {
      confirmResolve = resolve;
      confirmTitleEl.textContent = opts.title || 'Подтверждение';
      confirmTextEl.textContent = text;
      confirmOkBtn.textContent = opts.okLabel || 'ОК';
      confirmCancelBtn.textContent = opts.cancelLabel || 'Отмена';
      confirmIconEl.textContent = opts.icon || (opts.danger ? '⚠' : '❔');
      confirmBoxEl.classList.toggle('danger', !!opts.danger);
      confirmBackdropEl.classList.add('open');
      confirmOkBtn.focus();
    });
  }
  const confirmIconEl = document.getElementById('confirm-icon');
  confirmOkBtn.addEventListener('click', ()=> settleConfirm(true));
  confirmCancelBtn.addEventListener('click', ()=> settleConfirm(false));
  confirmBackdropEl.addEventListener('click', (e)=>{
    if(e.target.id==='confirm-backdrop') settleConfirm(false);
  });
  document.addEventListener('keydown', (e)=>{
    if(!confirmBackdropEl.classList.contains('open')) return;
    if(e.key==='Escape') settleConfirm(false);
    else if(e.key==='Enter') settleConfirm(true);
  });

  function escHtml(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  // ---------- СПРАВКА (кнопка «❓» в шапке) ----------
  // Короткая памятка по функциям текущего раздела — не документация, а
  // напоминание «что тут вообще есть», на случай если кнопка не очевидна
  // с первого взгляда. Содержимое подставляется по активной вкладке.
  const HELP_CONTENT = {
    map: {
      title: 'Справка · Схема склада',
      items: [
        'Клик по ячейке — карточка адреса со всем, что в ней лежит.',
        'Перетащите товар из одной ячейки в другую, чтобы переместить его (на телефоне — кнопка «✥ Режим перемещения»: коснуться ячейки, потом другой).',
        'Перетащите один ряд на другой в списке рядов сверху — весь товар обоих рядов поменяется местами.',
        '«+ Добавить ряд» — новый ряд стеллажей; «☑ Выбрать ряды» — выбрать несколько для удаления разом.',
        '«⚙ Управление рядом» — задать свой порядок стеллажей внутри ряда.',
        'Поиск сверху находит по артикулу, ячейке или ТЕ; значок камеры — то же самое, но по штрихкоду.',
        'Цвет ячейки в легенде внизу подсказывает, занята ли она и можно ли перетащить товар сюда.'
      ]
    },
    table: {
      title: 'Справка · Таблица данных',
      items: [
        'Поиск — по артикулу, наименованию, ячейке или ТЕ; рядом — поиск по штрихкоду через камеру.',
        'Фильтры: тип записи (адресные/служебные) и категория товара (выпадающий список).',
        '«+ Добавить товар» — вручную завести новую позицию с адресом.',
        'Отметьте несколько строк чекбоксами — появится панель массовых действий: переместить или удалить выбранное разом.',
        'Клик по заголовку столбца — сортировка по нему.',
        'Значок в конце строки открывает карточку записи для редактирования или удаления.'
      ]
    },
    reco: {
      title: 'Справка · Рекомендация пикинга',
      items: [
        'ABC-классы сверху — сколько ярусов пикинга (ярус 1) отводится под каждый класс; числа можно менять, «Сбросить» вернёт A:3 · B:2 · C:1.',
        'Схема ниже показывает рекомендованный адрес пикинга (ярус 1) и адрес пополнения (резерв, ярусы выше) для каждого артикула.',
        'Обводка ячейки — класс A; цвет заливки — материал упаковки, оттенок — вес/размер.',
        'Таблица снизу — то же самое построчно, с поиском и фильтром по ABC/категории; «⬇ Экспорт» скачивает её с учётом текущих фильтров в .xlsx.',
        'Служебные зоны в середине страницы — рекомендуемое распределение зон по типу товара.'
      ]
    },
    zones: {
      title: 'Справка · Служебные зоны',
      items: [
        'Служебная зона — место хранения вне обычной адресной сетки (брак, возврат и т.п.).',
        '«+ Добавить зону» — создать новую; «➜ Перенести в зону» — переместить туда товар с адреса.',
        'На карточке зоны: ✏ — переименовать или сделать изолированной, 🗑 — удалить зону.',
        'Клик по самой карточке — список того, что в зоне сейчас лежит.'
      ]
    },
    tasks: {
      title: 'Справка · Задания',
      items: [
        '«Мои задания» — то, что назначили лично вам; отмечайте статус по ходу выполнения.',
        { perm: 'canManageTasks', text: 'Ниже — панель «Все задания команды» с кнопкой «+ Новое задание», чтобы назначить работу сотрудникам.' }
      ]
    },
    chats: {
      title: 'Справка · Чаты',
      items: [
        'Слева — список чатов: личные переписки и группы; «+ Группа» создаёт новый групповой чат.',
        'В переписке можно прикреплять файлы (📎) — фото, видео, аудио или PDF.',
        '👥 в шапке чата — участники группы; 🗑 — удалить чат.'
      ]
    },
    accounts: {
      title: 'Справка · Аккаунты',
      items: [
        '«Сотрудники» — общий список всех, кто есть в системе, с ролями; доступен поиск и фильтр по роли.',
        { perm: 'canManageUsers', text: 'Ниже — «Заявки на регистрацию» (одобрить с выбором роли или отклонить) и «Пользователи и роли» (создать аккаунт, назначить роль, а во вкладке «🏷 Роли» — завести свою роль с нужным набором прав).' }
      ]
    }
  };
  function openHelp(){
    const active = document.querySelector('nav.tabs button.active');
    const view = (active && active.dataset.view) || 'map';
    const help = HELP_CONTENT[view] || HELP_CONTENT.map;
    const perms = (window.__currentUser && window.__currentUser.perms) || {};
    const items = help.items
      .filter(it => typeof it === 'string' || perms[it.perm])
      .map(it => typeof it === 'string' ? it : it.text);
    const body = `<ul style="margin:0; padding-left:20px; display:flex; flex-direction:column; gap:8px; font-size:13px; line-height:1.5;">${
      items.map(t => `<li>${escHtml(t)}</li>`).join('')
    }</ul>`;
    openModal(help.title, body, '<button class="btn" id="help-close-btn">Закрыть</button>');
    document.getElementById('help-close-btn').addEventListener('click', closeModal);
  }
  document.getElementById('help-btn').addEventListener('click', openHelp);
  function initials(name){
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  function formatLastSeen(u){
    if (u.online) return 'онлайн';
    const raw = u.lastSeenAt || u.lastLoginAt;
    if (!raw) return 'ещё не входил(а)';
    const d = new Date(raw.replace(' ', 'T') + 'Z');
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const datePart = sameDay ? '' : d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) + ' ';
    const timePart = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    return `был(а) в сети ${datePart}${timePart}`;
  }

  // ---------- BARCODE SCANNER (поиск товара по штрих-коду через камеру) ----------
  let barcodeScanner = null;

  async function stopBarcodeScanner(){
    if(!barcodeScanner) return;
    const s = barcodeScanner;
    barcodeScanner = null;
    try{ await s.stop(); }catch(e){ /* уже остановлен или не запускался */ }
    try{ s.clear(); }catch(e){}
  }

  // Ищем совпадения по коду: сначала точное совпадение с артикулом/ТЕ/ячейкой
  // (пробуя все EAN/UPC/GS1-варианты отсканированного кода — см.
  // barcodeCandidates), затем — на случай если код содержит служебные
  // префиксы/суффиксы (GS1 и т.п.) — частичное вхождение.
  function findRecordsByCode(code){
    const c = String(code || '').trim();
    if(!c) return [];
    const candidates = barcodeCandidates(c);
    const lcCandidates = candidates.map(x=>x.toLowerCase());
    const lc = c.toLowerCase();
    let matches = state.records.filter(r =>
      candidates.includes(r.article) || candidates.includes(r.cell) || (r.te && candidates.includes(r.te))
    );
    if(!matches.length){
      matches = state.records.filter(r =>
        lcCandidates.includes(r.article.toLowerCase()) || (r.te && lcCandidates.includes(r.te.toLowerCase()))
      );
    }
    if(!matches.length){
      matches = state.records.filter(r =>
        r.article.toLowerCase().includes(lc) || (r.te && r.te.toLowerCase().includes(lc))
      );
    }
    return matches;
  }

  // Переходит к ОДНОЙ конкретной найденной записи — либо когда код дал ровно
  // одно совпадение, либо когда пользователь выбрал нужную запись из списка
  // (см. renderBarcodeManualResults ниже, поиск по последним символам ТЕ).
  function selectFoundRecord(r, context){
    const label = r.te || r.article;
    if(context === 'map'){
      document.querySelector('nav.tabs button[data-view="map"]').click();
      document.getElementById('map-search').value = label;
      mapFilterTerm = label;
      if(r.isService){
        renderGrid();
        alert(`Товар «${r.article}» найден только в служебной зоне — на схеме склада его нет.`);
        return;
      }
      pulseAddressesOnMap([r]);
      return;
    }
    document.querySelector('nav.tabs button[data-view="table"]').click();
    tableTerm = label;
    document.getElementById('table-search').value = label;
    renderAll();
    openDrawer(`Найдено по ${r.te ? 'ТЕ' : 'артикулу'} «${label}»`, [{
      article: r.article, name: r.name, qty: r.qty, mfg: r.mfg, exp: r.exp,
      te: r.te, cell: r.cell
    }]);
  }

  function handleScannedCode(rawCode, context){
    const code = String(rawCode || '').trim();
    if(!code) return;
    const matches = findRecordsByCode(code);
    if(!matches.length){
      alert(`Товар со штрихкодом «${code}» не найден в текущих данных склада.`);
      return;
    }
    // Один и тот же штрихкод упаковки — это нормально, если он лежит в
    // нескольких ячейках/ТЕ сразу, так что при скане камерой не просим
    // вводить что-то ещё вручную, а сразу показываем всё найденное.
    if(matches.length === 1){
      selectFoundRecord(matches[0], context);
      return;
    }
    if(context === 'map'){
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
    document.querySelector('nav.tabs button[data-view="table"]').click();
    tableTerm = code;
    document.getElementById('table-search').value = code;
    renderAll();
    openDrawer(`Найдено по коду «${code}» (${matches.length})`, matches.map(r=>({
      article: r.article, name: r.name, qty: r.qty, mfg: r.mfg, exp: r.exp,
      te: r.te, cell: r.cell
    })));
  }

  function openBarcodeScanner(context){
    const body = `
      <div id="barcode-reader"></div>
      <div id="barcode-status" style="margin-top:10px; font-size:12.5px; color:var(--ink-soft);">Наведите камеру на штрих-код товара…</div>
      <div class="form-field" style="margin-top:14px; position:relative;">
        <label>Или введите код вручную</label>
        <input type="text" id="barcode-manual-input" placeholder="Артикул, ячейка или последние символы ТЕ…" autocomplete="off">
        <div class="search-results" id="barcode-manual-results"></div>
      </div>
    `;
    const footer = `<button class="btn" id="barcode-manual-submit">Найти</button><button class="btn primary" id="barcode-cancel">Закрыть</button>`;
    openModal('Поиск товара по штрих-коду', body, footer);

    document.getElementById('barcode-cancel').addEventListener('click', closeModal);

    const manualInput = document.getElementById('barcode-manual-input');
    const resultsBox = document.getElementById('barcode-manual-results');

    function closeManualResults(){
      resultsBox.classList.remove('open');
      resultsBox.innerHTML = '';
    }

    // По мере ввода (например, последних 4 символов ТЕ) показываем список
    // подходящих записей — клик по одной сразу переходит к ней, без
    // необходимости вводить код целиком.
    function renderManualResults(){
      const val = manualInput.value.trim();
      if(val.length < 4){ closeManualResults(); return; }
      const matches = findRecordsByCode(val);
      if(!matches.length){
        resultsBox.innerHTML = `<div class="sr-empty">Ничего не найдено: «${escapeHtml(val)}»</div>`;
        resultsBox.classList.add('open');
        return;
      }
      const shown = matches.slice(0, 30);
      resultsBox.innerHTML = shown.map((r,i)=>`
        <div class="sr-item" data-idx="${i}">
          <div class="sr-main">
            <div class="sr-art">${escapeHtml(r.article)}</div>
            <div class="sr-name">${escapeHtml(r.name || '—')}${r.te ? ' · ТЕ '+escapeHtml(r.te) : ''}</div>
          </div>
          <div class="sr-meta">
            <span class="sr-cell">${escapeHtml(r.cell)}</span>
            <span class="sr-qty">${fmtNum(r.qty)} шт</span>
          </div>
        </div>
      `).join('') + (matches.length > shown.length ? `<div class="sr-more">и ещё ${matches.length - shown.length}… уточните запрос</div>` : '');
      resultsBox.classList.add('open');
      resultsBox.querySelectorAll('.sr-item').forEach(el=>{
        el.addEventListener('click', ()=>{
          const r = shown[parseInt(el.dataset.idx,10)];
          closeModal();
          selectFoundRecord(r, context);
        });
      });
    }
    manualInput.addEventListener('input', renderManualResults);
    manualInput.addEventListener('focus', renderManualResults);

    const submitManual = ()=>{
      const val = manualInput.value.trim();
      if(!val) return;
      const matches = findRecordsByCode(val);
      if(matches.length === 1){
        closeModal();
        selectFoundRecord(matches[0], context);
        return;
      }
      if(matches.length > 1){
        // несколько совпадений — не гадаем, просто показываем список выбора
        renderManualResults();
        return;
      }
      closeModal();
      handleScannedCode(val, context);
    };
    document.getElementById('barcode-manual-submit').addEventListener('click', submitManual);
    manualInput.addEventListener('keydown', (e)=>{ if(e.key==='Enter') submitManual(); });

    if(typeof Html5Qrcode === 'undefined'){
      document.getElementById('barcode-status').textContent = 'Сканер камеры недоступен (нет соединения с CDN) — введите код вручную.';
      return;
    }

    // Форматы, которые распознаёт сканер. QR_CODE — это классический квадратный
    // QR; квадратный код на этикетках («Честный знак» и т.п.) — это DATA_MATRIX,
    // отдельный формат, без него камера его просто игнорировала.
    const scanFormats = [
      Html5QrcodeSupportedFormats.EAN_13, Html5QrcodeSupportedFormats.EAN_8,
      Html5QrcodeSupportedFormats.CODE_128, Html5QrcodeSupportedFormats.CODE_39,
      Html5QrcodeSupportedFormats.UPC_A, Html5QrcodeSupportedFormats.UPC_E,
      Html5QrcodeSupportedFormats.ITF, Html5QrcodeSupportedFormats.QR_CODE
    ];
    if(Html5QrcodeSupportedFormats.DATA_MATRIX !== undefined){
      scanFormats.push(Html5QrcodeSupportedFormats.DATA_MATRIX);
    }
    barcodeScanner = new Html5Qrcode('barcode-reader', {
      formatsToSupport: scanFormats,
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
    'set-levels': 'Ярусы', 'create-row': 'Новый ряд', 'delete-row': 'Удаление ряда',
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
  async function undoActivityEntry(id, isLatest){
    const msg = isLatest
      ? 'Отменить это действие?'
      : 'Это не последнее действие в журнале — после него были и другие изменения. Если они затрагивали те же записи, отмена может дать неожиданный результат. Всё равно отменить?';
    if(!(await confirmDialog(msg, { title: 'Отмена действия', okLabel: 'Отменить действие', icon: '↺' }))) return;
    progressStart('Отмена действия…');
    try{
      const res = await fetch(`${API_BASE}/api/activity/${id}/undo`, { method:'POST' });
      const payload = await res.json().catch(()=>({}));
      if(!res.ok) throw new Error(payload.error || ('HTTP '+res.status));
      await fetchRecords();
      renderAll();
      setSyncStatus(`отменено: ${payload.summary} · ` + new Date().toLocaleTimeString('ru-RU'));
      await openActivityLog(); // обновляем список в том же окне
    }catch(err){
      alert('Не удалось отменить действие: ' + err.message);
    } finally {
      progressEnd();
    }
  }
  async function deleteActivityEntry(id){
    if(!(await confirmDialog('Удалить эту запись из журнала? Само действие отменено не будет.', { title: 'Удаление записи журнала', okLabel: 'Удалить', icon: '🗑' }))) return;
    try{
      const res = await fetch(`${API_BASE}/api/activity/${id}`, { method:'DELETE' });
      const payload = await res.json().catch(()=>({}));
      if(!res.ok) throw new Error(payload.error || ('HTTP '+res.status));
      await openActivityLog();
    }catch(err){
      alert('Не удалось удалить запись: ' + err.message);
    }
  }
  async function clearActivityLog(){
    if(!(await confirmDialog('Полностью очистить журнал изменений? Это нельзя отменить (сами данные склада не изменятся).', { title: 'Очистка журнала', okLabel: 'Очистить', danger: true }))) return;
    try{
      const res = await fetch(`${API_BASE}/api/activity`, { method:'DELETE' });
      const payload = await res.json().catch(()=>({}));
      if(!res.ok) throw new Error(payload.error || ('HTTP '+res.status));
      await openActivityLog();
    }catch(err){
      alert('Не удалось очистить журнал: ' + err.message);
    }
  }
  // Выбранный фильtr по пользователю в общем журнале — храним между
  // открытиями модалки (в т.ч. когда она перерисовывается после отмены
  // действия), чтобы выбор не сбрасывался на "Все".
  let activityUserFilter = 'all';
  let activityUserSearch = '';
  // Достаёт подпись автора из текста записи — она уже добавляется туда
  // при записи в журнал (см. logActivity в db.js: "[Имя · Роль] ...").
  function actorLabelFromSummary(summary){
    const m = /^\[([^\]]+)\]/.exec(summary || '');
    return m ? m[1] : null;
  }
  function renderActivityRows(entries){
    const listEl = document.getElementById('activity-log-list');
    if(!listEl) return;
    const clearAllBtn = document.getElementById('activity-log-clear-all');
    if(clearAllBtn) clearAllBtn.style.display = entries.length ? '' : 'none';
    const term = activityUserSearch.trim().toLowerCase();
    const filtered = entries
      .filter(e => activityUserFilter === 'all' || String(e.userId == null ? 'none' : e.userId) === activityUserFilter)
      .filter(e => !term || (actorLabelFromSummary(e.summary) || '').toLowerCase().includes(term));
    if(!filtered.length){
      listEl.innerHTML = `<div id="activity-log-empty">${entries.length ? 'Ничего не найдено по выбранным условиям.' : 'За последние 14 дней изменений не было.'}</div>`;
      return;
    }
    listEl.innerHTML = filtered.map((e, idx) => `
      <div class="activity-row">
        <span class="a-time">${fmtActivityTime(e.ts)}</span>
        <span class="a-action">${escHtml(ACTIVITY_LABELS[e.action] || e.action)}</span>
        <span class="a-summary">${escHtml(e.summary)}</span>
        ${e.undoable ? `<button class="btn a-undo-btn" data-id="${e.id}" data-latest="${idx===0}" title="Отменить это действие">↺ Отменить</button>` : ''}
        <button class="btn a-delete-btn" data-id="${e.id}" title="Удалить запись из журнала (без отмены действия)">✕</button>
      </div>
    `).join('');
    listEl.querySelectorAll('.a-undo-btn').forEach(btn=>{
      btn.addEventListener('click', ()=> undoActivityEntry(btn.dataset.id, btn.dataset.latest==='true'));
    });
    listEl.querySelectorAll('.a-delete-btn').forEach(btn=>{
      btn.addEventListener('click', ()=> deleteActivityEntry(btn.dataset.id));
    });
  }
  async function openActivityLog(){
    const canManage = !!(window.__currentUser && window.__currentUser.perms && window.__currentUser.perms.canManageActivity);
    const hint = canManage
      ? 'Хранится за последние 14 дней. У каждого действия, которое можно отменить, есть кнопка ↺ — не обязательно отменять всё по порядку. Кнопка ✕ убирает запись из журнала, не отменяя само действие.'
      : 'Хранится за последние 14 дней.';
    openModal('Журнал изменений', `<div id="activity-log-hint">${hint}</div><div class="al-toolbar"><div class="al-search"><span class="al-search-icon">🔎</span><input type="text" id="activity-log-user-search" placeholder="Поиск по пользователю…" autocomplete="off"><button class="clear-inline-btn" id="activity-log-user-search-clear" type="button" title="Очистить">✕</button></div><select id="activity-log-user-filter"><option value="all">Все пользователи</option></select></div><div id="activity-log-list"><div id="activity-log-empty">Загрузка…</div></div>`, '<button class="btn danger" id="activity-log-clear-all">🗑 Очистить журнал</button><button class="btn" id="activity-log-close">Закрыть</button>');
    document.getElementById('activity-log-close').addEventListener('click', closeModal);
    document.getElementById('activity-log-clear-all').addEventListener('click', clearActivityLog);
    try{
      const res = await fetch(`${API_BASE}/api/activity?limit=1000`);
      const payload = await res.json().catch(()=>({}));
      if(!res.ok) throw new Error(payload.error || ('HTTP '+res.status));
      const entries = payload.entries || [];
      const listEl = document.getElementById('activity-log-list');
      if(!listEl) return; // окно уже закрыли, пока грузились данные
      // Список пользователей для фильтра — только те, чьи действия реально
      // есть в текущей выборке (а не все сотрудники системы), подпись берём
      // из уже сохранённого в записи текста, чтобы не терять уволенных/
      // удалённых авторов из истории.
      const actorsById = new Map();
      let hasNoActor = false;
      entries.forEach(e => {
        if(e.userId == null){ hasNoActor = true; return; }
        if(!actorsById.has(e.userId)) actorsById.set(e.userId, actorLabelFromSummary(e.summary) || `#${e.userId}`);
      });
      const filterEl = document.getElementById('activity-log-user-filter');
      if(filterEl){
        const options = Array.from(actorsById.entries()).sort((a,b)=> a[1].localeCompare(b[1], 'ru'));
        filterEl.innerHTML = '<option value="all">Все пользователи</option>'
          + options.map(([id, label]) => `<option value="${id}">${escHtml(label)}</option>`).join('')
          + (hasNoActor ? '<option value="none">Без автора</option>' : '');
        const filterStillValid = activityUserFilter === 'all'
          || (activityUserFilter === 'none' && hasNoActor)
          || actorsById.has(Number(activityUserFilter));
        activityUserFilter = filterStillValid ? activityUserFilter : 'all';
        filterEl.value = activityUserFilter;
        if(filterEl.value !== activityUserFilter) activityUserFilter = filterEl.value; // на случай несуществующей опции (напр. пользователь удалён из списка)
        filterEl.addEventListener('change', ()=>{
          activityUserFilter = filterEl.value;
          renderActivityRows(entries);
        });
      }
      const searchEl = document.getElementById('activity-log-user-search');
      const searchClearBtn = document.getElementById('activity-log-user-search-clear');
      if(searchEl){
        searchEl.value = activityUserSearch;
        searchEl.addEventListener('input', ()=>{
          activityUserSearch = searchEl.value;
          renderActivityRows(entries);
        });
      }
      if(searchClearBtn){
        searchClearBtn.addEventListener('click', ()=>{
          activityUserSearch = '';
          if(searchEl) searchEl.value = '';
          renderActivityRows(entries);
        });
      }
      renderActivityRows(entries);
    }catch(err){
      const listEl = document.getElementById('activity-log-list');
      if(listEl) listEl.innerHTML = `<div id="activity-log-empty">Не удалось загрузить журнал: ${err.message}</div>`;
    }
  }
  document.getElementById('activity-log-btn').addEventListener('click', openActivityLog);
  const bnJournalBtn = document.getElementById('bn-journal-btn');
  if(bnJournalBtn) bnJournalBtn.addEventListener('click', openActivityLog);

  // ---------- Мой журнал (свои действия, доступно всем — без прав на общий журнал) ----------
  async function undoMyActivityEntry(id, isLatest){
    const msg = isLatest
      ? 'Отменить это своё действие?'
      : 'Это не последнее из ваших действий — после него были другие изменения. Если они затрагивали те же записи, отмена может дать неожиданный результат. Всё равно отменить?';
    if(!(await confirmDialog(msg, { title: 'Отмена действия', okLabel: 'Отменить действие', icon: '↺' }))) return;
    progressStart('Отмена действия…');
    try{
      const res = await fetch(`${API_BASE}/api/my-activity/${id}/undo`, { method:'POST' });
      const payload = await res.json().catch(()=>({}));
      if(!res.ok) throw new Error(payload.error || ('HTTP '+res.status));
      await fetchRecords();
      renderAll();
      setSyncStatus(`отменено: ${payload.summary} · ` + new Date().toLocaleTimeString('ru-RU'));
      await openMyActivityLog(); // обновляем список в том же окне
    }catch(err){
      alert('Не удалось отменить действие: ' + err.message);
    } finally {
      progressEnd();
    }
  }
  async function openMyActivityLog(){
    openModal('Мой журнал', '<div id="my-activity-log-hint">Здесь только ваши собственные действия за последние 14 дней. У каждого, которое можно отменить, есть кнопка ↺.</div><div id="my-activity-log-list"><div id="my-activity-log-empty">Загрузка…</div></div>', '<button class="btn" id="my-activity-log-close">Закрыть</button>');
    document.getElementById('my-activity-log-close').addEventListener('click', closeModal);
    try{
      const res = await fetch(`${API_BASE}/api/my-activity?limit=1000`);
      const payload = await res.json().catch(()=>({}));
      if(!res.ok) throw new Error(payload.error || ('HTTP '+res.status));
      const entries = payload.entries || [];
      const listEl = document.getElementById('my-activity-log-list');
      if(!listEl) return; // окно уже закрыли, пока грузились данные
      if(!entries.length){
        listEl.innerHTML = '<div id="my-activity-log-empty">За последние 14 дней вы ничего не меняли.</div>';
        return;
      }
      listEl.innerHTML = entries.map((e, idx) => `
        <div class="activity-row">
          <span class="a-time">${fmtActivityTime(e.ts)}</span>
          <span class="a-action">${escHtml(ACTIVITY_LABELS[e.action] || e.action)}</span>
          <span class="a-summary">${escHtml(e.summary)}</span>
          ${e.undoable ? `<button class="btn my-a-undo-btn" data-id="${e.id}" data-latest="${idx===0}" title="Отменить это действие">↺ Отменить</button>` : ''}
        </div>
      `).join('');
      listEl.querySelectorAll('.my-a-undo-btn').forEach(btn=>{
        btn.addEventListener('click', ()=> undoMyActivityEntry(btn.dataset.id, btn.dataset.latest==='true'));
      });
    }catch(err){
      const listEl = document.getElementById('my-activity-log-list');
      if(listEl) listEl.innerHTML = `<div id="my-activity-log-empty">Не удалось загрузить журнал: ${err.message}</div>`;
    }
  }
  const myActivityLogBtn = document.getElementById('my-activity-log-btn');
  if(myActivityLogBtn) myActivityLogBtn.addEventListener('click', openMyActivityLog);
  // Мобильная кнопка «Мой журнал» в нижнем навбаре — открывает тот же модал,
  // что и её десктопный аналог выше (см. #my-activity-log-btn).
  const bnMyActivityLogBtn = document.getElementById('bn-my-journal-btn');
  if(bnMyActivityLogBtn) bnMyActivityLogBtn.addEventListener('click', openMyActivityLog);

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
    if(!(await confirmDialog(`Удалить ${ids.length} выбранных записей?`, { title: 'Удаление записей', okLabel: 'Удалить', danger: true }))) return;
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
      // Переводим введённый/отсканированный текст через справочник штрихкодов
      // (barcodeCandidates уже сверяет его со всеми EAN/UPC/GS1-вариантами и
      // с product_barcodes), чтобы реальный штрихкод товара, а не только
      // артикул/ячейка/ТЕ, тоже находился в этом поиске.
      const candLower = barcodeCandidates(tableTerm.trim()).map(x=>x.toLowerCase());
      rows = rows.filter(r=>
        candLower.includes(r.article.toLowerCase()) || (r.te && candLower.includes(r.te.toLowerCase())) ||
        r.article.toLowerCase().includes(term) || r.name.toLowerCase().includes(term) || r.cell.toLowerCase().includes(term) || (r.te && r.te.toLowerCase().includes(term))
      );
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
        if(!(await confirmDialog(`Удалить запись «${rec.article}» из ячейки ${rec.cell}?`, { title: 'Удаление записи', okLabel: 'Удалить', danger: true }))) return;
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
    let levelsDraft = LEVEL_ORDER.filter(l=>extent.levels.includes(l));
    let dragIdx = null;
    let levelDragIdx = null;

    function occupiedRacksInDraftRow(){
      // ranks that currently hold stock in THIS row — removing them needs a warning
      const set = new Set();
      addressRecords().filter(r=>r.row===originalRow).forEach(r=>set.add(r.rack));
      return set;
    }

    function occupiedLevelsInDraftRow(){
      const set = new Set();
      addressRecords().filter(r=>r.row===originalRow).forEach(r=>set.add(r.level));
      return set;
    }

    function renderLevelChips(){
      const occupied = occupiedLevelsInDraftRow();
      const list = document.getElementById('modal-body').querySelector('.level-order-list');
      list.innerHTML = levelsDraft.map((lv,idx)=>`
        <div class="order-chip" draggable="true" data-idx="${idx}" data-level="${lv}" title="${occupied.has(lv)?'На этом ярусе есть товар':'Пусто'}">
          <span class="oc-move" data-dir="-1" title="Сдвинуть влево">◀</span>
          ${lv}${occupied.has(lv)?'':' <span class="rm" style="opacity:.5;">×</span>'}
          <span class="oc-move" data-dir="1" title="Сдвинуть вправо">▶</span>
        </div>
      `).join('');

      list.querySelectorAll('.order-chip').forEach(chip=>{
        chip.addEventListener('dragstart', (e)=>{
          levelDragIdx = parseInt(chip.dataset.idx,10);
          chip.classList.add('drag-source');
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(levelDragIdx));
        });
        chip.addEventListener('dragend', ()=>{ chip.classList.remove('drag-source'); levelDragIdx = null; });
        chip.addEventListener('dragover', (e)=>{
          if(levelDragIdx===null) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          chip.classList.add('drag-over');
        });
        chip.addEventListener('dragleave', ()=>{ chip.classList.remove('drag-over'); });
        chip.addEventListener('drop', (e)=>{
          e.preventDefault();
          chip.classList.remove('drag-over');
          const targetIdx = parseInt(chip.dataset.idx,10);
          if(levelDragIdx===null || levelDragIdx===targetIdx) return;
          const [moved] = levelsDraft.splice(levelDragIdx,1);
          levelsDraft.splice(targetIdx,0,moved);
          levelDragIdx = null;
          renderLevelChips();
        });
        chip.querySelectorAll('.oc-move').forEach(btn=>{
          btn.addEventListener('click', (e)=>{
            e.stopPropagation();
            const idx = parseInt(chip.dataset.idx,10);
            const dir = parseInt(btn.dataset.dir,10);
            const newIdx = idx + dir;
            if(newIdx<0 || newIdx>=levelsDraft.length) return;
            [levelsDraft[idx], levelsDraft[newIdx]] = [levelsDraft[newIdx], levelsDraft[idx]];
            renderLevelChips();
          });
        });
        const rmBtn = chip.querySelector('.rm');
        if(rmBtn){
          rmBtn.addEventListener('click', (e)=>{
            e.stopPropagation();
            const lv = chip.dataset.level;
            levelsDraft = levelsDraft.filter(l=>l!==lv);
            renderLevelChips();
            renderAddLevelOptions();
          });
        }
      });
    }

    function renderAddLevelOptions(){
      const sel = document.getElementById('add-level-select');
      if(!sel) return;
      const remaining = LEVEL_ORDER.filter(l=>!levelsDraft.includes(l));
      sel.innerHTML = remaining.map(l=>`<option value="${l}">${l}</option>`).join('') || '<option value="">— все ярусы уже добавлены —</option>';
      sel.disabled = !remaining.length;
      document.getElementById('add-level-btn').disabled = !remaining.length;
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
      <div class="form-field" style="margin-bottom:16px;">
        <label>Стеллажи ряда — перетаскивайте, чтобы задать порядок; × убирает пустой стеллаж</label>
        <div class="order-list"></div>
      </div>
      <div class="form-field with-pin" style="max-width:260px; margin-bottom:20px;">
        <div><input id="add-rack-input" type="number" min="1" placeholder="Номер нового стеллажа"></div>
        <button class="btn" id="add-rack-btn" style="height:34px;">+ Добавить</button>
      </div>
      <div class="form-field" style="margin-bottom:10px;">
        <label>Ярусы ряда (количество строк по высоте) — перетаскивайте, чтобы задать порядок; × убирает пустой ярус</label>
        <div class="order-list level-order-list"></div>
      </div>
      <div class="form-field with-pin" style="max-width:260px;">
        <div><select id="add-level-select"></select></div>
        <button class="btn" id="add-level-btn" style="height:34px;">+ Добавить</button>
      </div>
      <div class="form-error" id="row-mgr-error"></div>
    `;
    const footer = `
      <button class="btn danger" id="row-mgr-delete">Удалить ряд</button>
      <button class="btn" id="order-reset">Стеллажи по возрастанию</button>
      <button class="btn" id="row-mgr-cancel">Отмена</button>
      <button class="btn primary" id="row-mgr-save">Сохранить</button>
    `;
    openModal(`Управление рядом ${originalRow}`, body, footer);
    renderChips();
    renderLevelChips();
    renderAddLevelOptions();

    document.getElementById('row-mgr-delete').addEventListener('click', async ()=>{
      const errEl = document.getElementById('row-mgr-error');
      errEl.classList.remove('show');
      if(!(await confirmDialog(`Удалить ряд ${originalRow} целиком? Это возможно только если в нём нет товара. Действие необратимо.`, { title: 'Удаление ряда', okLabel: 'Удалить', danger: true }))) return;
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
    document.getElementById('add-level-btn').addEventListener('click', ()=>{
      const sel = document.getElementById('add-level-select');
      const v = sel.value;
      if(!v || levelsDraft.includes(v)) return;
      levelsDraft.push(v);
      renderLevelChips();
      renderAddLevelOptions();
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

        const res3 = await fetch(`${API_BASE}/api/layout/${workingRow}/levels`, {
          method:'PUT', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ levels: levelsDraft })
        });
        const payload3 = await res3.json().catch(()=>({}));
        if(!res3.ok) throw new Error(payload3.error || ('HTTP '+res3.status));

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
  function saveStorageRange(){
    try{ localStorage.setItem('storageRange', JSON.stringify(STORAGE_RANGE)); }catch(e){}
    persistSettings({ storageRange: STORAGE_RANGE });
  }
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
  function saveAbcCols(){
    try{ localStorage.setItem('abcCols', JSON.stringify(ABC_COLS)); }catch(e){}
    persistSettings({ abcCols: ABC_COLS });
  }
  let ABC_COLS = loadAbcCols();

  // Порядок обхода рядов при пикинге (змейка) и ряд, куда принудительно кладут
  // бутылки 0,5 л — раньше было жёстко зашито (06→05→04→03→02→01, 0,5 л
  // всегда в ряд 04), теперь редактируется в UI («⚙ Порядок пикинга») и
  // синхронизируется через сервер так же, как ABC_COLS/STORAGE_RANGE выше.
  const PICK_ROW_ORDER_DEFAULT = ['06','05','04','03','02','01'];
  const HALF_BOTTLE_ROW_DEFAULT = '04';
  function isValidRowOrder(arr){
    return Array.isArray(arr) && arr.length === PICK_ROW_ORDER_DEFAULT.length &&
      arr.every(r => PICK_ROW_ORDER_DEFAULT.includes(r)) &&
      new Set(arr).size === PICK_ROW_ORDER_DEFAULT.length;
  }
  function loadPickRowOrder(){
    try{
      const saved = JSON.parse(localStorage.getItem('pickRowOrder'));
      if(isValidRowOrder(saved)) return saved;
    }catch(e){}
    return [...PICK_ROW_ORDER_DEFAULT];
  }
  function savePickRowOrder(){
    try{ localStorage.setItem('pickRowOrder', JSON.stringify(PICK_ROW_ORDER)); }catch(e){}
    persistSettings({ pickRowOrder: PICK_ROW_ORDER });
  }
  let PICK_ROW_ORDER = loadPickRowOrder();

  function loadHalfBottleRow(){
    try{
      const saved = localStorage.getItem('halfBottleRow');
      if(saved && PICK_ROW_ORDER_DEFAULT.includes(saved)) return saved;
    }catch(e){}
    return HALF_BOTTLE_ROW_DEFAULT;
  }
  function saveHalfBottleRow(){
    try{ localStorage.setItem('halfBottleRow', HALF_BOTTLE_ROW); }catch(e){}
    persistSettings({ halfBottleRow: HALF_BOTTLE_ROW });
  }
  let HALF_BOTTLE_ROW = loadHalfBottleRow();

  // Settings (storage-range per row, ABC pick-face width) used to live only in
  // localStorage, so each device/browser kept its own copy — set the range to
  // 91 on a desktop, the phone still showed the old value (e.g. 66) because it
  // never saw the change. They're now saved to the server (see PUT
  // /api/settings) so every device converges on the same value; localStorage
  // is kept only as an instant-load cache before the first server sync.
  let settingsSyncedFromServer = false;
  async function persistSettings(patch){
    try{
      await fetch(API_BASE + '/api/settings', {
        method: 'PUT',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify(patch)
      });
    }catch(e){ /* offline — localStorage copy above still saved locally */ }
  }
  function applySettingsFromServer(serverStorageRange, serverAbcCols, serverPickRowOrder, serverHalfBottleRow){
    // The server is the source of truth once it has a value for a given
    // setting; a device that never touched a setting still gets whatever the
    // last device to change it saved. Only fall back to this browser's own
    // localStorage/defaults when the server has genuinely never seen a value.
    let changed = false;
    if(serverStorageRange && typeof serverStorageRange==='object'){
      const merged = {...STORAGE_RANGE_DEFAULT};
      Object.keys(merged).forEach(row=>{
        const s = serverStorageRange[row];
        if(Array.isArray(s) && s.length===2){
          const lo = clampStorageBound(row, s[0], merged[row][0]);
          const hi = clampStorageBound(row, s[1], merged[row][1]);
          merged[row] = lo<=hi ? [lo, hi] : [hi, lo];
        }
      });
      if(JSON.stringify(merged) !== JSON.stringify(STORAGE_RANGE)){ STORAGE_RANGE = merged; changed = true; }
    }
    if(serverAbcCols && typeof serverAbcCols==='object'){
      const merged = {
        A: clampAbcCols(serverAbcCols.A ?? ABC_COLS_DEFAULT.A),
        B: clampAbcCols(serverAbcCols.B ?? ABC_COLS_DEFAULT.B),
        C: clampAbcCols(serverAbcCols.C ?? ABC_COLS_DEFAULT.C)
      };
      if(JSON.stringify(merged) !== JSON.stringify(ABC_COLS)){ ABC_COLS = merged; changed = true; }
    }
    if(isValidRowOrder(serverPickRowOrder) && JSON.stringify(serverPickRowOrder) !== JSON.stringify(PICK_ROW_ORDER)){
      PICK_ROW_ORDER = serverPickRowOrder;
      changed = true;
    }
    if(typeof serverHalfBottleRow === 'string' && PICK_ROW_ORDER_DEFAULT.includes(serverHalfBottleRow) && serverHalfBottleRow !== HALF_BOTTLE_ROW){
      HALF_BOTTLE_ROW = serverHalfBottleRow;
      changed = true;
    }
    if(changed){
      try{ localStorage.setItem('storageRange', JSON.stringify(STORAGE_RANGE)); }catch(e){}
      try{ localStorage.setItem('abcCols', JSON.stringify(ABC_COLS)); }catch(e){}
      try{ localStorage.setItem('pickRowOrder', JSON.stringify(PICK_ROW_ORDER)); }catch(e){}
      try{ localStorage.setItem('halfBottleRow', HALF_BOTTLE_ROW); }catch(e){}
      recoCache = null;
    }
    // If this browser had local-only settings from before this feature existed
    // (e.g. it was the "91" device) and the server has never been told about
    // them, push them up once so other devices pick them up too.
    if(!settingsSyncedFromServer && serverStorageRange==null && serverAbcCols==null){
      persistSettings({ storageRange: STORAGE_RANGE, abcCols: ABC_COLS, pickRowOrder: PICK_ROW_ORDER, halfBottleRow: HALF_BOTTLE_ROW });
    }
    settingsSyncedFromServer = true;
  }

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

    // Business rule: 0.5 L bottles always go to one designated row (default 04,
    // configurable in «⚙ Порядок пикинга») — but that row is not exclusive to
    // them; whatever cells the 0.5 L group doesn't use are still fair game for
    // the normal route.
    const FORCED_ROW_BY_VOLUME = { '0.50': HALF_BOTTLE_ROW };
    function forcedRowFor(a){ return a.vol==null ? null : (FORCED_ROW_BY_VOLUME[a.vol.toFixed(2)] || null); }

    // Physical walking path ("змейка"): configurable in the UI («⚙ Порядок
    // пикинга»), default is only rows 01–06 (07–12 are stale leftovers from the
    // old warehouse in the DB and are never used for new placements). By
    // default picking starts at the far end of row 06 (lowest rack in that row,
    // e.g. 06-28-01, next to "начало пикинга"/"зона возврата" на layout) and
    // runs in ASCENDING rack order through row 06 (28→66), then zig-zags back
    // and forth through the remaining rows in PICK_ROW_ORDER, reversing
    // direction on every row so the path never jumps across the warehouse.
    const rowRacks = {}; // row -> ordered [{row,rack}] in that row's own walking direction
    const walkIndex = {}; // "row-rack" -> position in the true physical walking order
    let walkPtr = 0;
    PICK_ROW_ORDER.forEach((row, idx)=>{
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
    PICK_ROW_ORDER.forEach(row=>{
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

  // Модалка «Порядок пикинга»: разрешает поменять порядок обхода рядов
  // (маршрут-змейка) и выбрать, в какой ряд принудительно кладутся бутылки
  // 0,5 л. Работает с локальным черновиком (workingOrder) и применяет его
  // только по кнопке «Сохранить», чтобы случайный клик по стрелке сразу не
  // ломал текущий расчёт.
  function openPickRouteSettingsModal(){
    let workingOrder = PICK_ROW_ORDER.slice();

    const body = `
      <div class="form-field">
        <label>Порядок обхода рядов при пикинге (сверху — начало маршрута, дальше змейкой)</label>
        <div id="pick-order-list"></div>
      </div>
      <div class="form-field" style="margin-top:14px;">
        <label>Ряд для бутылок 0,5 л (кладутся туда в первую очередь, остаток ряда — под общий маршрут)</label>
        <select id="half-bottle-row-select">${PICK_ROW_ORDER_DEFAULT.slice().sort().map(row=>
          `<option value="${row}" ${row===HALF_BOTTLE_ROW ? 'selected' : ''}>Ряд ${row}</option>`).join('')}</select>
      </div>
    `;
    const footer = `<button class="btn" id="pick-order-reverse">↕ Реверс</button><button class="btn" id="pick-order-reset">Сбросить по умолчанию</button><button class="btn primary" id="pick-order-save">Сохранить</button>`;
    openModal('Настройки маршрута пикинга', body, footer);

    function renderList(){
      const halfRow = document.getElementById('half-bottle-row-select')?.value || HALF_BOTTLE_ROW;
      document.getElementById('pick-order-list').innerHTML = workingOrder.map((row,i)=>`
        <div style="display:flex; align-items:center; gap:8px; padding:8px 10px; border:1px solid ${row===halfRow?'var(--accent)':'var(--line)'}; border-radius:8px; margin-bottom:6px; background:var(--bg);">
          <span style="font-weight:600; width:22px; text-align:center; color:var(--ink-soft);">${i+1}</span>
          <span style="flex:1;">Ряд ${row}${row===halfRow ? ' · сюда 0,5 л' : ''}</span>
          <button type="button" class="btn" data-act="up" data-idx="${i}" title="Выше" ${i===0?'disabled':''}>↑</button>
          <button type="button" class="btn" data-act="down" data-idx="${i}" title="Ниже" ${i===workingOrder.length-1?'disabled':''}>↓</button>
        </div>
      `).join('');
      document.querySelectorAll('#pick-order-list [data-act]').forEach(btn=>{
        btn.addEventListener('click', ()=>{
          const idx = parseInt(btn.dataset.idx, 10);
          const swapIdx = idx + (btn.dataset.act === 'up' ? -1 : 1);
          if(swapIdx < 0 || swapIdx >= workingOrder.length) return;
          [workingOrder[idx], workingOrder[swapIdx]] = [workingOrder[swapIdx], workingOrder[idx]];
          renderList();
        });
      });
    }
    renderList();
    document.getElementById('half-bottle-row-select').addEventListener('change', renderList);

    document.getElementById('pick-order-reverse').addEventListener('click', ()=>{
      // Просто переворачиваем весь маршрут задом наперёд — какой ряд был
      // первым, становится последним, и наоборот. Привязка «0,5 л → ряд 04»
      // хранится по НАЗВАНИЮ ряда (HALF_BOTTLE_ROW), а не по позиции в
      // маршруте, так что она сама «подъезжает» на новое место — на каком бы
      // шаге маршрута ни оказался ряд 04, туда и будут класть 0,5 л.
      workingOrder = workingOrder.slice().reverse();
      renderList();
    });
    document.getElementById('pick-order-reset').addEventListener('click', ()=>{
      workingOrder = PICK_ROW_ORDER_DEFAULT.slice();
      document.getElementById('half-bottle-row-select').value = HALF_BOTTLE_ROW_DEFAULT;
      renderList();
    });

    document.getElementById('pick-order-save').addEventListener('click', ()=>{
      PICK_ROW_ORDER = workingOrder.slice();
      HALF_BOTTLE_ROW = document.getElementById('half-bottle-row-select').value;
      savePickRowOrder();
      saveHalfBottleRow();
      recoCache = null;
      closeModal();
      renderReco();
    });
  }
  document.getElementById('reco-pick-order-btn')?.addEventListener('click', openPickRouteSettingsModal);


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

  // ---------- EXPORT (Рекомендация пикинга) ----------
  // Exports exactly what's currently filtered/searched on screen — not capped
  // to the 400-row on-screen preview — as an .xlsx built server-side.
  document.getElementById('reco-export-btn').addEventListener('click', async ()=>{
    if(!recoCache) computeRecommendation();
    let rows = recoCache.assigned;
    const term = recoSearchTerm.trim().toLowerCase();
    if(term){
      rows = rows.filter(r=> r.article.toLowerCase().includes(term) || r.name.toLowerCase().includes(term));
    }
    if(recoAbcFilter!=='all') rows = rows.filter(r=>r.abcClass===recoAbcFilter);
    if(recoMaterialFilter!=='all') rows = rows.filter(r=>r.material===recoMaterialFilter);
    if(!rows.length){ alert('Нечего экспортировать — таблица пуста при текущих фильтрах.'); return; }

    progressStart('Формирование файла…');
    try{
      const res = await fetch(API_BASE + '/api/export/reco', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ rows })
      });
      if(!res.ok){
        const payload = await res.json().catch(()=>({}));
        throw new Error(payload.error || ('HTTP '+res.status));
      }
      const blob = await res.blob();
      let filename = 'рекомендация_пикинга.xlsx';
      const disp = res.headers.get('Content-Disposition') || '';
      const starMatch = disp.match(/filename\*=UTF-8''([^;]+)/i);
      if(starMatch) filename = decodeURIComponent(starMatch[1]);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(()=>URL.revokeObjectURL(url), 2000);
      setSyncStatus(`экспорт рекомендаций скачан (${fmtNum(rows.length)} артикулов) · ` + new Date().toLocaleTimeString('ru-RU'));
    }catch(err){
      setSyncStatus('ошибка экспорта рекомендаций', true);
      alert('Не удалось скачать экспорт рекомендаций: ' + err.message);
    } finally {
      progressEnd();
    }
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
          if(!(await confirmDialog(`В зоне «${name}» ещё ${z.records} записей (${fmtNum(z.qty)} шт). Удалить зону вместе со всем содержимым?`, { title: 'Удаление зоны', okLabel: 'Удалить', danger: true }))) return;
          force = true;
        } else if(!(await confirmDialog(`Удалить пустую зону «${name}»?`, { title: 'Удаление зоны', okLabel: 'Удалить', danger: true }))){
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
  const WAREHOUSE_VIEWS = ['map', 'table', 'zones', 'reco'];
  const FULLSCREEN_VIEWS = ['tasks', 'accounts', 'chats', 'hub']; // разделы вроде "Задания"/"Аккаунты"/"Чаты"/"Хаб" — на телефоне занимают весь экран, без вкладок склада
  // Разделы, которые открываются собственным URL (/warehouse, /tasks) и на
  // которых поэтому показываем маленькую кнопку "← Меню" в шапке.
  const HUB_BACK_VIEWS = ['map', 'table', 'zones', 'reco', 'tasks', 'accounts'];
  let lastWarehouseView = 'map'; // склад: какую под-вкладку показать при возврате из "Задания"/"Аккаунтов"
  let currentActiveView = 'hub'; // используется хабом разделов, чтобы подсветить "Открыто" на нужной карточке

  function activateView(view){
    currentActiveView = view;
    updateHubCurrentSection(); // держим подсветку раздела в шапке актуальной (важно для десктопа, где шапка видна всегда)
    document.querySelectorAll('nav.tabs button').forEach(b=>b.classList.toggle('active', b.dataset.view === view));
    document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
    document.getElementById('view-'+view).classList.add('active');
    FULLSCREEN_VIEWS.forEach(v => document.body.classList.toggle(`bn-${v}-mode`, v === view));
    if(WAREHOUSE_VIEWS.includes(view)) lastWarehouseView = view;
    if(view === 'tasks') loadTasks();
    if(view === 'chats') loadChats();
    if(view === 'accounts'){
      if(document.body.classList.contains('perm-no-manage-users')){
        loadAccountsDirectory();
      } else {
        loadAccounts();
        if(window.__loadUsersRolesPanel) window.__loadUsersRolesPanel();
      }
    }
    document.querySelectorAll('.bn-btn[data-bn]').forEach(b=>{
      b.classList.toggle('active', b.dataset.bn === 'warehouse' ? WAREHOUSE_VIEWS.includes(view) : b.dataset.bn === view);
    });
    const hubBackBtn = document.getElementById('hub-back-btn');
    if(hubBackBtn) hubBackBtn.classList.toggle('visible', HUB_BACK_VIEWS.includes(view));
  }
  window.__activateView = activateView; // используется auth.js, чтобы открыть "Аккаунты" из карточки профиля

  document.querySelectorAll('nav.tabs button').forEach(btn=>{
    btn.addEventListener('click', ()=> activateView(btn.dataset.view));
  });

  // ---------- Плитка «Журнал» на стартовом хабе — открывает тот же модал,
  // что и обычная кнопка «Журнал»/«Мой журнал» (видна ровно одна из двух
  // в зависимости от прав, см. CSS perm-no-read-activity). ----------
  const hubTileJournal = document.getElementById('hub-tile-journal');
  if(hubTileJournal) hubTileJournal.addEventListener('click', ()=>{
    const full = document.getElementById('activity-log-btn');
    const mine = document.getElementById('my-activity-log-btn');
    if(full && full.offsetParent !== null) full.click();
    else if(mine) mine.click();
  });

  // ---------- НИЖНЯЯ ПАНЕЛЬ (телефон): Склад / Задания / Аккаунты / Профиль, как разделы в ТГ ----------
  document.querySelectorAll('.bn-btn[data-bn]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      activateView(btn.dataset.bn === 'warehouse' ? lastWarehouseView : btn.dataset.bn);
    });
  });
  // "Профиль" — не раздел склада/задания, а прямой доступ к странице
  // профиля (та же кнопка, что скрыта в шапке на телефоне).
  const bnProfileBtn = document.getElementById('bn-profile-btn');
  if(bnProfileBtn) bnProfileBtn.addEventListener('click', ()=> document.getElementById('profile-pill').click());

  // ---------- SEARCH CLEAR (×) BUTTONS ----------
  [['map-search','map-search-clear'], ['table-search','table-search-clear'], ['reco-search','reco-search-clear']].forEach(([inputId, btnId])=>{
    const input = document.getElementById(inputId);
    const btn = document.getElementById(btnId);
    if(!input || !btn) return;
    btn.addEventListener('click', ()=>{
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles:true }));
      input.focus();
    });
  });

  // ---------- SEARCH BINDINGS ----------
  // Match list under the map search box: typing used to only jump to the FIRST
  // exact hit, so finding a different cell holding the same article meant
  // clearing and retyping. Now every match is listed (артикул, наименование,
  // остаток, ячейка, ТЕ, срок годности) and clicking one jumps straight there.
  let mapSearchActiveIndex = -1;
  function closeMapSearchResults(){
    const box = document.getElementById('map-search-results');
    box.classList.remove('open');
    box.innerHTML = '';
    mapSearchActiveIndex = -1;
  }
  function renderMapSearchResults(term){
    const box = document.getElementById('map-search-results');
    const val = term.trim();
    if(val.length < 2){ closeMapSearchResults(); return; }
    const matches = findAddressMatches(val);
    if(!matches.length){
      box.innerHTML = `<div class="sr-empty">Ничего не найдено: «${escapeHtml(val)}»</div>`;
      box.classList.add('open');
      mapSearchActiveIndex = -1;
      return;
    }
    const shown = matches.slice(0, 30);
    box.innerHTML = shown.map((r,i)=>`
      <div class="sr-item${i===0?' active':''}" data-idx="${i}">
        <div class="sr-main">
          <div class="sr-art">${escapeHtml(r.article)}</div>
          <div class="sr-name">${escapeHtml(r.name || '—')}${r.te ? ' · ТЕ '+escapeHtml(r.te) : ''}${r.exp ? ' · годен до '+escapeHtml(r.exp) : ''}</div>
        </div>
        <div class="sr-meta">
          <span class="sr-cell">${escapeHtml(r.cell)}</span>
          <span class="sr-qty">${fmtNum(r.qty)} шт</span>
        </div>
      </div>
    `).join('') + (matches.length > shown.length ? `<div class="sr-more">и ещё ${matches.length - shown.length}… уточните запрос</div>` : '');
    box.classList.add('open');
    mapSearchActiveIndex = 0;
    box.querySelectorAll('.sr-item').forEach(el=>{
      el.addEventListener('click', ()=>{
        const r = shown[parseInt(el.dataset.idx,10)];
        pulseAddressesOnMap([r]);
        closeMapSearchResults();
      });
    });
  }
  function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  document.getElementById('map-search').addEventListener('input', (e)=>{
    mapFilterTerm = e.target.value; renderGrid(); renderAisleChips();
    renderMapSearchResults(e.target.value);
  });
  document.getElementById('map-search').addEventListener('focus', (e)=>{
    if(e.target.value.trim().length >= 2) renderMapSearchResults(e.target.value);
  });
  document.getElementById('map-search').addEventListener('keydown', (e)=>{
    const box = document.getElementById('map-search-results');
    const items = box.classList.contains('open') ? Array.from(box.querySelectorAll('.sr-item')) : [];
    if(e.key === 'ArrowDown' && items.length){
      e.preventDefault();
      mapSearchActiveIndex = Math.min(mapSearchActiveIndex+1, items.length-1);
      items.forEach((el,i)=>el.classList.toggle('active', i===mapSearchActiveIndex));
      items[mapSearchActiveIndex].scrollIntoView({block:'nearest'});
      return;
    }
    if(e.key === 'ArrowUp' && items.length){
      e.preventDefault();
      mapSearchActiveIndex = Math.max(mapSearchActiveIndex-1, 0);
      items.forEach((el,i)=>el.classList.toggle('active', i===mapSearchActiveIndex));
      items[mapSearchActiveIndex].scrollIntoView({block:'nearest'});
      return;
    }
    if(e.key === 'Escape'){ closeMapSearchResults(); return; }
    if(e.key !== 'Enter') return;
    e.preventDefault();
    if(items.length && mapSearchActiveIndex >= 0){ items[mapSearchActiveIndex].click(); return; }
    const val = e.target.value.trim();
    if(!val) return;
    if(!jumpOnMap(val)) alert(`На схеме склада не найдено: «${val}»`);
    closeMapSearchResults();
  });
  document.addEventListener('click', (e)=>{
    const wrap = document.getElementById('map-search').closest('.search');
    if(wrap && !wrap.contains(e.target)) closeMapSearchResults();
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

  // ---------- ВЫПАДАЮЩЕЕ МЕНЮ РАЗДЕЛОВ (клик по заголовку "Адресное хранение") ----------
  // Тот же паттерн .dropdown/.dropdown-menu, что и у "База данных" ниже.
  // Работает одинаково и на десктопе, и на телефоне — заголовок в шапке
  // виден всегда, просто уменьшается по ширине на маленьких экранах.
  const appMenuDropdown = document.getElementById('app-menu-dropdown');
  const appMenuToggle = document.getElementById('app-menu-toggle');
  const appMenuBackdrop = document.getElementById('app-menu-backdrop');
  const appMenuClose = document.getElementById('app-menu-close');
  function setAppMenuOpen(open){
    appMenuDropdown.classList.toggle('open', open);
    appMenuToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    // Хаб теперь полноэкранный (по центру на десктопе, шторка снизу на
    // телефоне) — блокируем скролл фона, пока он открыт, как у любого
    // полноэкранного диалога.
    document.body.classList.toggle('hub-open', open);
    if(open) updateHubCurrentSection();
  }
  // Подсвечиваем карточку текущего раздела бейджем "Открыто" — в
  // полноэкранном хабе это в один клик подсказывает, где ты сейчас,
  // ещё до выбора пункта.
  function updateHubCurrentSection(){
    const current = FULLSCREEN_VIEWS.includes(currentActiveView) ? currentActiveView : 'warehouse';
    document.querySelectorAll('#app-menu-menu .menu-card').forEach(card=>{
      const isCurrent = card.dataset.hubSection === current;
      card.classList.toggle('current', isCurrent);
      const badge = card.querySelector('.mc-current-badge');
      if(badge) badge.style.display = isCurrent ? '' : 'none';
    });
  }
  const isDesktopHub = ()=> window.matchMedia('(min-width:861px)').matches;
  appMenuToggle.addEventListener('click', (e)=>{
    e.stopPropagation();
    // На десктопе разделы уже показаны строкой в шапке, а на телефоне —
    // нижней панелью навигации; в обоих случаях модалка-шторка "Разделы"
    // больше не нужна, заголовок в шапке просто статичная подпись.
    return;
  });
  appMenuToggle.addEventListener('keydown', (e)=>{
    if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); appMenuToggle.click(); }
  });
  if(appMenuClose) appMenuClose.addEventListener('click', (e)=>{ e.stopPropagation(); setAppMenuOpen(false); });
  if(appMenuBackdrop) appMenuBackdrop.addEventListener('click', ()=> setAppMenuOpen(false));
  document.addEventListener('keydown', (e)=>{
    if(e.key === 'Escape' && appMenuDropdown.classList.contains('open')) setAppMenuOpen(false);
  });
  document.addEventListener('click', (e)=>{
    if(appMenuDropdown.classList.contains('open') && !appMenuDropdown.contains(e.target)){
      setAppMenuOpen(false);
    }
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

  // ---------- MANUAL / CONTINUOUS BACKGROUND SYNC ----------
  document.getElementById('sync-btn').addEventListener('click', ()=> syncFromServer(true));

  // Poll for changes made by other users continuously, but don't yank the
  // table out from under someone who is mid-edit (an input is focused) or
  // looking at a cell's detail drawer. If a sync gets skipped for that
  // reason, `pendingSync` remembers it so we catch up as soon as the user is
  // no longer blocking it, instead of waiting out the rest of the interval
  // (or forever, if they stay mid-edit).
  let pendingSync = false;
  const SYNC_INTERVAL_MS = 5000; // continuous background sync every 5s

  function isSyncBlocked(){
    const active = document.activeElement;
    const isEditing = active && active.classList && active.classList.contains('edit-input');
    const drawerOpen = document.getElementById('drawer').classList.contains('open');
    return isEditing || drawerOpen;
  }

  function attemptSync(){
    if(!isAuthed) return;
    if(!navigator.onLine){
      setConnStatus('offline');
      pendingSync = true;
      return;
    }
    if(isSyncBlocked()){
      pendingSync = true;
      return;
    }
    pendingSync = false;
    syncFromServer(false);
  }

  setInterval(attemptSync, SYNC_INTERVAL_MS);

  // Catch up immediately once the blocker goes away, rather than waiting for
  // the next tick.
  document.addEventListener('focusout', (e)=>{
    if(pendingSync && e.target && e.target.classList && e.target.classList.contains('edit-input')){
      setTimeout(attemptSync, 0);
    }
  });

  // React instantly to the browser's own connectivity signals, rather than
  // waiting up to SYNC_INTERVAL_MS to notice the connection dropped or came back.
  window.addEventListener('offline', ()=> setConnStatus('offline'));
  window.addEventListener('online', ()=> attemptSync());

  // When the tab/app regains focus (e.g. phone screen woken up, browser tab
  // switched back to), sync right away instead of showing stale data until
  // the next scheduled tick.
  document.addEventListener('visibilitychange', ()=>{
    if(document.visibilityState === 'visible') attemptSync();
  });
  document.getElementById('drawer').addEventListener('transitionend', ()=>{
    if(pendingSync && !document.getElementById('drawer').classList.contains('open')) attemptSync();
  });

  // Tab was backgrounded/reconnected, or the browser regained network access:
  // the local copy may now be stale, so sync right away instead of waiting.
  document.addEventListener('visibilitychange', ()=>{
    if(document.visibilityState === 'visible') attemptSync();
  });
  window.addEventListener('online', attemptSync);
  window.addEventListener('focus', attemptSync);

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

  // ---------- ЗАДАНИЯ СОТРУДНИКАМ ----------
  const TASK_STATUS_LABEL = { new: 'Новое', read: 'Прочитано', in_progress: 'В работе', done: 'Готово' };
  let assignableUsersCache = null;

  function taskStatusBadge(status){
    return `<span class="task-status ${status}">${TASK_STATUS_LABEL[status] || status}</span>`;
  }

  // Клик по получателю в "Все задания команды" — маленькое окно с его
  // статусом и временем каждого шага (когда прочитал, взял в работу,
  // закончил), а не только тултип при наведении, который на телефоне
  // никак не увидеть.
  function openTaskRecipientDetails(chip){
    const taskId = chip.dataset.taskId;
    const userId = chip.dataset.userId;
    const name = chip.dataset.name || '';
    const status = chip.dataset.status || 'new';
    const rows = [
      ['Прочитано', chip.dataset.readAt],
      ['Взято в работу', chip.dataset.startedAt],
      ['Выполнено', chip.dataset.doneAt]
    ];
    const body = `
      <div style="display:flex; flex-direction:column; gap:12px;">
        <div>${taskStatusBadge(status)}</div>
        <div style="display:flex; flex-direction:column; gap:6px; font-size:13px;">
          ${rows.map(([label, ts]) => `
            <div style="display:flex; justify-content:space-between; gap:12px;">
              <span style="color:var(--ink-soft);">${label}</span>
              <span>${ts ? fmtActivityTime(ts) : '—'}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
    openModal(escHtml(name), body, '<button class="btn danger" id="task-recipient-remove">🗑 Убрать у этого сотрудника</button><button class="btn" id="task-recipient-close">Закрыть</button>');
    document.getElementById('task-recipient-close').addEventListener('click', closeModal);
    document.getElementById('task-recipient-remove').addEventListener('click', async () => {
      if(!(await confirmDialog(`Убрать это задание у сотрудника «${name}»? У остальных получателей оно останется.`, { title: 'Снять задание', okLabel: 'Убрать' }))) return;
      try{
        const res = await fetch(`${API_BASE}/api/tasks/${taskId}/recipients/${userId}`, { method: 'DELETE' });
        const payload = await res.json().catch(() => ({}));
        if(!res.ok) throw new Error(payload.error || 'Не удалось убрать задание у сотрудника');
        closeModal();
        await loadTasks();
      }catch(err){ alert(err.message); }
    });
  }

  async function refreshTasksBadge(){
    if(!isAuthed) return;
    try{
      const res = await fetch(API_BASE + '/api/tasks/unread-count');
      if(!res.ok) return;
      const { count } = await res.json();
      [document.getElementById('tasks-badge'), document.getElementById('bn-tasks-badge'), document.getElementById('app-menu-tasks-badge'), document.getElementById('hub-tile-tasks-badge')].forEach(badge => {
        if(!badge) return;
        if(count > 0){ badge.textContent = count; badge.style.display = ''; }
        else badge.style.display = 'none';
      });
    }catch(_e){ /* тихо игнорируем — это лишь бейдж */ }
  }

  function renderMyTasks(myTasks){
    const wrap = document.getElementById('my-tasks-list');
    if(!myTasks.length){
      wrap.innerHTML = '<div class="tasks-empty">Заданий пока нет.</div>';
      return;
    }
    wrap.innerHTML = myTasks.map(t => {
      let actions = '';
      if(t.status === 'read'){
        actions = `<button class="btn" data-task-action="in_progress" data-task-id="${t.id}">▶ В работу</button>`;
      } else if(t.status === 'in_progress'){
        actions = `<button class="btn primary" data-task-action="done" data-task-id="${t.id}">✔ Сделано</button>`;
      }
      return `
        <div class="task-card">
          <div class="tc-top">
            <div class="tc-text">${escHtml(t.text)}</div>
            ${taskStatusBadge(t.status)}
          </div>
          <div class="tc-meta">От: ${escHtml(t.createdByName || '—')} · ${fmtActivityTime(t.createdAt)}</div>
          ${actions ? `<div class="tc-actions">${actions}</div>` : ''}
        </div>
      `;
    }).join('');
    wrap.querySelectorAll('[data-task-action]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.taskId;
        const status = btn.dataset.taskAction;
        btn.disabled = true;
        try{
          const res = await fetch(`${API_BASE}/api/tasks/${id}/status`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status })
          });
          const payload = await res.json().catch(() => ({}));
          if(!res.ok) throw new Error(payload.error || 'Не удалось обновить статус');
          await loadTasks();
        }catch(err){
          alert(err.message);
          btn.disabled = false;
        }
      });
    });
  }

  function renderAllTasks(allTasks){
    const wrap = document.getElementById('all-tasks-list');
    if(!allTasks || !allTasks.length){
      wrap.innerHTML = '<div class="tasks-empty">Пока никому не поставлено ни одного задания.</div>';
      return;
    }
    wrap.innerHTML = allTasks.map(t => `
      <div class="task-card">
        <div class="tc-top">
          <div class="tc-text">${escHtml(t.text)}</div>
          <button class="tc-del" data-del-task="${t.id}" title="Удалить задание">🗑</button>
        </div>
        <div class="tc-meta">От: ${escHtml(t.createdByName || '—')} · ${fmtActivityTime(t.createdAt)} · получателей: ${t.recipients.length}</div>
        <div class="tc-recipients">
          ${t.recipients.map(r => `
            <span class="task-recipient-chip" data-recipient title="${TASK_STATUS_LABEL[r.status] || r.status}" data-task-id="${t.id}" data-user-id="${r.userId}" data-name="${escHtml(r.displayName)}" data-status="${r.status}" data-read-at="${r.readAt || ''}" data-started-at="${r.startedAt || ''}" data-done-at="${r.doneAt || ''}">
              <span class="dot ${r.status}"></span>${escHtml(r.displayName)}
            </span>
          `).join('')}
        </div>
      </div>
    `).join('');
    wrap.querySelectorAll('[data-recipient]').forEach(chip => {
      chip.addEventListener('click', () => openTaskRecipientDetails(chip));
    });
    wrap.querySelectorAll('[data-del-task]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if(!(await confirmDialog('Удалить это задание у всех получателей?', { title: 'Удаление задания', okLabel: 'Удалить', danger: true }))) return;
        try{
          const res = await fetch(`${API_BASE}/api/tasks/${btn.dataset.delTask}`, { method: 'DELETE' });
          const payload = await res.json().catch(() => ({}));
          if(!res.ok) throw new Error(payload.error || 'Не удалось удалить задание');
          await loadTasks();
        }catch(err){ alert(err.message); }
      });
    });
  }

  async function loadTasks(){
    const myWrap = document.getElementById('my-tasks-list');
    const allWrap = document.getElementById('all-tasks-list');
    try{
      const res = await fetch(API_BASE + '/api/tasks');
      if(!res.ok) throw new Error('Сервер вернул ошибку ' + res.status);
      const data = await res.json();
      renderMyTasks(data.myTasks || []);
      document.getElementById('manage-tasks-panel').style.display = data.canManage ? '' : 'none';
      if(data.canManage) renderAllTasks(data.allTasks || []);
      refreshTasksBadge();
    }catch(err){
      if(myWrap) myWrap.innerHTML = `<div class="tasks-empty">${escHtml(err.message)}</div>`;
      if(allWrap) allWrap.innerHTML = '';
    }
  }

  // ---------- Живая синхронизация заданий ----------
  // Пока открыт раздел "Задания" — подтягиваем список каждые несколько
  // секунд, чтобы статусы (прочитано/в работе/готово) обновлялись у всех
  // сами, без ручного нажатия "Синхронизировать". Бейдж с числом новых
  // заданий обновляется реже и постоянно, независимо от того, какой раздел
  // открыт сейчас. Пауза, пока вкладка браузера свёрнута/неактивна —
  // не грузим сервер и не мешаем работе, если человек не на странице.
  const TASKS_POLL_MS = 7000;
  const TASKS_BADGE_POLL_MS = 25000;
  let tasksPollInFlight = false;

  async function pollTasksIfOnTasksView(){
    if(!isAuthed || tasksPollInFlight || document.hidden) return;
    const view = document.getElementById('view-tasks');
    if(!view || !view.classList.contains('active')) return;
    // не мешаем, если сейчас открыта модалка (например, создание задания
    // или подтверждение удаления) — обновим список сразу после её закрытия
    if(document.getElementById('modal-backdrop')?.classList.contains('open')) return;
    tasksPollInFlight = true;
    try{ await loadTasks(); } finally { tasksPollInFlight = false; }
  }

  setInterval(pollTasksIfOnTasksView, TASKS_POLL_MS);
  setInterval(() => { if(!document.hidden) refreshTasksBadge(); }, TASKS_BADGE_POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if(!document.hidden){
      // вернулись на вкладку браузера — сразу подтянуть актуальное состояние,
      // не дожидаясь следующего тика таймера
      refreshTasksBadge();
      pollTasksIfOnTasksView();
    }
  });

  // ---------- ЧАТЫ (общий чат, ЛС, группы) ----------
  let chatsCache = [];
  let activeChatId = null;
  let activeChatInfo = null;
  let chatDirectoryCache = null;
  let oldestLoadedMsgId = null;
  let chatMessagesLoading = false;

  function fmtChatTime(iso){
    if(!iso) return '';
    const d = new Date(iso.replace(' ', 'T') + 'Z');
    return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }
  function fmtChatListTime(iso){
    if(!iso) return '';
    const d = new Date(iso.replace(' ', 'T') + 'Z');
    const now = new Date();
    if(d.toDateString() === now.toDateString()) return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  }
  function chatAvatarHtml(chat){
    if(chat.isGeneral) return `<div class="chat-avatar chat-avatar-general">💬</div>`;
    if(chat.isGroup) return `<div class="chat-avatar chat-avatar-group">${escHtml(initials(chat.title))}</div>`;
    return `<div class="chat-avatar"${chat.avatarUrl ? ` style="background-image:url('${escHtml(chat.avatarUrl)}')"` : ''}>${chat.avatarUrl ? '' : escHtml(initials(chat.title))}</div>`;
  }

  // Обновляет аватар в шапке открытого чата на месте (без пересоздания
  // элемента) — важно, чтобы id="chat-head-avatar" никогда не терялся,
  // иначе следующий openChat() не найдёт элемент и молча оборвётся ещё до
  // обновления заголовка чата.
  function applyChatHeadAvatar(chat){
    const el = document.getElementById('chat-head-avatar');
    if(!el) return;
    el.className = 'chat-avatar'
      + (chat.isGeneral ? ' chat-avatar-general' : '')
      + (chat.isGroup ? ' chat-avatar-group' : '');
    el.style.backgroundImage = (!chat.isGeneral && !chat.isGroup && chat.avatarUrl) ? `url('${chat.avatarUrl}')` : '';
    if(chat.isGeneral) el.textContent = '💬';
    else if(chat.isGroup) el.textContent = initials(chat.title);
    else el.textContent = chat.avatarUrl ? '' : initials(chat.title);
  }

  async function refreshChatsBadge(){
    if(!isAuthed) return;
    try{
      const res = await fetch(API_BASE + '/api/chats/unread-count');
      if(!res.ok) return;
      const { count } = await res.json();
      [document.getElementById('chats-badge'), document.getElementById('bn-chats-badge')].forEach(badge => {
        if(!badge) return;
        if(count > 0){ badge.textContent = count; badge.style.display = ''; }
        else badge.style.display = 'none';
      });
    }catch(_e){ /* тихо игнорируем — это лишь бейдж */ }
  }

  function renderChatsList(){
    const wrap = document.getElementById('chats-list');
    if(!chatsCache.length){
      wrap.innerHTML = '<div class="chats-empty">Чатов пока нет.</div>';
      return;
    }
    wrap.innerHTML = chatsCache.map(c => `
      <div class="chat-list-item${c.id === activeChatId ? ' active' : ''}" data-chat-id="${c.id}">
        ${chatAvatarHtml(c)}
        <div class="cli-body">
          <div class="cli-top">
            <div class="cli-title">${escHtml(c.title)}${c.isGroup ? ` <span style="font-weight:400; color:var(--ink-soft); font-size:11px;">(${c.membersCount})</span>` : ''}</div>
            <div class="cli-time">${fmtChatListTime(c.lastActivityAt)}</div>
          </div>
          <div class="cli-preview">
            <div class="cli-last">${c.lastMessage ? escHtml((c.lastMessage.mine ? 'Вы: ' : (c.isGeneral || c.isGroup) && c.lastMessage.authorName ? c.lastMessage.authorName + ': ' : '') + c.lastMessage.text) : 'Сообщений пока нет'}</div>
            ${c.unread > 0 ? `<span class="chat-unread-badge">${c.unread}</span>` : ''}
          </div>
        </div>
      </div>
    `).join('');
    wrap.querySelectorAll('[data-chat-id]').forEach(row => {
      row.addEventListener('click', () => openChat(Number(row.dataset.chatId)));
    });
  }

  async function loadChats(){
    try{
      const res = await fetch(API_BASE + '/api/chats');
      if(!res.ok) throw new Error('Сервер вернул ошибку ' + res.status);
      const data = await res.json();
      chatsCache = data.chats || [];
      renderChatsList();
      refreshChatsBadge();
    }catch(err){
      document.getElementById('chats-list').innerHTML = `<div class="chats-empty">${escHtml(err.message)}</div>`;
    }
  }

  function fmtFileSize(bytes){
    if(!bytes && bytes !== 0) return '';
    if(bytes < 1024) return `${bytes} Б`;
    if(bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
  }

  function chatAttachmentHtml(m){
    if(!m.attachmentUrl) return '';
    const url = escHtml(m.attachmentUrl);
    const type = m.attachmentType || '';
    const name = escHtml(m.attachmentName || 'файл');
    if(type.startsWith('image/')){
      return `<a class="cm-attachment" href="${url}" target="_blank" rel="noopener"><img src="${url}" alt="${name}" loading="lazy"></a>`;
    }
    if(type.startsWith('video/')){
      return `<div class="cm-attachment"><video src="${url}" controls preload="metadata"></video></div>`;
    }
    if(type.startsWith('audio/')){
      return `<div class="cm-attachment"><audio src="${url}" controls></audio></div>`;
    }
    return `<a class="cm-attachment cm-file-link" href="${url}" target="_blank" rel="noopener" download="${name}">📄 <span>${name}${m.attachmentSize ? ` · ${fmtFileSize(m.attachmentSize)}` : ''}</span></a>`;
  }

  function renderChatMessages(messages, prepend){
    const box = document.getElementById('chat-messages');
    const me = window.__currentUser;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const prevHeight = box.scrollHeight;
    let lastDay = prepend ? box.dataset.firstDay || '' : '';
    const html = messages.map(m => {
      const day = (m.createdAt || '').slice(0, 10);
      let sep = '';
      if(day !== lastDay){
        lastDay = day;
        const d = new Date((m.createdAt || '').replace(' ', 'T') + 'Z');
        sep = `<div class="chat-day-sep">${d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'long' })}</div>`;
      }
      const mine = me && m.userId === me.id;
      const showAuthor = !mine && (activeChatInfo?.isGeneral || activeChatInfo?.isGroup);
      const attachmentHtml = chatAttachmentHtml(m);
      const textHtml = m.text ? escHtml(m.text) : '';
      return `${sep}<div class="chat-msg${mine ? ' mine' : ''}" data-msg-id="${m.id}">
        ${showAuthor ? `<div class="cm-author">${escHtml(m.authorName)}</div>` : ''}
        <div class="cm-bubble">${attachmentHtml}${textHtml}</div>
        <div class="cm-time">${fmtChatTime(m.createdAt)}</div>
      </div>`;
    }).join('');
    if(prepend){
      box.dataset.firstDay = lastDay;
      box.insertAdjacentHTML('afterbegin', html);
      box.scrollTop = box.scrollHeight - prevHeight;
    } else {
      box.insertAdjacentHTML('beforeend', html);
      if(nearBottom) box.scrollTop = box.scrollHeight;
    }
  }

  async function openChat(chatId){
    activeChatId = chatId;
    activeChatInfo = chatsCache.find(c => c.id === chatId) || null;
    document.getElementById('chats-shell').classList.add('chat-open');
    document.getElementById('chats-empty-state').style.display = 'none';
    const win = document.getElementById('chat-window');
    win.style.display = 'flex';
    const box = document.getElementById('chat-messages');
    box.innerHTML = '';
    box.dataset.firstDay = '';
    oldestLoadedMsgId = null;
    renderChatsList();

    if(activeChatInfo){
      applyChatHeadAvatar(activeChatInfo);
      document.getElementById('chat-head-title').textContent = activeChatInfo.title;
      document.getElementById('chat-head-sub').textContent = activeChatInfo.isGeneral ? 'все сотрудники' : activeChatInfo.isGroup ? `${activeChatInfo.membersCount} участников` : '';
      document.getElementById('chat-members-btn').style.display = (activeChatInfo.isGeneral || activeChatInfo.isGroup) ? '' : 'none';
      document.getElementById('chat-delete-dm-btn').style.display = (!activeChatInfo.isGeneral && !activeChatInfo.isGroup) ? '' : 'none';
    }

    try{
      const res = await fetch(`${API_BASE}/api/chats/${chatId}/messages`);
      if(!res.ok) throw new Error('Не удалось загрузить сообщения');
      const data = await res.json();
      renderChatMessages(data.messages || [], false);
      if(data.messages && data.messages.length) oldestLoadedMsgId = data.messages[0].id;
      box.scrollTop = box.scrollHeight;
      await fetch(`${API_BASE}/api/chats/${chatId}/read`, { method: 'POST' });
      const item = chatsCache.find(c => c.id === chatId);
      if(item) item.unread = 0;
      renderChatsList();
      refreshChatsBadge();
    }catch(err){
      box.innerHTML = `<div class="chats-empty">${escHtml(err.message)}</div>`;
    }
    document.getElementById('chat-input').focus();
  }

  function closeChatMobile(){
    document.getElementById('chats-shell').classList.remove('chat-open');
  }

  document.getElementById('chat-back-btn').addEventListener('click', closeChatMobile);

  document.getElementById('chat-delete-dm-btn').addEventListener('click', async () => {
    if(!activeChatId) return;
    if(!(await confirmDialog('Удалить эту переписку целиком? Вся история и вложения будут удалены безвозвратно, для обоих собеседников.', { title: 'Удаление переписки', okLabel: 'Удалить', danger: true }))) return;
    try{
      const r = await fetch(`${API_BASE}/api/chats/${activeChatId}`, { method: 'DELETE' });
      if(!r.ok) throw new Error((await r.json().catch(()=>({}))).error || 'Не удалось удалить чат');
      activeChatId = null; activeChatInfo = null;
      document.getElementById('chat-window').style.display = 'none';
      document.getElementById('chats-empty-state').style.display = '';
      closeChatMobile();
      await loadChats();
    }catch(err){ alert(err.message); }
  });

  document.getElementById('chat-messages').addEventListener('scroll', async (e) => {
    const box = e.target;
    if(box.scrollTop > 40 || chatMessagesLoading || !oldestLoadedMsgId || !activeChatId) return;
    chatMessagesLoading = true;
    try{
      const res = await fetch(`${API_BASE}/api/chats/${activeChatId}/messages?beforeId=${oldestLoadedMsgId}`);
      if(!res.ok) return;
      const data = await res.json();
      if(data.messages && data.messages.length){
        renderChatMessages(data.messages, true);
        oldestLoadedMsgId = data.messages[0].id;
      } else {
        oldestLoadedMsgId = null; // больше нечего подгружать
      }
    }catch(_e){ /* тихо игнорируем */ } finally { chatMessagesLoading = false; }
  });

  let pendingAttachment = null; // File выбранный через 📎, ждёт отправки вместе с сообщением

  const chatAttachInput = document.getElementById('chat-attach-input');
  const chatAttachPreview = document.getElementById('chat-attach-preview');

  document.getElementById('chat-attach-btn').addEventListener('click', () => {
    if(!activeChatId) return;
    chatAttachInput.click();
  });

  chatAttachInput.addEventListener('change', () => {
    const file = chatAttachInput.files && chatAttachInput.files[0];
    if(!file) return;
    if(file.size > 25 * 1024 * 1024){
      alert('Файл слишком большой (максимум 25 МБ)');
      chatAttachInput.value = '';
      return;
    }
    pendingAttachment = file;
    renderAttachPreview();
  });

  function renderAttachPreview(){
    if(!pendingAttachment){
      chatAttachPreview.style.display = 'none';
      chatAttachPreview.innerHTML = '';
      return;
    }
    const isImage = pendingAttachment.type.startsWith('image/');
    const thumb = isImage ? `<img src="${URL.createObjectURL(pendingAttachment)}" alt="">` : '📎';
    chatAttachPreview.style.display = 'flex';
    chatAttachPreview.innerHTML = `${thumb}<span class="cap-name">${escHtml(pendingAttachment.name)}</span><button type="button" class="cap-remove" id="cap-remove-btn" title="Убрать">✕</button>`;
    document.getElementById('cap-remove-btn').addEventListener('click', () => {
      pendingAttachment = null;
      chatAttachInput.value = '';
      renderAttachPreview();
    });
  }

  document.getElementById('chat-input-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if(!activeChatId) return;
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    const attachment = pendingAttachment;
    if(!text && !attachment) return;
    input.value = '';
    input.disabled = true;
    document.getElementById('chat-attach-btn').disabled = true;
    try{
      let body, headers;
      if(attachment){
        const fd = new FormData();
        fd.append('text', text);
        fd.append('attachment', attachment);
        body = fd; headers = undefined; // браузер сам проставит multipart boundary
      } else {
        body = JSON.stringify({ text });
        headers = { 'Content-Type': 'application/json' };
      }
      const res = await fetch(`${API_BASE}/api/chats/${activeChatId}/messages`, { method: 'POST', headers, body });
      const payload = await res.json().catch(() => ({}));
      if(!res.ok) throw new Error(payload.error || 'Не удалось отправить сообщение');
      renderChatMessages([payload.message], false);
      const box = document.getElementById('chat-messages');
      box.scrollTop = box.scrollHeight;
      pendingAttachment = null;
      chatAttachInput.value = '';
      renderAttachPreview();
      loadChats(); // обновить превью/сортировку списка чатов
    }catch(err){
      alert(err.message);
      input.value = text;
    } finally {
      input.disabled = false;
      document.getElementById('chat-attach-btn').disabled = false;
      input.focus();
    }
  });

  async function loadChatDirectory(force){
    if(chatDirectoryCache && !force) return chatDirectoryCache;
    const res = await fetch(API_BASE + '/api/chats/directory');
    if(!res.ok) throw new Error('Не удалось загрузить список сотрудников');
    const data = await res.json();
    chatDirectoryCache = data.users;
    return chatDirectoryCache;
  }

  function userPickerRowHtml(u){
    return `
      <label class="assign-user-row" data-uid="${u.id}">
        <input type="checkbox" value="${u.id}">
        <span class="au-avatar"${u.avatarUrl ? ` style="background-image:url('${escHtml(u.avatarUrl)}')"` : ''}>${u.avatarUrl ? '' : escHtml(initials(u.displayName))}</span>
        <span class="au-name">${escHtml(u.displayName)}</span>
      </label>
    `;
  }

  async function openNewGroupModal(){
    let users;
    try{ users = await loadChatDirectory(); }
    catch(err){ alert(err.message); return; }

    openModal('Новая группа', `
      <div class="form-field full" style="margin-bottom:10px;">
        <label style="display:block; font-size:12px; color:var(--ink-soft); margin-bottom:4px;">Название группы</label>
        <input type="text" id="ng-title" placeholder="Например, «Смена А»" style="width:100%; padding:9px 10px; border:1px solid var(--line); border-radius:7px; font-family:var(--sans); font-size:13.5px; background:var(--panel); color:var(--ink); box-sizing:border-box;">
      </div>
      <div class="form-field full">
        <label style="font-size:12px; color:var(--ink-soft); display:block; margin-bottom:6px;">Участники</label>
        <div class="assign-user-search"><input type="text" id="ng-search" placeholder="Поиск по имени…" autocomplete="off"></div>
        <div class="assign-user-count" id="ng-count">Выбрано: 0</div>
        <div class="assign-user-list" id="ng-user-list">
          ${users.map(userPickerRowHtml).join('') || '<div class="assign-user-empty">Нет доступных сотрудников</div>'}
        </div>
      </div>
      <div id="ng-error" style="display:none; color:var(--danger); font-size:12.5px; margin-top:8px;"></div>
    `, `<button class="btn" id="ng-cancel">Отмена</button><button class="btn primary" id="ng-submit">Создать группу</button>`);

    const listEl = document.getElementById('ng-user-list');
    const countEl = document.getElementById('ng-count');
    function updateCount(){ countEl.textContent = `Выбрано: ${listEl.querySelectorAll('input[type=checkbox]:checked').length}`; }
    listEl.querySelectorAll('input[type=checkbox]').forEach(box => box.addEventListener('change', updateCount));
    document.getElementById('ng-search').addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      listEl.querySelectorAll('.assign-user-row').forEach(row => {
        row.style.display = (!q || row.querySelector('.au-name').textContent.toLowerCase().includes(q)) ? '' : 'none';
      });
    });
    document.getElementById('ng-cancel').addEventListener('click', closeModal);
    document.getElementById('ng-submit').addEventListener('click', async () => {
      const errEl = document.getElementById('ng-error');
      errEl.style.display = 'none';
      const title = document.getElementById('ng-title').value.trim();
      const memberIds = Array.from(listEl.querySelectorAll('input[type=checkbox]:checked')).map(b => Number(b.value));
      if(!title){ errEl.textContent = 'Введите название группы'; errEl.style.display = 'block'; return; }
      if(!memberIds.length){ errEl.textContent = 'Выберите хотя бы одного участника'; errEl.style.display = 'block'; return; }
      try{
        const res = await fetch(API_BASE + '/api/chats/groups', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, memberIds })
        });
        const payload = await res.json().catch(() => ({}));
        if(!res.ok) throw new Error(payload.error || 'Не удалось создать группу');
        closeModal();
        await loadChats();
        if(payload.chat) openChat(payload.chat.id);
      }catch(err){
        errEl.textContent = err.message; errEl.style.display = 'block';
      }
    });
  }

  document.getElementById('new-group-btn').addEventListener('click', openNewGroupModal);

  // ---------- Новое ЛС: «+» — выбрать человека из списка/поиска и открыть с ним личный чат ----------
  async function startDmWith(userId){
    try{
      const res = await fetch(API_BASE + '/api/chats/dm', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId })
      });
      const payload = await res.json().catch(() => ({}));
      if(!res.ok) throw new Error(payload.error || 'Не удалось открыть чат');
      closeModal();
      await loadChats();
      if(payload.chat) openChat(payload.chat.id);
    }catch(err){ alert(err.message); }
  }

  async function openNewDmModal(){
    let users;
    try{ users = await loadChatDirectory(); }
    catch(err){ alert(err.message); return; }

    openModal('Личное сообщение', `
      <div class="form-field full">
        <label style="font-size:12px; color:var(--ink-soft); display:block; margin-bottom:6px;">Кому написать</label>
        <div class="assign-user-search"><input type="text" id="nd-search" placeholder="Поиск по имени…" autocomplete="off"></div>
        <div class="assign-user-list" id="nd-user-list">
          ${users.map(u => `
            <label class="assign-user-row" data-uid="${u.id}" data-open-dm-pick="${u.id}">
              <span class="au-avatar"${u.avatarUrl ? ` style="background-image:url('${escHtml(u.avatarUrl)}')"` : ''}>${u.avatarUrl ? '' : escHtml(initials(u.displayName))}</span>
              <span class="au-name">${escHtml(u.displayName)}</span>
            </label>
          `).join('') || '<div class="assign-user-empty">Нет доступных сотрудников</div>'}
        </div>
      </div>
    `, `<button class="btn" id="nd-cancel">Отмена</button>`);

    const listEl = document.getElementById('nd-user-list');
    document.getElementById('nd-search').addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      listEl.querySelectorAll('.assign-user-row').forEach(row => {
        row.style.display = (!q || row.querySelector('.au-name').textContent.toLowerCase().includes(q)) ? '' : 'none';
      });
    });
    listEl.querySelectorAll('[data-open-dm-pick]').forEach(row => {
      row.addEventListener('click', () => startDmWith(Number(row.dataset.openDmPick)));
    });
    document.getElementById('nd-cancel').addEventListener('click', closeModal);
  }

  document.getElementById('new-dm-btn').addEventListener('click', openNewDmModal);

  // Клик по коллеге в списке "Сотрудники"/директории аккаунтов — открыть с ним ЛС.
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-open-dm]');
    if(!btn) return;
    const userId = Number(btn.dataset.openDm);
    try{
      const res = await fetch(API_BASE + '/api/chats/dm', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId })
      });
      const payload = await res.json().catch(() => ({}));
      if(!res.ok) throw new Error(payload.error || 'Не удалось открыть чат');
      activateView('chats');
      await loadChats();
      if(payload.chat) openChat(payload.chat.id);
    }catch(err){ alert(err.message); }
  });

  async function openChatMembersModal(){
    if(!activeChatId || !activeChatInfo) return;
    try{
      const res = await fetch(`${API_BASE}/api/chats/${activeChatId}/members`);
      if(!res.ok) throw new Error('Не удалось загрузить участников');
      const data = await res.json();
      const members = data.members || [];
      const canAdd = activeChatInfo.isGroup;
      const me = window.__currentUser;
      const canDelete = activeChatInfo.isGroup && me && activeChatInfo.createdBy === me.id;
      openModal(activeChatInfo.isGeneral ? 'Участники общего чата' : 'Участники группы', `
        <div id="chat-members-list">
          ${members.map(u => `<div class="cm-member-row">${chatAvatarHtml({ title: u.displayName, avatarUrl: u.avatarUrl })}<span>${escHtml(u.displayName)}</span>${(activeChatInfo.isGroup && u.id === activeChatInfo.createdBy) ? '<span class="role-badge" style="margin-left:auto; background:var(--accent-soft); color:var(--accent); font-size:11px; padding:3px 9px; border-radius:999px;">Владелец</span>' : ''}</div>`).join('')}
        </div>
      `, canAdd
        ? `${canDelete ? '<button class="btn danger" id="cm-delete-group">🗑 Удалить группу</button>' : ''}<button class="btn" id="cm-leave">Покинуть группу</button><button class="btn primary" id="cm-add">+ Добавить участников</button>`
        : '');
      if(canDelete){
        document.getElementById('cm-delete-group').addEventListener('click', async () => {
          if(!(await confirmDialog('Удалить группу целиком? Вся переписка и вложения будут удалены безвозвратно, для всех участников.', { title: 'Удаление группы', okLabel: 'Удалить', danger: true }))) return;
          try{
            const r = await fetch(`${API_BASE}/api/chats/${activeChatId}`, { method: 'DELETE' });
            if(!r.ok) throw new Error((await r.json().catch(()=>({}))).error || 'Не удалось удалить группу');
            closeModal();
            activeChatId = null; activeChatInfo = null;
            document.getElementById('chat-window').style.display = 'none';
            document.getElementById('chats-empty-state').style.display = '';
            closeChatMobile();
            await loadChats();
          }catch(err){ alert(err.message); }
        });
      }
      if(canAdd){
        document.getElementById('cm-leave').addEventListener('click', async () => {
          if(!(await confirmDialog('Покинуть эту группу?', { title: 'Выход из группы', okLabel: 'Покинуть' }))) return;
          try{
            const r = await fetch(`${API_BASE}/api/chats/${activeChatId}/leave`, { method: 'POST' });
            if(!r.ok) throw new Error((await r.json().catch(()=>({}))).error || 'Не удалось выйти из группы');
            closeModal();
            activeChatId = null; activeChatInfo = null;
            document.getElementById('chat-window').style.display = 'none';
            document.getElementById('chats-empty-state').style.display = '';
            closeChatMobile();
            await loadChats();
          }catch(err){ alert(err.message); }
        });
        document.getElementById('cm-add').addEventListener('click', async () => {
          let users;
          try{ users = await loadChatDirectory(true); } catch(err){ alert(err.message); return; }
          const existingIds = new Set(members.map(m => m.id));
          const candidates = users.filter(u => !existingIds.has(u.id));
          openModal('Добавить участников', `
            <div class="assign-user-search"><input type="text" id="am-search" placeholder="Поиск по имени…" autocomplete="off"></div>
            <div class="assign-user-count" id="am-count">Выбрано: 0</div>
            <div class="assign-user-list" id="am-user-list">
              ${candidates.map(userPickerRowHtml).join('') || '<div class="assign-user-empty">Добавлять больше некого</div>'}
            </div>
            <div id="am-error" style="display:none; color:var(--danger); font-size:12.5px; margin-top:8px;"></div>
          `, `<button class="btn" id="am-cancel">Отмена</button><button class="btn primary" id="am-submit">Добавить</button>`);
          const listEl = document.getElementById('am-user-list');
          const countEl = document.getElementById('am-count');
          listEl.querySelectorAll('input[type=checkbox]').forEach(box => box.addEventListener('change', () => {
            countEl.textContent = `Выбрано: ${listEl.querySelectorAll('input[type=checkbox]:checked').length}`;
          }));
          document.getElementById('am-search').addEventListener('input', (e) => {
            const q = e.target.value.trim().toLowerCase();
            listEl.querySelectorAll('.assign-user-row').forEach(row => {
              row.style.display = (!q || row.querySelector('.au-name').textContent.toLowerCase().includes(q)) ? '' : 'none';
            });
          });
          document.getElementById('am-cancel').addEventListener('click', closeModal);
          document.getElementById('am-submit').addEventListener('click', async () => {
            const memberIds = Array.from(listEl.querySelectorAll('input[type=checkbox]:checked')).map(b => Number(b.value));
            const errEl = document.getElementById('am-error');
            if(!memberIds.length){ errEl.textContent = 'Выберите хотя бы одного человека'; errEl.style.display = 'block'; return; }
            try{
              const r = await fetch(`${API_BASE}/api/chats/${activeChatId}/members`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ memberIds })
              });
              const p = await r.json().catch(() => ({}));
              if(!r.ok) throw new Error(p.error || 'Не удалось добавить участников');
              closeModal();
              await loadChats();
            }catch(err){ errEl.textContent = err.message; errEl.style.display = 'block'; }
          });
        });
      }
    }catch(err){ alert(err.message); }
  }
  document.getElementById('chat-members-btn').addEventListener('click', openChatMembersModal);

  // ---------- Живая синхронизация чатов ----------
  const CHATS_POLL_MS = 4000;
  const CHATS_BADGE_POLL_MS = 20000;
  let chatsPollInFlight = false;

  async function pollChatsIfOnChatsView(){
    if(!isAuthed || chatsPollInFlight || document.hidden) return;
    const view = document.getElementById('view-chats');
    if(!view || !view.classList.contains('active')) return;
    if(document.getElementById('modal-backdrop')?.classList.contains('open')) return;
    chatsPollInFlight = true;
    try{
      if(activeChatId){
        // в открытом чате — только подтягиваем новые сообщения, не перерисовывая всё
        const res = await fetch(`${API_BASE}/api/chats/${activeChatId}/messages`);
        if(res.ok){
          const data = await res.json();
          const box = document.getElementById('chat-messages');
          const known = new Set(Array.from(box.querySelectorAll('[data-msg-id]')).map(el => Number(el.dataset.msgId)));
          const fresh = (data.messages || []).filter(m => !known.has(m.id));
          if(fresh.length){
            renderChatMessages(fresh, false);
            await fetch(`${API_BASE}/api/chats/${activeChatId}/read`, { method: 'POST' });
          }
        }
        await loadChats();
      } else {
        await loadChats();
      }
    } finally { chatsPollInFlight = false; }
  }
  setInterval(pollChatsIfOnChatsView, CHATS_POLL_MS);
  setInterval(() => { if(!document.hidden) refreshChatsBadge(); }, CHATS_BADGE_POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if(!document.hidden){
      refreshChatsBadge();
      pollChatsIfOnChatsView();
    }
  });

  async function loadAssignableUsers(force){
    if(assignableUsersCache && !force) return assignableUsersCache;
    const res = await fetch(API_BASE + '/api/tasks/assignable-users');
    if(!res.ok) throw new Error('Не удалось загрузить список сотрудников');
    const data = await res.json();
    assignableUsersCache = data.users;
    return assignableUsersCache;
  }

  async function openNewTaskModal(){
    let users;
    try{
      users = await loadAssignableUsers();
    }catch(err){
      alert(err.message);
      return;
    }
    const rowHtml = (u) => `
      <label class="assign-user-row" data-uid="${u.id}">
        <input type="checkbox" value="${u.id}">
        <span class="au-avatar"${u.avatarUrl ? ` style="background-image:url('${escHtml(u.avatarUrl)}')"` : ''}>${u.avatarUrl ? '' : escHtml(initials(u.displayName))}</span>
        <span class="au-name">${escHtml(u.displayName)}</span>
        <span class="role">${escHtml(u.roleLabel)}</span>
      </label>
    `;
    openModal('Новое задание', `
      <div class="form-field full" style="margin-bottom:10px;">
        <label style="display:block; font-size:12px; color:var(--ink-soft); margin-bottom:4px;">Текст задания</label>
        <textarea id="nt-text" rows="4" style="width:100%; padding:9px 10px; border:1px solid var(--line); border-radius:7px; font-family:var(--sans); font-size:13.5px; background:var(--panel); color:var(--ink); resize:vertical; box-sizing:border-box;" placeholder="Что нужно сделать…"></textarea>
      </div>
      <div class="form-field full">
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:6px;">
          <label style="font-size:12px; color:var(--ink-soft); margin:0;">Кому (можно несколько)</label>
          <button type="button" class="btn" id="nt-select-all" style="padding:4px 8px; font-size:11px;">Выбрать всех</button>
        </div>
        <div class="assign-user-search">
          <input type="text" id="nt-search" placeholder="Поиск по имени…" autocomplete="off">
        </div>
        <div class="assign-user-count" id="nt-count">Выбрано: 0</div>
        <div class="assign-user-list" id="nt-user-list">
          ${users.map(rowHtml).join('') || '<div class="assign-user-empty">Нет доступных сотрудников</div>'}
        </div>
      </div>
      <div id="nt-error" style="display:none; color:var(--danger); font-size:12.5px; margin-top:8px;"></div>
    `, `<button class="btn" id="nt-cancel">Отмена</button><button class="btn primary" id="nt-submit">Отправить задание</button>`);

    const listEl = document.getElementById('nt-user-list');
    const countEl = document.getElementById('nt-count');

    function updateRowState(row){
      const box = row.querySelector('input[type=checkbox]');
      row.classList.toggle('checked', box.checked);
    }
    function updateCount(){
      const n = listEl.querySelectorAll('input[type=checkbox]:checked').length;
      countEl.textContent = `Выбрано: ${n}`;
    }
    listEl.querySelectorAll('.assign-user-row').forEach(row => {
      row.querySelector('input[type=checkbox]').addEventListener('change', () => { updateRowState(row); updateCount(); });
    });

    document.getElementById('nt-search').addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      let visibleCount = 0;
      listEl.querySelectorAll('.assign-user-row').forEach(row => {
        const name = row.querySelector('.au-name').textContent.toLowerCase();
        const role = row.querySelector('.role').textContent.toLowerCase();
        const match = !q || name.includes(q) || role.includes(q);
        row.style.display = match ? '' : 'none';
        if(match) visibleCount++;
      });
      let emptyEl = listEl.querySelector('.assign-user-empty');
      if(visibleCount === 0 && users.length){
        if(!emptyEl){
          emptyEl = document.createElement('div');
          emptyEl.className = 'assign-user-empty';
          emptyEl.textContent = 'Никого не нашлось';
          listEl.appendChild(emptyEl);
        }
      } else if(emptyEl && emptyEl.textContent === 'Никого не нашлось'){
        emptyEl.remove();
      }
    });

    document.getElementById('nt-cancel').addEventListener('click', closeModal);
    document.getElementById('nt-select-all').addEventListener('click', () => {
      const rows = Array.from(listEl.querySelectorAll('.assign-user-row')).filter(r => r.style.display !== 'none');
      const allChecked = rows.every(r => r.querySelector('input[type=checkbox]').checked);
      rows.forEach(r => {
        const box = r.querySelector('input[type=checkbox]');
        box.checked = !allChecked;
        updateRowState(r);
      });
      updateCount();
    });
    document.getElementById('nt-submit').addEventListener('click', async () => {
      const errEl = document.getElementById('nt-error');
      errEl.style.display = 'none';
      const text = document.getElementById('nt-text').value.trim();
      const userIds = Array.from(listEl.querySelectorAll('input[type=checkbox]:checked')).map(b => Number(b.value));
      if(!text){ errEl.textContent = 'Введите текст задания'; errEl.style.display = 'block'; return; }
      if(!userIds.length){ errEl.textContent = 'Выберите хотя бы одного сотрудника'; errEl.style.display = 'block'; return; }
      try{
        const res = await fetch(API_BASE + '/api/tasks', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, userIds })
        });
        const payload = await res.json().catch(() => ({}));
        if(!res.ok) throw new Error(payload.error || 'Не удалось создать задание');
        closeModal();
        await loadTasks();
      }catch(err){
        errEl.textContent = err.message;
        errEl.style.display = 'block';
      }
    });
  }

  const newTaskBtn = document.getElementById('new-task-btn');
  if(newTaskBtn) newTaskBtn.addEventListener('click', openNewTaskModal);

  // ---------- АРХИВ ЗАДАНИЙ В EXCEL (все задания и их получатели, включая удалённые) ----------
  const tasksExportBtn = document.getElementById('tasks-export-btn');
  if(tasksExportBtn) tasksExportBtn.addEventListener('click', async () => {
    const prevLabel = tasksExportBtn.textContent;
    let done = false;
    const resetBtn = () => {
      if(done) return;
      done = true;
      tasksExportBtn.disabled = false;
      tasksExportBtn.textContent = prevLabel;
      progressEnd();
    };
    // Страховка: даже если что-то зависнет (сеть, прокси и т.п.), кнопка
    // сама вернётся в обычный вид максимум через 20 секунд — не должна
    // оставаться "Формирую…" навсегда.
    const safetyTimer = setTimeout(resetBtn, 20000);

    tasksExportBtn.disabled = true;
    tasksExportBtn.textContent = '⏳ Формирую…';
    progressStart('Формирование архива на сервере…');
    try{
      const res = await fetch(API_BASE + '/api/tasks/export');
      if(!res.ok) throw new Error('HTTP '+res.status);
      let filename = 'архив_заданий.xlsx';
      const disp = res.headers.get('Content-Disposition') || '';
      const starMatch = disp.match(/filename\*=UTF-8''([^;]+)/i);
      if(starMatch) filename = decodeURIComponent(starMatch[1]);

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(()=>URL.revokeObjectURL(url), 2000);
      setSyncStatus('архив заданий скачан · ' + new Date().toLocaleTimeString('ru-RU'));
    }catch(err){
      setSyncStatus('ошибка выгрузки архива заданий', true);
      alert('Не удалось скачать архив: ' + err.message);
    }finally{
      clearTimeout(safetyTimer);
      resetBtn();
    }
  });

  // ---------- АККАУНТЫ: заявки на регистрацию ----------
  let rolesForApprovalCache = null;

  async function loadRolesForApproval(){
    if(rolesForApprovalCache) return rolesForApprovalCache;
    const res = await fetch(API_BASE + '/api/roles');
    if(!res.ok) throw new Error('Не удалось загрузить список ролей');
    const data = await res.json();
    rolesForApprovalCache = (data.roles || []).filter(r => r.key !== 'service');
    return rolesForApprovalCache;
  }

  async function refreshAccountsBadge(){
    if(!isAuthed) return;
    if(document.body.classList.contains('perm-no-manage-users')) return;
    try{
      const res = await fetch(API_BASE + '/api/registration-requests/count');
      if(!res.ok) return;
      const { count } = await res.json();
      [document.getElementById('bn-accounts-badge'), document.getElementById('hub-tile-accounts-badge')].forEach(badge => {
        if(!badge) return;
        if(count > 0){ badge.textContent = count; badge.style.display = ''; }
        else badge.style.display = 'none';
      });
    }catch(_e){ /* тихо игнорируем — это лишь бейдж */ }
  }

  async function renderRegRequests(requests){
    const wrap = document.getElementById('reg-requests-list');
    if(!requests.length){
      wrap.innerHTML = '<div class="tasks-empty">Новых заявок нет.</div>';
      return;
    }
    let roles;
    try{ roles = await loadRolesForApproval(); }
    catch(err){ wrap.innerHTML = `<div class="tasks-empty">${escHtml(err.message)}</div>`; return; }

    wrap.innerHTML = requests.map(r => `
      <div class="reg-card" data-req-id="${r.id}">
        <span class="au-avatar">${escHtml(initials(r.displayName))}</span>
        <div class="reg-info">
          <div class="reg-name">${escHtml(r.displayName)}</div>
          <div class="reg-meta">логин: ${escHtml(r.username)} · подана ${fmtActivityTime(r.createdAt)}</div>
        </div>
        <div class="reg-actions">
          <select data-role-select>
            ${roles.map(role => `<option value="${escHtml(role.key)}" ${role.key === 'employee' ? 'selected' : ''}>${escHtml(role.label)}</option>`).join('')}
          </select>
          <button class="btn primary" data-approve="${r.id}">✔ Одобрить</button>
          <button class="btn" data-reject="${r.id}">✕ Отклонить</button>
        </div>
      </div>
    `).join('');

    wrap.querySelectorAll('[data-approve]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const card = btn.closest('.reg-card');
        const role = card.querySelector('[data-role-select]').value;
        btn.disabled = true;
        card.querySelector('[data-reject]').disabled = true;
        try{
          const res = await fetch(`${API_BASE}/api/registration-requests/${btn.dataset.approve}/approve`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role })
          });
          const payload = await res.json().catch(() => ({}));
          if(!res.ok) throw new Error(payload.error || 'Не удалось одобрить заявку');
          await loadAccounts();
          // Одобрение создаёт нового пользователя — обновим и список
          // аккаунтов (он живёт в auth.js и сам по себе не знает об этом).
          if(window.__loadUsersRolesPanel) window.__loadUsersRolesPanel();
        }catch(err){
          alert(err.message);
          btn.disabled = false;
          card.querySelector('[data-reject]').disabled = false;
        }
      });
    });
    wrap.querySelectorAll('[data-reject]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if(!(await confirmDialog('Отклонить эту заявку? Отменить будет нельзя — сотруднику нужно будет подать заявку заново.', { title: 'Отклонение заявки', okLabel: 'Отклонить' }))) return;
        const card = btn.closest('.reg-card');
        btn.disabled = true;
        card.querySelector('[data-approve]').disabled = true;
        try{
          const res = await fetch(`${API_BASE}/api/registration-requests/${btn.dataset.reject}/reject`, { method: 'POST' });
          const payload = await res.json().catch(() => ({}));
          if(!res.ok) throw new Error(payload.error || 'Не удалось отклонить заявку');
          await loadAccounts();
        }catch(err){
          alert(err.message);
          btn.disabled = false;
          card.querySelector('[data-approve]').disabled = false;
        }
      });
    });
  }

  async function loadAccounts(){
    const wrap = document.getElementById('reg-requests-list');
    try{
      const res = await fetch(API_BASE + '/api/registration-requests');
      if(!res.ok) throw new Error('Сервер вернул ошибку ' + res.status);
      const data = await res.json();
      await renderRegRequests(data.requests || []);
      refreshAccountsBadge();
    }catch(err){
      if(wrap) wrap.innerHTML = `<div class="tasks-empty">${escHtml(err.message)}</div>`;
    }
  }

  // ---------- «Сотрудники»: простой список коллег и их ролей для тех, у
  // кого нет прав на управление аккаунтами (см. #accounts-directory-panel).
  // Поддерживает поиск по имени/логину и фильтр по роли, с группировкой
  // списка по ролям. ----------
  let lastDirUsers = [];
  let dirControlsWired = false;

  function matchesDirSearch(u, term){
    if(!term) return true;
    const label = (u.displayName || u.username || '').toLowerCase();
    const login = (u.username || '').toLowerCase();
    return label.includes(term) || login.includes(term);
  }

  function fillDirRoleFilter(users){
    const sel = document.getElementById('dir-role-filter');
    if(!sel) return;
    const prevValue = sel.value;
    const seen = new Set();
    const opts = ['<option value="">Все роли</option>'];
    users.forEach(u => {
      if(seen.has(u.role)) return;
      seen.add(u.role);
      opts.push(`<option value="${escHtml(u.role)}">${escHtml(u.roleLabel)}</option>`);
    });
    sel.innerHTML = opts.join('');
    if(seen.has(prevValue)) sel.value = prevValue;
  }

  function wireDirControlsOnce(){
    if(dirControlsWired) return;
    const search = document.getElementById('dir-search');
    const roleFilter = document.getElementById('dir-role-filter');
    if(!search || !roleFilter) return;
    dirControlsWired = true;
    search.addEventListener('input', () => renderAccountsDirectory(lastDirUsers, { keepFilterOptions: true }));
    roleFilter.addEventListener('change', () => renderAccountsDirectory(lastDirUsers, { keepFilterOptions: true }));
  }

  function renderAccountsDirectory(users, opts){
    opts = opts || {};
    const wrap = document.getElementById('accounts-directory-list');
    if(!wrap) return;
    if(!users.length){
      wrap.innerHTML = '<div class="tasks-empty">Пока нет ни одного аккаунта.</div>';
      return;
    }
    if(!opts.keepFilterOptions) fillDirRoleFilter(users);

    const searchTerm = (document.getElementById('dir-search')?.value || '').trim().toLowerCase();
    const roleFilterValue = document.getElementById('dir-role-filter')?.value || '';
    const filtered = users.filter(u =>
      matchesDirSearch(u, searchTerm) && (!roleFilterValue || u.role === roleFilterValue)
    );
    if(!filtered.length){
      wrap.innerHTML = '<div class="tasks-empty">Ничего не найдено.</div>';
      return;
    }

    // Группируем по роли, порядок категорий — по первому появлению роли в
    // исходном списке (он приходит от сервера уже в стабильном порядке).
    const roleOrder = [];
    const roleLabelByKey = {};
    users.forEach(u => {
      if(!roleLabelByKey[u.role]){ roleLabelByKey[u.role] = u.roleLabel; roleOrder.push(u.role); }
    });

    wrap.innerHTML = roleOrder.map(roleKey => {
      const inRole = filtered.filter(u => u.role === roleKey);
      if(!inRole.length) return '';
      return `
        <div class="users-role-group">
          <div class="users-role-heading">${escHtml(roleLabelByKey[roleKey])} <span class="users-role-count">${inRole.length}</span></div>
          ${inRole.map(u => `
            <div class="dir-row">
              <div class="u-avatar"${u.avatarUrl ? ` style="background-image:url('${escHtml(u.avatarUrl)}')"` : ''}>${u.avatarUrl ? '' : escHtml(initials(u.displayName))}</div>
              <div class="u-info">
                <div class="u-name">${escHtml(u.displayName)}</div>
                <div class="u-login">@${escHtml(u.username)}</div>
                <div class="u-status"><span class="u-status-dot${u.online ? ' online' : ''}"></span>${escHtml(formatLastSeen(u))}</div>
              </div>
              <span class="role-badge" style="background:var(--accent-soft); color:var(--accent); font-size:11px; padding:3px 9px; border-radius:999px;">${escHtml(u.roleLabel)}</span>
              ${(window.__currentUser && u.id !== window.__currentUser.id) ? `<button class="btn" data-open-dm="${u.id}" title="Написать" style="padding:6px 9px; font-size:12px;">💬</button>` : ''}
            </div>
          `).join('')}
        </div>`;
    }).join('');
  }

  async function loadAccountsDirectory(){
    const wrap = document.getElementById('accounts-directory-list');
    try{
      wireDirControlsOnce();
      const res = await fetch(API_BASE + '/api/users/directory');
      if(!res.ok) throw new Error('Сервер вернул ошибку ' + res.status);
      const data = await res.json();
      // Сервисный аккаунт — служебная запись для системы, не сотрудник;
      // не показываем его ни в списке, ни в фильтре по ролям.
      lastDirUsers = (data.users || []).filter(u => u.role !== 'service');
      renderAccountsDirectory(lastDirUsers);
    }catch(err){
      if(wrap) wrap.innerHTML = `<div class="tasks-empty">${escHtml(err.message)}</div>`;
    }
  }

  // Живая синхронизация — как у заданий: пока открыт раздел "Аккаунты",
  // подтягиваем заявки каждые несколько секунд.
  let accountsPollInFlight = false;
  async function pollAccountsIfOnAccountsView(){
    if(!isAuthed || accountsPollInFlight || document.hidden) return;
    const view = document.getElementById('view-accounts');
    if(!view || !view.classList.contains('active')) return;
    if(document.getElementById('modal-backdrop')?.classList.contains('open')) return;
    if(document.getElementById('auth-modal-backdrop')?.classList.contains('show')) return;
    accountsPollInFlight = true;
    try{
      if(document.body.classList.contains('perm-no-manage-users')) await loadAccountsDirectory();
      else {
        await loadAccounts();
        if(window.__refreshUsersListIfIdle) window.__refreshUsersListIfIdle();
      }
    } finally { accountsPollInFlight = false; }
  }
  setInterval(pollAccountsIfOnAccountsView, TASKS_POLL_MS);
  setInterval(() => { if(!document.hidden) refreshAccountsBadge(); }, TASKS_BADGE_POLL_MS);

  // ---------- Бэкапы (только сервисный аккаунт; открывается из «База данных ▾») ----------
  function formatBytes(n){
    if(n >= 1024*1024) return (n/(1024*1024)).toFixed(1) + ' МБ';
    if(n >= 1024) return (n/1024).toFixed(1) + ' КБ';
    return n + ' Б';
  }
  function formatBackupDate(iso){
    try{ return new Date(iso).toLocaleString('ru-RU'); }catch(e){ return iso; }
  }

  function backupsListHtml(backups){
    if(!backups.length) return '<div class="tasks-empty">Бэкапов пока нет — нажмите «Сделать бэкап сейчас».</div>';
    return backups.map(b => `
      <div class="dir-row" data-backup-file="${escHtml(b.file)}">
        <div class="u-info">
          <div class="u-name">${escHtml(b.file)}</div>
          <div class="u-login">${formatBackupDate(b.createdAt)} · ${formatBytes(b.sizeBytes)}</div>
        </div>
        <a class="btn" href="${API_BASE}/api/backups/${encodeURIComponent(b.file)}/download" title="Скачать" style="padding:6px 9px; font-size:12px;">⬇️</a>
        <button class="btn danger" data-backup-restore="${escHtml(b.file)}" title="Восстановить из этого бэкапа" style="padding:6px 9px; font-size:12px;">⏪</button>
        <button class="btn" data-backup-delete="${escHtml(b.file)}" title="Удалить" style="padding:6px 9px; font-size:12px;">🗑</button>
      </div>
    `).join('');
  }

  function wireBackupsListActions(){
    document.querySelectorAll('[data-backup-delete]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const file = btn.dataset.backupDelete;
        if(!(await confirmDialog(`Удалить бэкап «${file}»? Это необратимо.`, { title: 'Удаление бэкапа', okLabel: 'Удалить', danger: true }))) return;
        btn.disabled = true;
        try{
          const res = await fetch(`${API_BASE}/api/backups/${encodeURIComponent(file)}`, { method: 'DELETE' });
          const payload = await res.json().catch(() => ({}));
          if(!res.ok) throw new Error(payload.error || 'Не удалось удалить бэкап');
          await refreshBackupsModal();
        }catch(err){
          alert(err.message);
          btn.disabled = false;
        }
      });
    });
    document.querySelectorAll('[data-backup-restore]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const file = btn.dataset.backupRestore;
        if(!(await confirmDialog(`Восстановить базу из «${file}»?\n\nВСЕ текущие данные будут заменены содержимым этого бэкапа. Перед заменой автоматически будет снят safety-бэкап текущей базы, но сервер после этого перезапустится.\n\nПродолжить?`, { title: 'Восстановление из бэкапа', okLabel: 'Восстановить', danger: true }))) return;
        const typed = prompt('Для подтверждения наберите: ВОССТАНОВИТЬ');
        if(typed !== 'ВОССТАНОВИТЬ'){ alert('Отменено — фраза не совпала.'); return; }
        btn.disabled = true;
        const errBox = document.getElementById('backup-modal-error');
        if(errBox) errBox.style.display = 'none';
        try{
          const res = await fetch(`${API_BASE}/api/backups/${encodeURIComponent(file)}/restore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirm: 'ВОССТАНОВИТЬ' })
          });
          const payload = await res.json().catch(() => ({}));
          if(!res.ok) throw new Error(payload.error || 'Не удалось восстановить базу');
          closeModal();
          alert(`База восстановлена из ${file}.\nSafety-бэкап предыдущего состояния: ${payload.safetyBackup}.\n\nСервер сейчас перезапускается — обновите страницу через несколько секунд.`);
        }catch(err){
          if(errBox){ errBox.textContent = err.message; errBox.style.display = 'block'; }
          btn.disabled = false;
        }
      });
    });
  }

  async function refreshBackupsModal(){
    const list = document.getElementById('backups-modal-list');
    if(!list) return;
    try{
      const res = await fetch(API_BASE + '/api/backups');
      if(!res.ok) throw new Error('Сервер вернул ошибку ' + res.status);
      const data = await res.json();
      list.innerHTML = backupsListHtml(data.backups || []);
      wireBackupsListActions();
    }catch(err){
      list.innerHTML = `<div class="tasks-empty">${escHtml(err.message)}</div>`;
    }
  }

  function openBackupsModal(){
    openModal('💾 Бэкапы базы данных', `
      <p style="font-size:12px; color:var(--ink-soft); margin:0 0 12px;">Копии базы хранятся на сервере. Здесь можно снять новую, загрузить с компьютера, скачать или удалить старую.</p>
      <div id="backup-modal-error" style="display:none; color:var(--danger); font-size:12px; margin-bottom:10px;"></div>
      <label for="backup-upload-input" class="btn" style="display:inline-block; margin-bottom:12px; cursor:pointer;">⬆ Загрузить бэкап (.db.gz)</label>
      <input type="file" id="backup-upload-input" accept=".gz" style="display:none;">
      <div id="backups-modal-list"><div class="tasks-empty">Загрузка…</div></div>
    `, `<button class="btn primary" id="backup-create-btn">+ Сделать бэкап сейчас</button>`);
    refreshBackupsModal();
    const createBtn = document.getElementById('backup-create-btn');
    if(createBtn){
      createBtn.addEventListener('click', async () => {
        const errBox = document.getElementById('backup-modal-error');
        createBtn.disabled = true;
        createBtn.textContent = 'Снимаю бэкап…';
        if(errBox) errBox.style.display = 'none';
        try{
          const res = await fetch(API_BASE + '/api/backups', { method: 'POST' });
          const payload = await res.json().catch(() => ({}));
          if(!res.ok) throw new Error(payload.error || 'Не удалось создать бэкап');
          const list = document.getElementById('backups-modal-list');
          if(list){ list.innerHTML = backupsListHtml(payload.backups || []); wireBackupsListActions(); }
        }catch(err){
          if(errBox){ errBox.textContent = err.message; errBox.style.display = 'block'; }
        }finally{
          createBtn.disabled = false;
          createBtn.textContent = '+ Сделать бэкап сейчас';
        }
      });
    }
    const uploadInput = document.getElementById('backup-upload-input');
    if(uploadInput){
      uploadInput.addEventListener('change', async () => {
        const file = uploadInput.files && uploadInput.files[0];
        if(!file) return;
        const errBox = document.getElementById('backup-modal-error');
        const label = uploadInput.previousElementSibling;
        const prevLabelText = label ? label.textContent : '';
        if(label){ label.textContent = 'Загружаю…'; label.style.pointerEvents = 'none'; }
        if(errBox) errBox.style.display = 'none';
        try{
          const fd = new FormData();
          fd.append('file', file);
          const res = await fetch(API_BASE + '/api/backups/upload', { method: 'POST', body: fd });
          const payload = await res.json().catch(() => ({}));
          if(!res.ok) throw new Error(payload.error || 'Не удалось загрузить бэкап');
          const list = document.getElementById('backups-modal-list');
          if(list){ list.innerHTML = backupsListHtml(payload.backups || []); wireBackupsListActions(); }
        }catch(err){
          if(errBox){ errBox.textContent = err.message; errBox.style.display = 'block'; }
        }finally{
          if(label){ label.textContent = prevLabelText; label.style.pointerEvents = ''; }
          uploadInput.value = '';
        }
      });
    }
  }

  const backupsMenuBtn = document.getElementById('backups-menu-btn');
  if(backupsMenuBtn){
    backupsMenuBtn.addEventListener('click', () => {
      document.getElementById('db-actions-dropdown')?.classList.remove('open');
      openBackupsModal();
    });
  }

  // ---------- BOOTSTRAP ----------
  (async function init(){
    setConnStatus('connecting');
    // auth.js resolves this once the person is logged in (immediately, if a
    // valid session cookie already exists) — data must not load before that.
    if (window.__whenAuthed) await window.__whenAuthed;
    // Хаб-меню теперь три отдельные страницы (/, /warehouse, /tasks) —
    // при загрузке решаем, какой раздел показать, по фактическому URL.
    const hubPath = location.pathname.replace(/\/+$/, '') || '/';
    if(hubPath === '/tasks') activateView('tasks');
    else if(hubPath === '/accounts') activateView('accounts');
    else if(hubPath === '/warehouse') activateView(lastWarehouseView);
    else activateView('hub');
    await syncFromServer(true);
    refreshTasksBadge();
    refreshAccountsBadge();
  })();
})();

// Theme Toggle Logic
const themeToggleBtn = document.getElementById('pp-theme-toggle');
const currentTheme = localStorage.getItem('theme') || 'light';

function setThemeBtnLabel(isDark){
    if(!themeToggleBtn) return;
    themeToggleBtn.innerHTML = isDark ? '☀️ <span>Светлая тема</span>' : '🌙 <span>Тёмная тема</span>';
}

if (currentTheme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
    setThemeBtnLabel(true);
}

if(themeToggleBtn) {
    themeToggleBtn.addEventListener('click', () => {
        const theme = document.documentElement.getAttribute('data-theme');
        if (theme === 'dark') {
            document.documentElement.removeAttribute('data-theme');
            localStorage.setItem('theme', 'light');
            setThemeBtnLabel(false);
        } else {
            document.documentElement.setAttribute('data-theme', 'dark');
            localStorage.setItem('theme', 'dark');
            setThemeBtnLabel(true);
        }
    });
}

// Регистрация service worker — нужна для того, чтобы Chrome и Яндекс.Браузер
// предлагали "Установить приложение". Данные склада тут не кэшируются,
// сервис-воркер только формально присутствует и прозрачно пропускает запросы.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
