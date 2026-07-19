(function(){
  "use strict";

  const API_BASE = ""; // same-origin: server serves both the API and this page

  const state = {
    records: [],   // {id, cell, article, name, qty, mfg, exp, isService, row, rack, level}
    sourceLabel: "подключение…",
    lastSync: null
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

  async function fetchRecords(){
    const res = await fetch(API_BASE + '/api/records');
    if(!res.ok) throw new Error('Сервер вернул ошибку ' + res.status);
    const data = await res.json();
    state.records = data.records.map(fromServerRow);
    state.sourceLabel = data.meta.source || 'база данных';
    state.lastSync = new Date();
  }

  async function syncFromServer(showAlert){
    try{
      setSyncStatus('синхронизация…');
      await fetchRecords();
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
    const rows = new Set();
    addressRecords().forEach(r=>rows.add(r.row));
    return Array.from(rows).sort();
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

  function renderAisleChips(){
    const aisles = aisleList();
    if(!currentAisle || !aisles.includes(currentAisle)) currentAisle = aisles[0];
    const box = document.getElementById('aisle-chips');
    box.innerHTML = aisles.map(a=>{
      const n = addressRecords().filter(r=>r.row===a);
      const cells = new Set(n.map(r=>r.cell)).size;
      return `<button class="aisle-chip ${a===currentAisle?'active':''}" draggable="true" data-aisle="${a}" title="Перетащите на другой ряд, чтобы поменять их местами целиком">Ряд ${a}<span class="n">· ${cells}</span></button>`;
    }).join('');
    box.querySelectorAll('.aisle-chip').forEach(btn=>{
      btn.addEventListener('click', ()=>{ currentAisle = btn.dataset.aisle; renderAisleChips(); renderGrid(); });

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
    }
  }

  let dragSourceAddress = null;

  function renderGrid(){
    const grid = document.getElementById('rack-grid');
    if(!currentAisle){ grid.innerHTML = '<div class="empty-note">Нет адресных ячеек в данных</div>'; return; }
    const rows = addressRecords().filter(r=>r.row===currentAisle);
    if(rows.length===0){ grid.innerHTML = '<div class="empty-note">Пусто</div>'; return; }

    const racks = Array.from(new Set(rows.map(r=>r.rack))).sort((a,b)=>a-b);
    const minRack = racks[0], maxRack = racks[racks.length-1];
    const fullRacks = [];
    for(let i=minRack;i<=maxRack;i++) fullRacks.push(i);

    const levelsPresent = Array.from(new Set(rows.map(r=>r.level)));
    const levels = LEVEL_ORDER.filter(l=>levelsPresent.includes(l)).reverse();

    // group by rack-level
    const byPos = {};
    rows.forEach(r=>{
      const key = r.rack+"|"+r.level;
      (byPos[key] = byPos[key] || []).push(r);
    });

    const term = mapFilterTerm.trim().toLowerCase();

    let html = `<div style="display:grid; grid-template-columns:34px repeat(${fullRacks.length}, 22px); gap:3px;">`;
    html += `<div></div>`;
    fullRacks.forEach(rk=> html += `<div class="rack-label">${rk}</div>`);
    levels.forEach(lv=>{
      html += `<div class="level-label">${lv}</div>`;
      fullRacks.forEach(rk=>{
        const key = rk+"|"+lv;
        const items = byPos[key];
        const addr = `${currentAisle}-${zpad(rk)}-${lv}`;
        if(!items){
          html += `<div class="cell" data-rack="${rk}" data-level="${lv}" data-address="${addr}" title="${addr} · свободно — сюда можно перетащить товар"></div>`;
          return;
        }
        const arts = Array.from(new Set(items.map(i=>i.article)));
        const matches = term && (
          items.some(i=> i.article.toLowerCase().includes(term) || i.cell.toLowerCase().includes(term) || i.name.toLowerCase().includes(term) || (i.te && i.te.toLowerCase().includes(term)))
        );
        const cls = arts.length>1 ? 'multi' : 'filled';
        const dim = term && !matches ? 'opacity:.25;' : '';
        const ring = matches ? 'box-shadow:0 0 0 2px var(--danger);' : '';
        html += `<div class="cell ${cls}" style="${dim}${ring}" draggable="true" data-rack="${rk}" data-level="${lv}" data-address="${addr}" title="${items[0].cell} · ${arts.length} артикул(ов) · перетащите, чтобы переместить"></div>`;
      });
    });
    html += `</div>`;
    grid.innerHTML = html;

    grid.querySelectorAll('.cell.filled, .cell.multi').forEach(el=>{
      el.addEventListener('click', ()=>{
        const rk = el.dataset.rack, lv = el.dataset.level;
        const items = byPos[rk+"|"+lv];
        openDrawer(items[0].cell, items);
      });
      el.addEventListener('dragstart', (e)=>{
        dragSourceAddress = el.dataset.address;
        el.classList.add('drag-source');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', dragSourceAddress);
      });
      el.addEventListener('dragend', ()=>{
        el.classList.remove('drag-source');
        dragSourceAddress = null;
      });
    });

    // every cell (empty or filled) is a valid drop target
    grid.querySelectorAll('.cell[data-address]').forEach(el=>{
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
  }

  async function moveCellContents(sourceAddress, targetAddress){
    const recs = state.records.filter(r=>r.cell===sourceAddress);
    if(!recs.length) return;
    setSyncStatus('перемещение…');
    try{
      for(const rec of recs){
        const res = await fetch(`${API_BASE}/api/records/${rec.id}`, {
          method:'PATCH', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ cell: targetAddress })
        });
        if(!res.ok) throw new Error('HTTP '+res.status);
      }
      await fetchRecords();
      renderAll();
      setSyncStatus(`перемещено в ${targetAddress} · ` + new Date().toLocaleTimeString('ru-RU'));
    }catch(err){
      setSyncStatus('ошибка перемещения', true);
      alert('Не удалось переместить товар: ' + err.message);
      await fetchRecords(); renderAll();
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
      const rows = addressRecords().filter(r=>r.row===pickerAisle);
      if(rows.length===0){ grid.innerHTML = '<div class="empty-note">Пусто</div>'; return; }
      const racks = Array.from(new Set(rows.map(r=>r.rack))).sort((a,b)=>a-b);
      const minRack = racks[0], maxRack = racks[racks.length-1];
      const levelsPresent = Array.from(new Set(rows.map(r=>r.level)));
      const levels = LEVEL_ORDER.filter(l=>levelsPresent.includes(l)).reverse();
      const byPos = {};
      rows.forEach(r=>{ (byPos[r.rack+'|'+r.level] = byPos[r.rack+'|'+r.level] || []).push(r); });

      let html = `<div style="display:grid; grid-template-columns:34px repeat(${maxRack-minRack+1}, 22px); gap:3px;">`;
      html += `<div></div>`;
      for(let rk=minRack; rk<=maxRack; rk++) html += `<div class="rack-label">${rk}</div>`;
      levels.forEach(lv=>{
        html += `<div class="level-label">${lv}</div>`;
        for(let rk=minRack; rk<=maxRack; rk++){
          const addr = `${pickerAisle}-${zpad(rk)}-${lv}`;
          const items = byPos[rk+'|'+lv];
          const cls = items ? (new Set(items.map(i=>i.article)).size>1 ? 'multi' : 'filled') : '';
          const current = addr===currentValue ? 'box-shadow:0 0 0 2px var(--danger);' : '';
          const title = items ? `${addr} · занята (${items.length} запис.)` : `${addr} · свободна`;
          html += `<div class="cell ${cls}" style="cursor:pointer; ${current}" data-address="${addr}" title="${title}"></div>`;
        }
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
    `).join('') + (rows.length>MAX ? `<tr><td colspan="9" style="text-align:center;color:var(--ink-soft);padding:14px;">Показаны первые ${MAX} из ${fmtNum(rows.length)} — уточните поиск, чтобы увидеть остальные</td></tr>` : '');

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
        try{
          const res = await fetch(`${API_BASE}/api/records/${id}`, { method:'DELETE' });
          if(!res.ok) throw new Error('HTTP '+res.status);
          await fetchRecords();
          renderAll();
          setSyncStatus('запись удалена · ' + new Date().toLocaleTimeString('ru-RU'));
        }catch(err){
          alert('Не удалось удалить запись: ' + err.message);
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
        }
      });
    });
  }

  // ---------- ADD PRODUCT ----------
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

    // ABC by share of total stock VOLUME on the warehouse (qty * unit volume).
    // Unknown unit volume -> counted as 0 volume (still shown, falls into C).
    articles.forEach(a=>{ a.stockVolume = a.qty * (a.vol==null?0:a.vol); });
    const grandVolume = articles.reduce((s,a)=>s+a.stockVolume,0);
    const abcSorted = [...articles].sort((a,b)=>b.stockVolume-a.stockVolume);
    let cum = 0;
    abcSorted.forEach(a=>{
      a.volShare = grandVolume>0 ? a.stockVolume/grandVolume*100 : 0;
      cum += a.volShare;
      a.cumShare = cum;
      a.abcClass = a.stockVolume<=0 ? 'C' : (cum<=80 ? 'A' : (cum<=95 ? 'B' : 'C'));
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

    const aisleRecords = addressRecords().filter(r=>r.row===recoAisle);
    const racksInAisle = Array.from(new Set(aisleRecords.map(r=>r.rack))).sort((a,b)=>a-b);
    if(racksInAisle.length===0){ strip.innerHTML = '<div class="empty-note">Пусто</div>'; return; }
    const minRack = racksInAisle[0], maxRack = racksInAisle[racksInAisle.length-1];

    const levelsPresent = Array.from(new Set(aisleRecords.map(r=>r.level)));
    let levels = LEVEL_ORDER.filter(l=>levelsPresent.includes(l));
    if(!levels.includes('01')) levels = ['01', ...levels];
    levels = levels.reverse(); // same visual convention as the actual scheme tab

    const assigned = recoCache.assigned;
    const maxUnitVol = assigned.length ? (assigned[0].vol==null?1:assigned[0].vol) : 1;
    const byRack = {}; // rack -> assigned article (pick face owner for this aisle+rack)
    assigned.forEach(a=>{ if(a.replenishRow===recoAisle) byRack[a.replenishRack] = a; });

    // fallback: what is actually stored at a given address today, for cells that
    // received no picking recommendation (more physical slots than articles to place)
    const actualByAddr = {};
    aisleRecords.forEach(r=>{
      const key = r.rack+'|'+r.level;
      (actualByAddr[key] = actualByAddr[key] || []).push(r);
    });

    const abcRing = {A:'var(--danger)', B:'var(--multi)', C:'none'};

    const term = recoSearchTerm.trim().toLowerCase();

    let html = `<div style="display:grid; grid-template-columns:34px repeat(${maxRack-minRack+1}, 22px); gap:3px;">`;
    html += `<div></div>`;
    for(let rk=minRack; rk<=maxRack; rk++) html += `<div class="rack-label">${rk}</div>`;
    levels.forEach(lv=>{
      html += `<div class="level-label">${lv}</div>`;
      for(let rk=minRack; rk<=maxRack; rk++){
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
          continue;
        }
        const actual = actualByAddr[rk+'|'+lv];
        if(actual){
          const arts = Array.from(new Set(actual.map(i=>i.article)));
          const matches = term && actual.some(i=> i.article.toLowerCase().includes(term) || i.name.toLowerCase().includes(term));
          const dim = term && !matches ? 'opacity:.2;' : '';
          const ring = matches ? 'box-shadow:0 0 0 2px var(--danger);' : '';
          const cls = arts.length>1 ? 'multi' : 'filled';
          html += `<div class="cell ${cls}" style="${dim}${ring}" data-rack="${rk}" data-level="${lv}" data-kind="actual" title="Без рекомендации · сейчас: ${actual[0].article} · ${actual.length>1?'+ ещё '+(actual.length-1):''}"></div>`;
          continue;
        }
        html += `<div class="cell"></div>`;
      }
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
  }

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
    const groups = {};
    svc.forEach(r=>{
      (groups[r.cell] = groups[r.cell] || []).push(r);
    });
    const box = document.getElementById('zones-grid');
    const names = Object.keys(groups).sort((a,b)=>groups[b].length-groups[a].length);
    box.innerHTML = names.map(name=>{
      const items = groups[name];
      const qty = items.reduce((s,i)=>s+i.qty,0);
      const arts = new Set(items.map(i=>i.article)).size;
      return `<div class="zone-card" data-zone="${name}">
        <div class="name">${name}</div>
        <div class="row"><span>Строк</span><b>${fmtNum(items.length)}</b></div>
        <div class="row"><span>Артикулов</span><b>${fmtNum(arts)}</b></div>
        <div class="row"><span>Всего, шт</span><b>${fmtNum(qty)}</b></div>
      </div>`;
    }).join('');
    box.querySelectorAll('.zone-card').forEach(card=>{
      card.addEventListener('click', ()=>{
        const items = groups[card.dataset.zone];
        openDrawer(card.dataset.zone, items.slice(0,50));
      });
    });
  }

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
    try{
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(API_BASE + '/api/import', { method:'POST', body: form });
      const payload = await res.json().catch(()=>({}));
      if(!res.ok) throw new Error(payload.error || ('HTTP '+res.status));
      currentAisle = null; recoAisle = null;
      await fetchRecords();
      renderAll();
      setSyncStatus(`загружено ${fmtNum(payload.imported)} строк · ${state.lastSync.toLocaleTimeString('ru-RU')}`);
    }catch(err){
      setSyncStatus('ошибка загрузки', true);
      alert('Не удалось загрузить файл на сервер: '+err.message);
    }finally{
      e.target.value = '';
    }
  });

  // ---------- EXPORT (server builds the .xlsx from the current database state) ----------
  document.getElementById('export-btn').addEventListener('click', ()=>{
    window.location.href = API_BASE + '/api/export';
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

