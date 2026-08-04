// push-notifications.js — подписка на push-уведомления (задания и чаты) +
// экран настроек в профиле. Подключается отдельным файлом (а не встроен в
// app.js), чтобы не трогать основной файл — использует те же глобальные
// элементы модалки (#modal-backdrop и т.д.), что и app.js.
//
// Работает по стандарту Web Push (VAPID): один и тот же код обслуживает
// Android/десктоп (Chrome, Яндекс.Браузер — работает сразу, без установки
// приложения) и iPhone (Safari — Apple требует, чтобы сайт был добавлен на
// экран «Домой» через «Поделиться → На экран «Домой»»; до этого push на iOS
// физически недоступен ни одному сайту, это ограничение самой iOS, а не
// этого сайта).

(function () {
  const API_BASE = '';

  function apiFetch(url, opts) {
    return fetch(API_BASE + url, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
    return outputArray;
  }

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  }

  function pushSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }

  async function getSwRegistration() {
    return navigator.serviceWorker.ready;
  }

  async function getExistingSubscription() {
    if (!pushSupported()) return null;
    const reg = await getSwRegistration();
    return reg.pushManager.getSubscription();
  }

  async function subscribe() {
    const reg = await getSwRegistration();
    const keyRes = await apiFetch('/api/push/public-key');
    const { publicKey } = await keyRes.json();
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey)
    });
    await apiFetch('/api/push/subscribe', { method: 'POST', body: JSON.stringify({ subscription: sub.toJSON() }) });
    return sub;
  }

  async function unsubscribe() {
    const sub = await getExistingSubscription();
    if (!sub) return;
    await apiFetch('/api/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) });
    await sub.unsubscribe();
  }

  function escHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function openSharedModal(title, bodyHtml, footerHtml) {
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').innerHTML = bodyHtml;
    document.getElementById('modal-footer').innerHTML = footerHtml || '';
    document.getElementById('modal-backdrop').classList.add('open');
  }
  function closeSharedModal() {
    document.getElementById('modal-backdrop').classList.remove('open');
  }

  function toggleRowHtml(id, label, checked, disabled) {
    return `
      <label class="np-row" for="${id}" style="display:flex; align-items:center; justify-content:space-between; gap:12px; padding:12px 0; border-bottom:1px solid var(--line);">
        <span>${escHtml(label)}</span>
        <input type="checkbox" id="${id}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} style="width:20px; height:20px;">
      </label>`;
  }

  async function renderSettingsModal() {
    if (!pushSupported()) {
      openSharedModal('🔔 Уведомления', `
        <p>Этот браузер не поддерживает push-уведомления.</p>
      `, '<button class="btn" id="np-close">Закрыть</button>');
      wireClose();
      return;
    }

    if (isIOS() && !isStandalone()) {
      openSharedModal('🔔 Уведомления', `
        <p>На iPhone уведомления работают только у приложения, установленного на экран «Домой» — это требование самой iOS.</p>
        <p style="margin-top:10px;">Чтобы включить: нажмите <b>«Поделиться»</b> (значок ⬆️ снизу в Safari) → <b>«На экран «Домой»»</b> → откройте сайт с появившегося значка и зайдите в «Уведомления» снова.</p>
      `, '<button class="btn" id="np-close">Закрыть</button>');
      wireClose();
      return;
    }

    openSharedModal('🔔 Уведомления', `<p id="np-loading">Загрузка…</p>`, '<button class="btn" id="np-close">Закрыть</button>');
    wireClose();

    let prefs = { tasks: true, chats: true };
    let hasSubscriptions = false;
    try {
      const res = await apiFetch('/api/push/settings');
      const data = await res.json();
      prefs = data.prefs || prefs;
      hasSubscriptions = !!data.hasSubscriptions;
    } catch (e) { /* всё равно покажем UI на дефолтах */ }

    const existingSub = await getExistingSubscription();
    const permission = Notification.permission; // 'default' | 'granted' | 'denied'
    const enabledOnThisDevice = !!existingSub;

    renderBody({ prefs, permission, enabledOnThisDevice, hasSubscriptions });
  }

  function renderBody({ prefs, permission, enabledOnThisDevice, hasSubscriptions }) {
    const body = document.getElementById('modal-body');
    if (!body) return;

    let masterHtml;
    if (permission === 'denied') {
      masterHtml = `<p style="color:var(--danger);">Уведомления заблокированы в настройках браузера/телефона. Разрешите их для этого сайта в системных настройках, чтобы включить.</p>`;
    } else {
      masterHtml = `
        <button type="button" class="btn" id="np-master-toggle" style="width:100%; margin-bottom:14px;">
          ${enabledOnThisDevice ? '🔕 Выключить уведомления на этом устройстве' : '🔔 Включить уведомления на этом устройстве'}
        </button>`;
    }

    body.innerHTML = `
      ${masterHtml}
      <div id="np-categories" style="${enabledOnThisDevice ? '' : 'opacity:.5; pointer-events:none;'}">
        ${toggleRowHtml('np-cat-tasks', 'Новые задания', prefs.tasks, false)}
        ${toggleRowHtml('np-cat-chats', 'Сообщения в чатах', prefs.chats, false)}
      </div>
      <p style="margin-top:12px; font-size:12.5px; color:var(--ink-soft);">Настройки категорий действуют на всех ваших устройствах сразу. Кнопка выше — только для этого устройства.</p>
      <p id="np-error" style="display:none; color:var(--danger); margin-top:10px;"></p>
    `;

    const masterBtn = document.getElementById('np-master-toggle');
    if (masterBtn) {
      masterBtn.addEventListener('click', async () => {
        masterBtn.disabled = true;
        const errBox = document.getElementById('np-error');
        if (errBox) errBox.style.display = 'none';
        try {
          if (enabledOnThisDevice) {
            await unsubscribe();
          } else {
            if (Notification.permission === 'default') {
              const perm = await Notification.requestPermission();
              if (perm !== 'granted') throw new Error('Разрешение не выдано');
            } else if (Notification.permission === 'denied') {
              throw new Error('Уведомления заблокированы в браузере');
            }
            await subscribe();
          }
          await renderSettingsModal();
        } catch (err) {
          if (errBox) { errBox.textContent = err.message || 'Не удалось изменить настройку'; errBox.style.display = 'block'; }
          masterBtn.disabled = false;
        }
      });
    }

    const tasksBox = document.getElementById('np-cat-tasks');
    const chatsBox = document.getElementById('np-cat-chats');
    async function savePrefs() {
      try {
        await apiFetch('/api/push/settings', {
          method: 'PUT',
          body: JSON.stringify({ tasks: tasksBox.checked, chats: chatsBox.checked })
        });
      } catch (e) { /* тихо: чекбоксы уже отражают локальное состояние */ }
    }
    if (tasksBox) tasksBox.addEventListener('change', savePrefs);
    if (chatsBox) chatsBox.addEventListener('change', savePrefs);
  }

  function wireClose() {
    const btn = document.getElementById('np-close');
    if (btn) btn.addEventListener('click', closeSharedModal);
  }

  function init() {
    const btn = document.getElementById('pp-notifications');
    if (btn) btn.addEventListener('click', renderSettingsModal);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
