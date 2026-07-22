// Логика складской системы
let currentAisle = 'Ряд 1';
let mapFilterTerm = '';
let tableTerm = '';

// Пример базы данных ячеек и товаров
const mockData = [
  { cell: 'A-101', row: 'Ряд 1', code: '4601234567890', name: 'Коробка картонная L', count: 15, isService: false },
  { cell: 'A-102', row: 'Ряд 1', code: '4609876543210', name: 'Пленка воздушно-пупырчатая', count: 8, isService: false },
  { cell: 'B-201', row: 'Ряд 2', code: '4605555444333', name: 'Скотч упаковочный', count: 42, isService: false },
  { cell: 'B-202', row: 'Ряд 2', code: '4601112223334', name: 'Стретч-пленка 500мм', count: 20, isService: false },
  { cell: 'SERV-01', row: 'Служебная', code: '4609998887776', name: 'Брак / Возврат', count: 3, isService: true }
];

function findRecordsByCode(code) {
  const cleanCode = String(code || '').toLowerCase().trim();
  return mockData.filter(item => 
    item.code.toLowerCase() === cleanCode || 
    item.cell.toLowerCase() === cleanCode ||
    item.name.toLowerCase().includes(cleanCode)
  );
}

function handleScannedCode(rawCode) {
  const code = String(rawCode || '').trim();
  if(!code) return;
  const matches = findRecordsByCode(code);
  if(!matches.length){
    alert(`Товар со штрихкодом «${code}» не найден в текущих данных склада.`);
    return;
  }

  // Находим первую адресную ячейку с товаром
  const addrMatch = matches.find(r => !r.isService) || matches[0];

  if(addrMatch && !addrMatch.isService) {
    // 1. Переходим на вкладку "Схема склада"
    const mapTab = document.querySelector('nav.tabs button[data-view="map"]');
    if(mapTab) mapTab.click();

    // 2. Устанавливаем ряд и поисковый запрос
    currentAisle = addrMatch.row;
    mapFilterTerm = code;
    const searchInput = document.getElementById('map-search');
    if(searchInput) searchInput.value = code;

    // 3. Перерисовываем схему склада
    renderAisleChips();
    renderGrid();

    // 4. Находим ячейку, скроллим к ней и делаем визуальный акцент
    setTimeout(() => {
      const targetCell = document.querySelector(`.cell[data-address="${addrMatch.cell}"]`);
      if(targetCell) {
        targetCell.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
        
        // Добавляем класс пульсирующего акцента
        targetCell.classList.add('highlight-pulse');
        
        // Снимаем подсветку через 4 секунды
        setTimeout(() => {
          targetCell.classList.remove('highlight-pulse');
        }, 4000);
      }
      
      // Открываем информационную боковую панель
      openDrawer(`Ячейка ${addrMatch.cell}`, matches);
    }, 150);

  } else {
    // Если товар находится в служебной зоне (вне адресной сетки)
    const tableTab = document.querySelector('nav.tabs button[data-view="table"]');
    if(tableTab) tableTab.click();
    tableTerm = code;
    openDrawer(`Служебная зона: ${addrMatch.cell}`, matches);
  }
}

function openBarcodeScanner() {
  const code = prompt("Имуляция сканера штрих-кода. Введите штрихкод или артикул (например: 4601234567890 или A-101):");
  if(code) {
    handleScannedCode(code);
  }
}

function renderAisleChips() {
  const container = document.getElementById('aisle-chips');
  if(!container) return;
  const aisles = ['Ряд 1', 'Ряд 2', 'Служебная'];
  container.innerHTML = aisles.map(a => `
    <button class="btn ${a === currentAisle ? 'active' : ''}" onclick="selectAisle('${a}')">${a}</button>
  `).join('');
}

function selectAisle(aisle) {
  currentAisle = aisle;
  renderAisleChips();
  renderGrid();
}

function renderGrid() {
  const grid = document.getElementById('warehouse-grid');
  if(!grid) return;
  
  const filtered = mockData.filter(item => item.row === currentAisle);
  grid.innerHTML = filtered.map(item => `
    <div class="cell" data-address="${item.cell}" onclick="onCellClick('${item.cell}')">
      <div class="addr">${item.cell}</div>
      <div class="info">${item.name} (${item.count} шт)</div>
    </div>
  `).join('');
}

function onCellClick(cellAddr) {
  const matches = mockData.filter(i => i.cell === cellAddr);
  openDrawer(`Ячейка ${cellAddr}`, matches);
}

function openDrawer(title, items) {
  const drawer = document.getElementById('info-drawer');
  const titleEl = document.getElementById('drawer-title');
  const contentEl = document.getElementById('drawer-content');
  
  if(titleEl) titleEl.innerText = title;
  if(contentEl) {
    contentEl.innerHTML = items.map(i => `
      <div style="padding: 10px 0; border-bottom: 1px solid var(--border-color);">
        <p><strong>Товар:</strong> ${i.name}</p>
        <p><strong>Штрихкод:</strong> ${i.code}</p>
        <p><strong>Количество:</strong> ${i.count} шт.</p>
      </div>
    `).join('');
  }
  if(drawer) drawer.classList.add('open');
}

document.addEventListener('DOMContentLoaded', () => {
  renderAisleChips();
  renderGrid();

  const scanBtn = document.getElementById('scan-barcode-btn');
  if(scanBtn) scanBtn.addEventListener('click', openBarcodeScanner);

  const mapScanBtn = document.getElementById('map-scan-barcode-btn');
  if(mapScanBtn) mapScanBtn.addEventListener('click', openBarcodeScanner);

  const closeDrawerBtn = document.getElementById('close-drawer');
  if(closeDrawerBtn) {
    closeDrawerBtn.addEventListener('click', () => {
      document.getElementById('info-drawer').classList.remove('open');
    });
  }

  const themeBtn = document.getElementById('theme-toggle-btn');
  if(themeBtn) {
    themeBtn.addEventListener('click', () => {
      const current = document.body.getAttribute('data-theme');
      if(current === 'dark') {
        document.body.removeAttribute('data-theme');
      } else {
        document.body.setAttribute('data-theme', 'dark');
      }
    });
  }

  const mapSearch = document.getElementById('map-search');
  if(mapSearch) {
    mapSearch.addEventListener('keyup', (e) => {
      if(e.key === 'Enter') {
        handleScannedCode(e.target.value);
      }
    });
    if(!isEditing && !drawerOpen) syncFromServer(false);
  }
});
