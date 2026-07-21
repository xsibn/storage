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

  function setMoveMode(on){
    moveMode = on;
    tapSourceAddress = null; tapSourceAisleSel = null; tapSourceRackSel = null;
    document.getElementById('move-mode-btn').classList.toggle('active', moveMode);
    renderAisleChips();
    renderGrid();
  }

  function renderAisleChips(){
    const aisles = aisleList();
    if(!currentAisle || !aisles.includes(currentAisle)) currentAisle = aisles[0];
    const box = document.getElementById('aisle-chips');
    box.innerHTML = aisles.map(a=>{
      const n = addressRecords().filter(r=>r.row===a);
      const cells = new Set(n.map(r=>r.cell)).size;
      const sel = moveMode && a===tapSourceAisleSel ? 'tap-selected' : '';
      return `<button class="aisle-chip ${a===currentAisle?'active':''} ${sel}" draggable="true" data-aisle="${a}" title="Перетащите на другой ряд, чтобы поменять их местами целиком">Ряд ${a}<span class="n">· ${cells}</span></button>`;
    }).join('');
    box.querySelectorAll('.aisle-chip').forEach(btn=>{
      btn.addEventListener('click', async ()=>{
        if(moveMode){
          const a = btn.dataset.aisle;
          if(tapSourceAisleSel===null){ tapSourceAisleSel = a; renderAisleChips(); }
          else if(tapSourceAisleSel===a){ tapSourceAisleSel = null; renderAisleChips(); }
          else { const src = tapSourceAisleSel; tapSourceAisleSel = null; await swapAisles(src, a); }
          return;
        }
        currentAisle = btn.dataset.aisle; renderAisleChips(); renderGrid();
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

    let html = `<div style="display:grid; grid-template-columns:34px repeat(${fullRacks.length}, 22px); gap:3px;">`;
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
          ${it.cell ? `<dt>Ячейка</dt><dd>${it.cell}</dd>` : ''}
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

      let html = `<div style="display:grid; grid-template-columns:34px repeat(${racks.length}, 22px); gap:3px;">`;
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

  function handleScannedCode(rawCode){
    const code = String(rawCode || '').trim();
    if(!code) return;
    const matches = findRecordsByCode(code);
    if(!matches.length){
      alert(`Товар со штрихкодом «${code}» не найден в текущих данных склада.`);
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

  function openBarcodeScanner(){
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
      handleScannedCode(val);
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
        handleScannedCode(decodedText);
      },
      ()=>{ /* игнорируем неудачные попытки распознавания в очередном кадре */ }
    ).catch(err=>{
      const statusEl = document.getElementById('barcode-status');
      if(statusEl) statusEl.textContent = 'Не удалось открыть камеру: ' + (err && err.message ? err.message : err) + '. Введите код вручную или проверьте разрешение на использование камеры.';
    });
  }

  document.getElementById('scan-barcode-btn').addEventListener('click', openBarcodeScanner);

  let tableTerm = "";
  let tableFilter = "all";
  const selectedIds = new Set();

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


  function renderTable(){
    let rows = state.records;
    if(tableFilter==='address') rows = rows.filter(r=>!r.isService);
    if(tableFilter==='service') rows = rows.filter(r=>r.isService);
    const term = tableTerm.trim().toLowerCase();
    if(term){
      rows = rows.filter(r=> r.article.toLowerCase().includes(term) || r.name.toLowerCase().includes(term) || r.cell.toLowerCase().includes(term) || (r.te && r.te.toLowerCase().includes(term)));
    }
    document.getElementById('table-count').textContent = `${fmtNum(rows.length)} записей`;

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
        <td><input class="edit-input" data-field="qty" type="number" value="${r.qty}"></td>
        <td>${r.mfg||'—'}</td>
        <td>${r.exp||'—'}</td>
        <td class="cellcode" style="font-size:11px;">${r.te||'—'}</td>
        <td>${r.isService ? '<span class="badge service">служебная</span>' : '<span class="badge ok">адресная</span>'}</td>
        <td><button class="pin-btn row-delete-btn" title="Удалить запись">🗑</button></td>
      </tr>
    `).join('') + (rows.length>MAX ? `<tr><td colspan="10" style="text-align:center;color:var(--ink-soft);padding:14px;">Показаны первые ${MAX} из ${fmtNum(rows.length)} — уточните поиск, чтобы увидеть остальные</td></tr>` : '');

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
  function openRowManager(){
    if(!currentAisle){ alert('Сначала выберите ряд.'); return; }
    const extent = aisleExtent(currentAisle);
    if(!extent){ alert('Для этого ряда пока нет структуры склада.'); return; }
    const originalRow = currentAisle;
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
      <button class="btn" id="order-reset">По возрастанию</button>
      <button class="btn" id="row-mgr-cancel">Отмена</button>
      <button class="btn primary" id="row-mgr-save">Сохранить</button>
    `;
    openModal(`Управление рядом ${originalRow}`, body, footer);
    renderChips();

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

    // group by merchandise category (juices with juices, water with water, etc.)
    articles.forEach(a=>{ a.category = classifyCategory(a.name); });
    const categoryVolume = {};
    articles.forEach(a=>{ categoryVolume[a.category] = (categoryVolume[a.category]||0) + a.stockVolume; });
    const categoryOrder = Object.entries(categoryVolume).sort((x,y)=>y[1]-x[1]).map(([k])=>k);
    const categoryRank = {}; categoryOrder.forEach((c,i)=>categoryRank[c]=i);

    // Placement priority: 1) ABC class (A first — best/closest positions),
    // 2) merchandise category (so same-kind products stay grouped together),
    // 3) unit weight/volume heavy->light within the category (ergonomic stacking).
    const abcRank = {A:0, B:1, C:2};
    articles.sort((a,b)=>{
      const aAbc = abcByArticle[a.article].abcClass, bAbc = abcByArticle[b.article].abcClass;
      if(abcRank[aAbc] !== abcRank[bAbc]) return abcRank[aAbc]-abcRank[bAbc];
      if(categoryRank[a.category] !== categoryRank[b.category]) return categoryRank[a.category]-categoryRank[b.category];
      const av = a.vol==null ? -Infinity : a.vol;
      const bv = b.vol==null ? -Infinity : b.vol;
      return bv - av;
    });

    // natural walking path starting at cell 1: aisle asc, rack asc, using distinct (row,rack) pairs from address data
    const posSet = {};
    addr.forEach(r=>{ posSet[r.row+'|'+r.rack] = {row:r.row, rack:r.rack}; });
    const pool = Object.values(posSet).sort((a,b)=> a.row===b.row ? a.rack-b.rack : (a.row<b.row?-1:1) );

    const assigned = articles.map((a,idx)=>{
      const pos = pool[idx] || null;
      const abc = abcByArticle[a.article];
      return {
        ...a,
        rank: idx+1,
        volShare: abc.volShare, cumShare: abc.cumShare, abcClass: abc.abcClass, stockVolume: abc.stockVolume,
        categoryColor: CATEGORY_COLORS[a.category] || '#94A3B8',
        pickAddress: pos ? `${pos.row}-${zpad(pos.rack)}-01` : null,
        replenish: pos ? `${pos.row}-${zpad(pos.rack)} · ярусы выше 01` : null,
        replenishRow: pos ? pos.row : null, replenishRack: pos ? pos.rack : null
      };
    });

    const abcTotals = {A:{n:0,vol:0}, B:{n:0,vol:0}, C:{n:0,vol:0}};
    assigned.forEach(a=>{ abcTotals[a.abcClass].n++; abcTotals[a.abcClass].vol += a.stockVolume; });

    recoCache = {assigned, pool, abcTotals, grandVolume, categoryOrder};
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
      btn.addEventListener('click', ()=>{ recoAisle = btn.dataset.aisle; renderRecoAisleChips(); renderRecoScheme(); });
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
      </div>`;
    }).join('');
    box.querySelectorAll('.zone-card[data-abc]').forEach(card=>{
      card.addEventListener('click', ()=>{
        recoAbcFilter = card.dataset.abc;
        const sel = document.getElementById('reco-abc-filter');
        if(sel) sel.value = recoAbcFilter;
        renderRecoTable();
        document.getElementById('reco-body').closest('.panel').scrollIntoView({behavior:'smooth', block:'start'});
      });
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
    assigned.forEach(a=>{ if(a.replenishRow===recoAisle) byRack[a.replenishRack] = a; });

    // fallback: what is actually stored at a given address today, for cells that
    // received no picking recommendation (more physical slots than articles to place)
    const actualByAddr = {};
    addressRecords().filter(r=>r.row===recoAisle).forEach(r=>{
      const key = r.rack+'|'+r.level;
      (actualByAddr[key] = actualByAddr[key] || []).push(r);
    });

    const abcRing = {A:'var(--danger)', B:'var(--multi)', C:'none'};

    const term = recoSearchTerm.trim().toLowerCase();

    let html = `<div style="display:grid; grid-template-columns:34px repeat(${racks.length}, 22px); gap:3px;">`;
    html += `<div></div>`;
    racks.forEach(rk=> html += `<div class="rack-label">${rk}</div>`);
    levels.forEach(lv=>{
      html += `<div class="level-label">${lv}</div>`;
      racks.forEach(rk=>{
        const a = byRack[rk];
        if(a){
          const t = a.vol==null ? 1 : (maxUnitVol>0 ? 1 - Math.min(1, a.vol/maxUnitVol) : 0);
          const base = shade(a.categoryColor, t);
          const isPickLevel = (lv==='01');
          const bg = isPickLevel ? base : withAlpha(base, 0.32);
          const matches = term && (a.article.toLowerCase().includes(term) || a.name.toLowerCase().includes(term));
          const dim = term && !matches ? 'opacity:.2;' : '';
          const ring = matches ? `box-shadow:0 0 0 2px var(--danger);` : (isPickLevel && abcRing[a.abcClass]!=='none' ? `box-shadow:inset 0 0 0 2px ${abcRing[a.abcClass]};` : '');
          const label = isPickLevel ? `#${a.rank} · ПИКИНГ · ${a.article} · ${a.category}` : `Пополнение · ${a.article} · ${a.category} · резерв ${fmtNum(a.qty)} шт всего`;
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
          openDrawer(addr, [{article:a.article, name:a.name, qty:a.qty, mfg:'', exp:`${role} · ${a.category} · класс ABC: ${a.abcClass} (${a.volShare.toFixed(1)}% объёма стока)`}]);
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
    if(recoCategoryFilter!=='all') rows = rows.filter(r=>r.category===recoCategoryFilter);
    document.getElementById('reco-count').textContent = `${fmtNum(rows.length)} артикулов`;
    const MAX = 400;
    const shown = rows.slice(0, MAX);
    const abcBadgeClass = {A:'multi', B:'multi', C:'service'};
    document.getElementById('reco-body').innerHTML = shown.map(r=>`
      <tr>
        <td>${r.rank}</td>
        <td class="article">${r.article}</td>
        <td>${r.name}</td>
        <td><span style="display:inline-flex;align-items:center;gap:5px;"><i class="swatch" style="background:${r.categoryColor};"></i>${r.category}</span></td>
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
    box.innerHTML = recoCache.categoryOrder.map(c=>
      `<span><i class="swatch" style="background:${CATEGORY_COLORS[c]||'#94A3B8'};"></i>${c}</span>`
    ).join('');
    const filterSel = document.getElementById('reco-category-filter');
    filterSel.innerHTML = `<option value="all">Все категории</option>` +
      recoCache.categoryOrder.map(c=>`<option value="${c}">${c}</option>`).join('');
    filterSel.value = recoCategoryFilter;
  }


  let recoAbcFilter = 'all';
  let recoCategoryFilter = 'all';

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
    populateRangeForm();
  }

  // ---------- RANGE-SCOPED RECOMMENDATION ----------
  // Pick an aisle + rack range + one category, and get a recommendation just
  // for that slice of the warehouse (same ABC-then-weight ordering as the
  // global recommendation, but scoped so it's actually usable for "I'm
  // reorganizing this one section right now").
  function populateRangeForm(){
    const rowSel = document.getElementById('range-row');
    const catSel = document.getElementById('range-category');
    const aisles = aisleList();
    const prevRow = rowSel.value;
    rowSel.innerHTML = aisles.map(a=>`<option value="${a}">Ряд ${a}</option>`).join('');
    if(aisles.includes(prevRow)) rowSel.value = prevRow;
    const categories = recoCache && recoCache.categoryOrder.length ? recoCache.categoryOrder : Object.keys(CATEGORY_COLORS);
    const prevCat = catSel.value;
    catSel.innerHTML = categories.map(c=>`<option value="${c}">${c}</option>`).join('');
    if(categories.includes(prevCat)) catSel.value = prevCat;
    updateRangeRackOptions();
  }

  function updateRangeRackOptions(){
    const row = document.getElementById('range-row').value;
    const extent = aisleExtent(row);
    const racks = extent ? extent.racks.slice().sort((a,b)=>a-b) : [];
    const fromSel = document.getElementById('range-rack-from');
    const toSel = document.getElementById('range-rack-to');
    fromSel.innerHTML = racks.map(r=>`<option value="${r}">${r}</option>`).join('');
    toSel.innerHTML = racks.map(r=>`<option value="${r}">${r}</option>`).join('');
    if(racks.length) toSel.value = racks[racks.length-1];
  }
  document.getElementById('range-row').addEventListener('change', updateRangeRackOptions);

  function computeRangeRecommendation(row, rackFrom, rackTo, category){
    if(!recoCache) computeRecommendation();
    const abcRank = {A:0, B:1, C:2};
    const items = recoCache.assigned
      .filter(a=>a.category===category)
      .slice()
      .sort((a,b)=>{
        if(abcRank[a.abcClass]!==abcRank[b.abcClass]) return abcRank[a.abcClass]-abcRank[b.abcClass];
        const av = a.vol==null?-Infinity:a.vol, bv = b.vol==null?-Infinity:b.vol;
        return bv-av;
      });
    const extent = aisleExtent(row);
    const orderedRacks = (extent ? extent.racks : []).filter(r=>r>=rackFrom && r<=rackTo);
    const assigned = items.map((a,idx)=>{
      const rack = orderedRacks[idx] != null ? orderedRacks[idx] : null;
      return {
        ...a, rangeRank: idx+1,
        pickAddress: rack!=null ? `${row}-${zpad(rack)}-01` : null,
        replenish: rack!=null ? `${row}-${zpad(rack)} · ярусы выше 01` : null,
        rack
      };
    });
    return { assigned, racks: orderedRacks, row, category };
  }

  function renderRangeResult(result){
    document.getElementById('range-result').style.display = 'block';
    const strip = document.getElementById('range-strip');
    const extent = aisleExtent(result.row);
    const allRacks = extent.racks; // whole row, in its own display order — gives context for the highlight
    const inRangeSet = new Set(result.racks);
    let levels = LEVEL_ORDER.filter(l=>extent.levels.includes(l));
    if(!levels.includes('01')) levels = ['01', ...levels];
    levels = levels.reverse();

    const byRack = {};
    result.assigned.forEach(a=>{ if(a.rack!=null) byRack[a.rack] = a; });
    const maxUnitVol = result.assigned.length ? (result.assigned[0].vol==null?1:result.assigned[0].vol) : 1;

    let html = `<div style="display:grid; grid-template-columns:34px repeat(${Math.max(allRacks.length,1)}, 22px); gap:3px;">`;
    html += `<div></div>`;
    allRacks.forEach(rk=> html += `<div class="rack-label ${inRangeSet.has(rk)?'range-highlight-label':''}">${rk}</div>`);
    levels.forEach(lv=>{
      html += `<div class="level-label">${lv}</div>`;
      allRacks.forEach(rk=>{
        const inRange = inRangeSet.has(rk);
        const rangeCls = inRange ? 'range-highlight' : '';
        const a = byRack[rk];
        if(!a){ html += `<div class="cell ${rangeCls}"></div>`; return; }
        const t = a.vol==null ? 1 : (maxUnitVol>0 ? 1-Math.min(1,a.vol/maxUnitVol) : 0);
        const base = shade(a.categoryColor, t);
        const isPick = lv==='01';
        const bg = isPick ? base : withAlpha(base, 0.32);
        const label = isPick ? `#${a.rangeRank} · ${a.article} · ${a.name}` : `Пополнение · ${a.article}`;
        html += `<div class="cell ${rangeCls}" style="background:${bg}; border-color:${bg};" title="${label} · класс ${a.abcClass}"></div>`;
      });
    });
    html += `</div>`;
    strip.innerHTML = html;

    document.getElementById('range-body').innerHTML = result.assigned.map(a=>`
      <tr>
        <td>${a.rangeRank}</td>
        <td class="article">${a.article}</td>
        <td>${a.name}</td>
        <td>${a.abcClass}</td>
        <td>${a.vol!=null ? a.vol+' л/кг' : '—'}</td>
        <td>${fmtNum(a.qty)}</td>
        <td class="cellcode">${a.pickAddress || '<span class="badge service">не хватило места</span>'}</td>
        <td class="cellcode" style="color:var(--ink-soft);">${a.replenish || '—'}</td>
      </tr>
    `).join('');
  }

  document.getElementById('range-calc-btn').addEventListener('click', ()=>{
    const errEl = document.getElementById('range-error');
    errEl.classList.remove('show');
    const row = document.getElementById('range-row').value;
    const category = document.getElementById('range-category').value;
    const rackFrom = parseInt(document.getElementById('range-rack-from').value, 10);
    const rackTo = parseInt(document.getElementById('range-rack-to').value, 10);
    if(!row || !category){ errEl.textContent = 'Выберите ряд и категорию.'; errEl.classList.add('show'); return; }
    if(!(rackFrom<=rackTo)){ errEl.textContent = '«Стеллаж от» должен быть не больше «до».'; errEl.classList.add('show'); return; }
    const result = computeRangeRecommendation(row, rackFrom, rackTo, category);
    if(!result.assigned.length){ errEl.textContent = `В категории «${category}» нет артикулов в текущем стоке.`; errEl.classList.add('show'); return; }
    renderRangeResult(result);
  });

  document.getElementById('reco-search').addEventListener('input', (e)=>{
    recoSearchTerm = e.target.value; renderRecoScheme(); renderRecoTable();
  });
  document.getElementById('reco-abc-filter').addEventListener('change', (e)=>{
    recoAbcFilter = e.target.value; renderRecoTable();
  });
  document.getElementById('reco-category-filter').addEventListener('change', (e)=>{
    recoCategoryFilter = e.target.value; renderRecoTable();
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
    mapFilterTerm = e.target.value; renderGrid();
  });
  document.getElementById('table-search').addEventListener('input', (e)=>{
    tableTerm = e.target.value; renderTable();
  });
  document.getElementById('table-filter').addEventListener('change', (e)=>{
    tableFilter = e.target.value; renderTable();
  });

  // ---------- FILE UPLOAD (sent to the server — replaces the DB for everyone) ----------
  document.getElementById('file-input').addEventListener('change', async (e)=>{
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

