// auth.js — экран входа, виджет профиля в правом верхнем углу и модалка
// управления пользователями/ролями. Загружается до app.js и не зависит от
// его внутренностей: app.js лишь ждёт window.__whenAuthed перед тем, как
// начать загружать данные склада.
(function () {
  "use strict";

  const API_BASE = "";

  // Резолвится один раз, когда мы точно знаем, что пользователь вошёл —
  // либо сразу (валидная сессия), либо после отправки формы входа.
  let resolveAuthed;
  window.__whenAuthed = new Promise((resolve) => { resolveAuthed = resolve; });

  let currentUser = null;
  let cachedRoles = []; // роли (кроме service) — подгружаются лениво при первом открытии модалки

  const $ = (id) => document.getElementById(id);

  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  // Текст вида "онлайн" / "был(а) в сети 24.07 22:21" / "ещё не входил(а)".
  function formatLastSeen(u) {
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

  // ---------- экран входа ----------
  function showAuthScreen() {
    showAuthCard('login');
    $('auth-screen').classList.add('show');
  }
  function hideAuthScreen() {
    $('auth-screen').classList.remove('show');
  }
  function setAuthError(msg) {
    const el = $('auth-error');
    if (!msg) { el.style.display = 'none'; el.textContent = ''; return; }
    el.textContent = msg;
    el.style.display = 'block';
  }

  $('auth-login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    setAuthError('');
    const username = $('auth-login-username').value.trim();
    const password = $('auth-login-password').value;
    const btn = $('auth-login-submit');
    btn.disabled = true;
    btn.textContent = 'Входим…';
    try {
      const res = await fetch(API_BASE + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'Не удалось войти');
      currentUser = payload.user;
      applyUserToUI();
      hideAuthScreen();
      $('auth-login-password').value = '';
      resolveAuthed(currentUser);
    } catch (err) {
      setAuthError(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Войти';
    }
  });

  // ---------- заявка на регистрацию ----------
  function showAuthCard(which) {
    $('auth-login-form').style.display = which === 'login' ? '' : 'none';
    // Обе карточки ниже имеют в CSS явный display:none по умолчанию —
    // сброс инлайн-стиля в '' просто вернул бы их к этому правилу и они
    // остались бы невидимыми, поэтому при показе выставляем display явно.
    $('auth-register-form').style.display = which === 'register' ? 'block' : 'none';
    $('auth-register-success').style.display = which === 'success' ? 'block' : 'none';
  }
  function setRegisterError(msg) {
    const el = $('auth-register-error');
    if (!msg) { el.style.display = 'none'; el.textContent = ''; return; }
    el.textContent = msg;
    el.style.display = 'block';
  }
  $('auth-show-register').addEventListener('click', () => { setAuthError(''); showAuthCard('register'); });
  $('auth-show-login').addEventListener('click', () => { setRegisterError(''); showAuthCard('login'); });
  $('auth-register-success-ok').addEventListener('click', () => {
    $('auth-register-form').reset();
    showAuthCard('login');
  });

  $('auth-register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    setRegisterError('');
    const username = $('auth-register-username').value.trim();
    const displayName = $('auth-register-displayname').value.trim();
    const password = $('auth-register-password').value;
    const password2 = $('auth-register-password2').value;
    if (password !== password2) { setRegisterError('Пароли не совпадают'); return; }
    const btn = $('auth-register-submit');
    btn.disabled = true;
    btn.textContent = 'Отправляем…';
    try {
      const res = await fetch(API_BASE + '/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, displayName, password })
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'Не удалось отправить заявку');
      showAuthCard('success');
    } catch (err) {
      setRegisterError(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Отправить заявку';
    }
  });

  // ---------- профиль (отдельная страница, как в Telegram) ----------
  function applyAvatarTo(el, label, avatarUrl) {
    if (avatarUrl) {
      el.style.backgroundImage = `url("${avatarUrl}")`;
      el.textContent = '';
    } else {
      el.style.backgroundImage = '';
      el.textContent = initials(label);
    }
  }

  function applyUserToUI() {
    if (!currentUser) return;
    window.__currentUser = currentUser;

    // Ссылка на «Учёт времени» — тот же домен, просто другой путь (/time/);
    // считаем её раньше остального, т.к. дальше она нужна и для ссылки в
    // меню, и для немедленного увода тех, у кого нет доступа к складу.
    const ttUrl = window.__TIMETRACKER_PORT
      ? `${location.protocol}//${location.hostname}:${window.__TIMETRACKER_PORT}/`
      : '/time/';

    // Без canAccessWarehouse человеку тут делать нечего (роль вроде «Пост»
    // заведена только ради «Учёта времени») — сразу уводим его туда, не
    // рисуя интерфейс склада. Сервисный аккаунт не проверяем отдельно: у
    // него это право всегда включено (см. DEFAULT_ROLES в storage/db.js).
    // Роль «Пост» ведём сразу на страницу QR-кода охраны — ей больше
    // никакие другие страницы «Учёта времени» не нужны; профиль охранника
    // там заводится автоматически при первом заходе (см. timetracker/server.js),
    // отдельно привязывать аккаунт не нужно.
    if (!currentUser.perms.canAccessWarehouse) {
      location.replace(currentUser.role === 'post' ? ttUrl + 'guard.html' : ttUrl);
      return;
    }

    const label = currentUser.displayName || currentUser.username;
    const avatar = $('profile-avatar');
    applyAvatarTo(avatar, label, currentUser.avatarUrl);
    const dot = document.createElement('span');
    dot.className = 'status-dot';
    avatar.appendChild(dot); // textContent write above already cleared any previous dot
    $('profile-name').textContent = label;
    $('profile-role').textContent = currentUser.roleLabel;

    // Аватарка в кнопке "Профиль" нижней панели (телефон) — та же картинка/
    // инициалы, что и в скрытом на телефоне виджете шапки выше.
    const bnAvatar = $('bn-profile-avatar');
    if (bnAvatar) applyAvatarTo(bnAvatar, label, currentUser.avatarUrl);

    applyAvatarTo($('pp-avatar'), label, currentUser.avatarUrl);
    $('pp-name').textContent = label;
    $('pp-role').textContent = currentUser.roleLabel;
    $('pp-manage-users').style.display = currentUser.perms.canManageUsers ? '' : 'none';
    $('pp-avatar-remove-btn').style.display = currentUser.avatarUrl ? '' : 'none';

    // Ссылка на «Учёт времени» (ttUrl уже вычислен выше) — теперь тот же
    // домен, просто другой путь (/time/); при полном слиянии в один процесс
    // (см. merged/gateway) это предпочтительнее старой схемы "тот же хост,
    // другой порт", т.к. не требует объяснять браузеру дополнительный
    // TCP-порт. Cookie сессии общая, повторный вход не нужен.
    const ttLink = $('timetracker-link');
    if (ttLink) { ttLink.href = ttUrl; ttLink.style.display = ''; }
    const ttLinkMobile = $('bn-timetracker-link');
    if (ttLinkMobile) { ttLinkMobile.href = ttUrl; ttLinkMobile.style.display = ''; }
    const ttMenuItem = $('app-menu-timetracker-item');
    if (ttMenuItem) { ttMenuItem.dataset.href = ttUrl; ttMenuItem.style.display = ''; }
    const ttHubTile = $('hub-tile-time');
    if (ttHubTile) { ttHubTile.href = ttUrl; ttHubTile.style.display = ''; }

    document.body.classList.toggle('perm-no-read-activity', !currentUser.perms.canReadActivity);
    document.body.classList.toggle('perm-no-manage-activity', !currentUser.perms.canManageActivity);
    document.body.classList.toggle('perm-no-manage-tasks', !currentUser.perms.canManageTasks);
    document.body.classList.toggle('perm-no-manage-users', !currentUser.perms.canManageUsers);
    document.body.classList.toggle('perm-no-import-data', !currentUser.perms.canImportData);
    document.body.classList.toggle('perm-no-edit-layout', !currentUser.perms.canEditLayout);
    // Бэкапы — не настраиваемое право, а доступ, зашитый именно за
    // сервисным аккаунтом (см. auth.js на сервере: requireServiceRole).
    document.body.classList.toggle('is-service', currentUser.role === 'service');
    document.querySelectorAll('.db-actions-service-only').forEach(el => {
      el.style.display = currentUser.role === 'service' ? '' : 'none';
    });

    // Для тех, у кого нет прав на управление аккаунтами, раздел показывает
    // только список коллег и их ролей — переименовываем пункт меню, чтобы
    // это было понятно сразу, не открывая его.
    const bnAccountsLabel = currentUser.perms.canManageUsers ? 'Аккаунты' : 'Сотрудники';
    if ($('bn-accounts-label')) $('bn-accounts-label').textContent = bnAccountsLabel;
    if ($('hub-accounts-label')) $('hub-accounts-label').textContent = bnAccountsLabel;
  }

  function openProfilePage() {
    $('profile-page').classList.add('open');
  }
  function closeProfilePage() {
    $('profile-page').classList.remove('open');
  }
  $('profile-pill').addEventListener('click', openProfilePage);
  $('profile-page-back').addEventListener('click', closeProfilePage);

  $('pp-logout').addEventListener('click', async () => {
    try { await fetch(API_BASE + '/api/auth/logout', { method: 'POST' }); } catch (_) {}
    location.reload();
  });

  // ---------- аватарка: сжимаем в браузере перед отправкой ----------
  // Обрезаем по центру в квадрат и уменьшаем до 256×256 — с сервера в базу
  // попадает уже маленький файл (обычно 15–40 КБ), а не то, что выбрал
  // пользователь (фото с телефона может весить 5-10 МБ).
  function resizeImageToBlob(file, size = 256, quality = 0.85) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const side = Math.min(img.naturalWidth, img.naturalHeight);
        const sx = (img.naturalWidth - side) / 2;
        const sy = (img.naturalHeight - side) / 2;
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
        canvas.toBlob(
          (blob) => blob ? resolve(blob) : reject(new Error('Не удалось обработать изображение')),
          'image/jpeg', quality
        );
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Файл повреждён или это не изображение')); };
      img.src = url;
    });
  }

  $('pp-avatar-upload-btn').addEventListener('click', () => $('pp-avatar-input').click());

  $('pp-avatar-input').addEventListener('change', async () => {
    const file = $('pp-avatar-input').files[0];
    $('pp-avatar-input').value = ''; // чтобы повторный выбор того же файла тоже сработал
    if (!file) return;
    const btn = $('pp-avatar-upload-btn');
    const prevLabel = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '🖼 <span>Загружаем…</span>';
    try {
      const blob = await resizeImageToBlob(file);
      const form = new FormData();
      form.append('avatar', blob, 'avatar.jpg');
      const res = await fetch(API_BASE + '/api/profile/avatar', { method: 'POST', body: form });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'Не удалось загрузить аватарку');
      currentUser = payload.user;
      applyUserToUI();
    } catch (err) {
      alert(err.message);
    } finally {
      btn.disabled = false;
      btn.innerHTML = prevLabel;
    }
  });

  $('pp-avatar-remove-btn').addEventListener('click', async () => {
    if (!confirm('Убрать фото профиля?')) return;
    try {
      const res = await fetch(API_BASE + '/api/profile/avatar', { method: 'DELETE' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || 'Не удалось удалить аватарку');
      currentUser = payload.user;
      applyUserToUI();
    } catch (err) {
      alert(err.message);
    }
  });

  // ---------- маленькая модалка (независимая от app.js) ----------
  function openAuthModal(title, bodyHtml, footerHtml) {
    $('auth-modal-title').textContent = title;
    $('auth-modal-body').innerHTML = bodyHtml;
    $('auth-modal-footer').innerHTML = footerHtml || '';
    $('auth-modal-backdrop').classList.add('show');
  }
  function closeAuthModal() {
    $('auth-modal-backdrop').classList.remove('show');
    $('auth-modal-body').innerHTML = '';
    $('auth-modal-footer').innerHTML = '';
  }
  $('auth-modal-close').addEventListener('click', closeAuthModal);
  $('auth-modal-backdrop').addEventListener('click', (e) => {
    if (e.target.id === 'auth-modal-backdrop') closeAuthModal();
  });

  // ---------- смена собственного пароля ----------
  $('pp-change-password').addEventListener('click', () => {
    openAuthModal('Сменить пароль', `
      <div class="auth-field">
        <label>Текущий пароль</label>
        <input type="password" id="cp-current" autocomplete="current-password">
      </div>
      <div class="auth-field">
        <label>Новый пароль (от 6 символов)</label>
        <input type="password" id="cp-new" autocomplete="new-password">
      </div>
      <div id="cp-error" style="display:none; color:var(--danger); font-size:12.5px; margin-top:4px;"></div>
    `, `<button class="btn" id="cp-cancel">Отмена</button><button class="btn primary" id="cp-submit">Сохранить</button>`);
    $('cp-cancel').addEventListener('click', closeAuthModal);
    $('cp-submit').addEventListener('click', async () => {
      const currentPassword = $('cp-current').value;
      const newPassword = $('cp-new').value;
      const errEl = $('cp-error');
      errEl.style.display = 'none';
      try {
        const res = await fetch(API_BASE + '/api/auth/change-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPassword, newPassword })
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(payload.error || 'Не удалось сменить пароль');
        closeAuthModal();
      } catch (err) {
        errEl.textContent = err.message;
        errEl.style.display = 'block';
      }
    });
  });

  // ---------- редактирование собственного имени и логина ----------
  // Доступно вообще любому вошедшему пользователю, а не только тем, у кого
  // есть право управлять аккаунтами — сервер разрешает PATCH /api/users/:id
  // для self-запросов отдельно от canManageUsers (см. server.js).
  $('pp-edit-identity').addEventListener('click', () => {
    if (!currentUser) return;
    openAuthModal('Изменить имя и логин', `
      <div class="auth-field">
        <label>Отображаемое имя</label>
        <input type="text" id="ei-name" value="${escHtml(currentUser.displayName || '')}">
      </div>
      <div class="auth-field">
        <label>Логин</label>
        <input type="text" id="ei-login" value="${escHtml(currentUser.username || '')}">
      </div>
      <div id="ei-error" style="display:none; color:var(--danger); font-size:12.5px; margin-top:4px;"></div>
    `, `<button class="btn" id="ei-cancel">Отмена</button><button class="btn primary" id="ei-submit">Сохранить</button>`);
    $('ei-cancel').addEventListener('click', closeAuthModal);
    $('ei-submit').addEventListener('click', async () => {
      const displayName = $('ei-name').value.trim();
      const username = $('ei-login').value.trim();
      const errEl = $('ei-error');
      errEl.style.display = 'none';
      if (!username) { errEl.textContent = 'Логин не может быть пустым'; errEl.style.display = 'block'; return; }
      try {
        const res = await fetch(`${API_BASE}/api/users/${currentUser.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, displayName })
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(payload.error || 'Не удалось сохранить изменения');
        currentUser = payload.user;
        applyUserToUI();
        closeAuthModal();
      } catch (err) {
        errEl.textContent = err.message;
        errEl.style.display = 'block';
      }
    });
  });

  // ---------- управление пользователями и ролями (сервисный аккаунт / начальник) ----------
  async function loadUsers() {
    const res = await fetch(API_BASE + '/api/users');
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || 'Не удалось загрузить список пользователей');
    return payload.users || [];
  }

  async function loadRoles(force) {
    if (cachedRoles.length && !force) return cachedRoles;
    const res = await fetch(API_BASE + '/api/roles');
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || 'Не удалось загрузить список ролей');
    cachedRoles = payload.roles || [];
    return cachedRoles;
  }

  function roleSelectHtml(roles, selected, disabled) {
    const assignable = roles.filter(r => r.key !== 'service');
    return `<select ${disabled ? 'disabled' : ''} class="u-role-select">` +
      assignable.map(r => `<option value="${escHtml(r.key)}" ${r.key === selected ? 'selected' : ''}>${escHtml(r.label)}</option>`).join('') +
      `</select>`;
  }

  // Полный (нефильтрованный) список пользователей — от него зависит, что
  // именно значит "переместить вверх/вниз": стрелки всегда переставляют
  // соседей в РЕАЛЬНОМ порядке, даже если сейчас применён поиск и на экране
  // видна только часть строк. Кэшируется здесь же, чтобы фильтрация по
  // поиску не дёргала сеть на каждое нажатие клавиши.
  let lastUsersFull = [];
  let lastRoles = [];

  function matchesUsersSearch(u, term) {
    if (!term) return true;
    const label = (u.display_name || u.username || '').toLowerCase();
    const login = (u.username || '').toLowerCase();
    return label.includes(term) || login.includes(term);
  }

  // Найти ближайшего соседа той же роли в ПОЛНОМ списке (в одну или другую
  // сторону) — так стрелки ↑/↓ переставляют пользователя только в пределах
  // его категории по роли, не трогая порядок других ролей.
  function sameRoleNeighborIndex(users, idx, dir) {
    const role = users[idx].role;
    for (let j = idx + dir; j >= 0 && j < users.length; j += dir) {
      if (users[j].role === role) return j;
    }
    return -1;
  }

  function renderUserRowHtml(u, roles, users) {
    const isService = u.role === 'service';
    const isSelf = currentUser && u.id === currentUser.id;
    const label = u.display_name || u.username;
    const avatarInner = u.avatarUrl
      ? ''
      : escHtml(initials(label));
    const avatarStyle = u.avatarUrl ? ` style="background-image:url('${escHtml(u.avatarUrl)}')"` : '';
    const fullIdx = users.findIndex(x => x.id === u.id);
    const canMoveUp = !isService && sameRoleNeighborIndex(users, fullIdx, -1) !== -1;
    const canMoveDown = !isService && sameRoleNeighborIndex(users, fullIdx, 1) !== -1;
    return `
    <div class="user-row ${u.disabled ? 'disabled' : ''}" data-id="${u.id}">
      <div class="u-order-actions">
        <button type="button" class="icon-btn" data-action="move-up" title="Переместить вверх" ${canMoveUp ? '' : 'disabled'}>↑</button>
        <button type="button" class="icon-btn" data-action="move-down" title="Переместить вниз" ${canMoveDown ? '' : 'disabled'}>↓</button>
      </div>
      <div class="u-avatar"${avatarStyle}>${avatarInner}</div>
      <div class="u-info">
        <div class="u-view">
          <div class="u-name">${escHtml(label)}${isSelf ? ' <span style="color:var(--ink-soft); font-weight:400;">(вы)</span>' : ''}</div>
          <div class="u-login">@${escHtml(u.username)}${!isService ? `<span class="tt-account-badge" style="margin-left:8px; font-size:10.5px; padding:2px 7px; border-radius:999px; ${u.hasTimetrackerAccount ? 'background:var(--accent-soft); color:var(--accent);' : 'background:var(--panel-soft, #eee); color:var(--ink-soft);'}" title="${u.hasTimetrackerAccount ? 'Есть аккаунт в учёте времени' : 'Нет аккаунта в учёте времени'}">${u.hasTimetrackerAccount ? '⏱ есть в учёте времени' : '⏱ нет в учёте времени'}</span>` : ''}</div>
          ${!isService ? `<div class="u-tt-actions" style="margin-top:6px; display:flex; gap:6px; flex-wrap:wrap;">
            ${u.hasTimetrackerAccount ? `
              <button type="button" class="btn" data-tt-action="positions" style="font-size:11px; padding:4px 8px;">✏️ Должности</button>
              <button type="button" class="btn" data-tt-action="codes" style="font-size:11px; padding:4px 8px;">📅 Коды табеля</button>
              <button type="button" class="btn" data-tt-action="toggle-active" style="font-size:11px; padding:4px 8px;">⏻ Вкл/откл пропуск</button>
            ` : u.role !== 'post' ? `<button type="button" class="btn" data-tt-action="link" style="font-size:11px; padding:4px 8px;">🔗 Привязать к учёту времени</button>` : ''}
          </div>` : ''}
          <div class="u-status"><span class="u-status-dot${u.online ? ' online' : ''}"></span>${escHtml(formatLastSeen(u))}</div>
        </div>
        <div class="u-edit">
          <input type="text" class="u-edit-name" value="${escHtml(u.display_name || '')}" placeholder="Имя">
          <input type="text" class="u-edit-login" value="${escHtml(u.username)}" placeholder="Логин">
          <div class="u-edit-error" style="display:none;"></div>
        </div>
      </div>
      ${isService ? `<span class="role-badge" style="background:var(--accent-soft); color:var(--accent); font-size:11px; padding:3px 9px; border-radius:999px;">${escHtml(u.roleLabel)}</span>`
        : roleSelectHtml(roles, u.role, false)}
      <div class="u-actions">
        ${!isService && !isSelf ? `<button type="button" class="icon-btn" data-open-dm="${u.id}" title="Написать">💬</button>` : ''}
        ${!isService ? `<button type="button" class="icon-btn" data-action="edit-identity" title="Изменить логин и имя">✏</button>` : ''}
        <button type="button" class="icon-btn edit-save-btn" data-action="save-identity" title="Сохранить">💾</button>
        <button type="button" class="icon-btn edit-cancel-btn" data-action="cancel-identity" title="Отмена">✕</button>
        ${!isService ? `<button type="button" class="icon-btn" data-action="reset-pw" title="Сбросить пароль">🔑</button>` : ''}
        ${!isService ? `<button type="button" class="icon-btn" data-action="toggle-disabled" title="${u.disabled ? 'Разблокировать' : 'Заблокировать'}">${u.disabled ? '✅' : '⛔'}</button>` : ''}
        ${!isService && !isSelf ? `<button type="button" class="icon-btn danger" data-action="delete" title="Удалить">🗑</button>` : ''}
      </div>
    </div>`;
  }

  function renderUsersRows(users, roles) {
    const listEl = $('users-list');
    if (!listEl) return;
    const searchTerm = ($('users-search') && $('users-search').value.trim().toLowerCase()) || '';
    const filtered = users.filter(u => matchesUsersSearch(u, searchTerm));
    if (!users.length) {
      listEl.innerHTML = '<div style="padding:10px; color:var(--ink-soft); font-size:12.5px;">Пока нет ни одного аккаунта.</div>';
      return;
    }
    if (!filtered.length) {
      listEl.innerHTML = '<div style="padding:10px; color:var(--ink-soft); font-size:12.5px;">Ничего не найдено.</div>';
      return;
    }
    // Группируем по роли — порядок категорий берём из списка ролей (тот же,
    // что и в выпадающих списках: сервисная роль первая, дальше по порядку
    // создания), внутри категории сохраняется порядок из общего списка.
    const roleLabelByKey = {};
    roles.forEach(r => { roleLabelByKey[r.key] = r.label; });
    const roleOrder = roles.map(r => r.key);
    filtered.forEach(u => { if (!roleOrder.includes(u.role)) roleOrder.push(u.role); });

    listEl.innerHTML = roleOrder.map(roleKey => {
      const usersInRole = filtered.filter(u => u.role === roleKey);
      if (!usersInRole.length) return '';
      const heading = escHtml(roleLabelByKey[roleKey] || usersInRole[0].roleLabel || roleKey);
      return `
        <div class="users-role-group">
          <div class="users-role-heading">${heading} <span class="users-role-count">${usersInRole.length}</span></div>
          ${usersInRole.map(u => renderUserRowHtml(u, roles, users)).join('')}
        </div>`;
    }).join('');

    listEl.querySelectorAll('[data-action="move-up"], [data-action="move-down"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (btn.disabled) return;
        const row = btn.closest('.user-row');
        const id = Number(row.dataset.id);
        const idx = lastUsersFull.findIndex(x => x.id === id);
        if (idx === -1) return;
        const swapWith = sameRoleNeighborIndex(lastUsersFull, idx, btn.dataset.action === 'move-up' ? -1 : 1);
        if (swapWith === -1) return;
        const reordered = lastUsersFull.slice();
        [reordered[idx], reordered[swapWith]] = [reordered[swapWith], reordered[idx]];
        const order = reordered.map(u => u.id);
        btn.disabled = true;
        try {
          const res = await fetch(`${API_BASE}/api/users/reorder`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ order })
          });
          const payload = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(payload.error || 'Не удалось изменить порядок');
        } catch (err) {
          alert(err.message);
        } finally {
          renderUsersList();
        }
      });
    });

    listEl.querySelectorAll('.user-row').forEach(row => {
        const id = row.dataset.id;
        const select = row.querySelector('.u-role-select');
        if (select) {
          select.addEventListener('change', async () => {
            try {
              const res = await fetch(`${API_BASE}/api/users/${id}`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ role: select.value })
              });
              const payload = await res.json().catch(() => ({}));
              if (!res.ok) throw new Error(payload.error || 'Не удалось изменить роль');
            } catch (err) {
              alert(err.message);
              renderUsersList();
            }
          });
        }
        row.querySelectorAll('.icon-btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            const action = btn.dataset.action;
            // Редактирование логина/имени — отдельная, не сетевая логика для
            // edit/cancel (просто переключают режим строки); сеть только на save.
            if (action === 'edit-identity') {
              row.classList.add('editing');
              row.querySelector('.u-edit-name').focus();
              return;
            }
            if (action === 'cancel-identity') {
              row.classList.remove('editing');
              row.querySelector('.u-edit-error').style.display = 'none';
              return;
            }
            try {
              if (action === 'save-identity') {
                const errEl = row.querySelector('.u-edit-error');
                errEl.style.display = 'none';
                const displayName = row.querySelector('.u-edit-name').value.trim();
                const username = row.querySelector('.u-edit-login').value.trim();
                if (!username) { errEl.textContent = 'Логин не может быть пустым'; errEl.style.display = 'block'; return; }
                const res = await fetch(`${API_BASE}/api/users/${id}`, {
                  method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ username, displayName })
                });
                const payload = await res.json().catch(() => ({}));
                if (!res.ok) {
                  errEl.textContent = payload.error || 'Не удалось сохранить изменения';
                  errEl.style.display = 'block';
                  return;
                }
                if (currentUser && Number(id) === currentUser.id) {
                  currentUser.username = payload.user.username;
                  currentUser.displayName = payload.user.displayName;
                  applyUserToUI();
                }
              } else if (action === 'delete') {
                if (!confirm('Удалить этот аккаунт? Это действие необратимо.')) return;
                const res = await fetch(`${API_BASE}/api/users/${id}`, { method: 'DELETE' });
                const payload = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(payload.error || 'Не удалось удалить');
              } else if (action === 'toggle-disabled') {
                const wantDisable = !row.classList.contains('disabled');
                const res = await fetch(`${API_BASE}/api/users/${id}`, {
                  method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ disabled: wantDisable })
                });
                const payload = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(payload.error || 'Не удалось изменить статус');
              } else if (action === 'reset-pw') {
                const pw = prompt('Новый пароль для этого аккаунта (от 6 символов):');
                if (!pw) return;
                const res = await fetch(`${API_BASE}/api/users/${id}/reset-password`, {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ password: pw })
                });
                const payload = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(payload.error || 'Не удалось сбросить пароль');
                alert('Пароль обновлён.');
              }
              renderUsersList();
            } catch (err) {
              alert(err.message);
            }
          });
        });
        row.querySelectorAll('[data-tt-action]').forEach(btn => {
          btn.addEventListener('click', async () => {
            const action = btn.dataset.ttAction;
            const label = row.querySelector('.u-name').textContent.trim();
            try {
              if (action === 'link') {
                const res = await fetch(`${API_BASE}/api/users/${id}/timetracker`, { method: 'POST' });
                const payload = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(payload.error || 'Не удалось привязать аккаунт');
                renderUsersList();
              } else if (action === 'toggle-active') {
                const res0 = await fetch(`${API_BASE}/api/users/${id}/timetracker`);
                const tt0 = await res0.json().catch(() => ({}));
                if (!res0.ok) throw new Error(tt0.error || 'Не удалось загрузить профиль учёта времени');
                const res = await fetch(`${API_BASE}/api/users/${id}/timetracker/active`, {
                  method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ active: !tt0.active })
                });
                const payload = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(payload.error || 'Не удалось изменить пропуск');
                alert(payload.active ? `Пропуск для «${label}» включён.` : `Пропуск для «${label}» отключён.`);
              } else if (action === 'positions') {
                await openPositionsModal(id, label);
              } else if (action === 'codes') {
                await openCodesModal(id, label);
              }
            } catch (err) {
              alert(err.message);
            }
          });
        });
      });
  }

  // ---------- «Учёт времени» из «Аккаунтов»: должности и коды табеля ----------
  function positionCardHtml(p, idx) {
    p = p || {};
    return `
    <div class="tt-pos-card" data-idx="${idx}" style="border:1px solid var(--line); border-radius:8px; padding:8px; margin-top:6px;">
      <div style="display:flex; gap:6px; align-items:center;">
        <input type="text" class="tt-pos-name" placeholder="Название должности" value="${escHtml(p.name || '')}" style="flex:1; padding:6px 8px; border:1px solid var(--line); border-radius:6px; font-size:12.5px; background:var(--panel); color:var(--ink);">
        <button type="button" class="icon-btn danger" data-action="remove-pos" title="Убрать должность">🗑</button>
      </div>
      <div style="display:flex; gap:6px; margin-top:6px;">
        <input type="text" class="tt-pos-start" placeholder="Начало ЧЧ:ММ" value="${escHtml(p.work_start || '')}" style="flex:1; padding:6px 8px; border:1px solid var(--line); border-radius:6px; font-size:12.5px; background:var(--panel); color:var(--ink);">
        <input type="text" class="tt-pos-end" placeholder="Конец ЧЧ:ММ" value="${escHtml(p.work_end || '')}" style="flex:1; padding:6px 8px; border:1px solid var(--line); border-radius:6px; font-size:12.5px; background:var(--panel); color:var(--ink);">
        <input type="number" class="tt-pos-hours" placeholder="Ч/день" value="${p.daily_hours != null ? escHtml(String(p.daily_hours)) : ''}" style="width:80px; padding:6px 8px; border:1px solid var(--line); border-radius:6px; font-size:12.5px; background:var(--panel); color:var(--ink);">
      </div>
    </div>`;
  }

  function wirePositionsBlock(blockEl) {
    blockEl.querySelectorAll('[data-action="remove-pos"]').forEach(btn => {
      btn.addEventListener('click', () => btn.closest('.tt-pos-card').remove());
    });
  }

  function readPositionsFromBlock(blockEl) {
    return Array.from(blockEl.querySelectorAll('.tt-pos-card')).map(card => ({
      name: card.querySelector('.tt-pos-name').value.trim(),
      work_start: card.querySelector('.tt-pos-start').value.trim() || null,
      work_end: card.querySelector('.tt-pos-end').value.trim() || null,
      daily_hours: card.querySelector('.tt-pos-hours').value.trim() || null
    })).filter(p => p.name);
  }

  async function openPositionsModal(userId, label) {
    const res = await fetch(`${API_BASE}/api/users/${userId}/timetracker`);
    const tt = await res.json().catch(() => ({}));
    if (!res.ok) { alert(tt.error || 'Не удалось загрузить профиль учёта времени'); return; }
    const positions = Array.isArray(tt.positions) ? tt.positions : [];
    openAuthModal(`Должности — ${escHtml(label)}`, `
      <div class="tt-positions-block" id="tt-positions-block">
        ${positions.map((p, i) => positionCardHtml(p, i)).join('')}
      </div>
      <button type="button" class="btn" id="tt-add-position" style="margin-top:8px; font-size:11.5px;">+ Добавить должность</button>
      <div class="hint" style="font-size:11px; color:var(--ink-soft); margin-top:8px;">Первая должность — основная: по ней считаются реально отработанные часы. Остальные — совмещение.</div>
      <div id="tt-pos-error" style="display:none; color:var(--danger); font-size:12.5px; margin-top:6px;"></div>
    `, `<button class="btn" id="tt-pos-cancel">Отмена</button><button class="btn primary" id="tt-pos-save">Сохранить</button>`);
    const block = $('tt-positions-block');
    wirePositionsBlock(block);
    $('tt-add-position').addEventListener('click', () => {
      block.insertAdjacentHTML('beforeend', positionCardHtml({}, block.children.length));
      wirePositionsBlock(block);
    });
    $('tt-pos-cancel').addEventListener('click', closeAuthModal);
    $('tt-pos-save').addEventListener('click', async () => {
      const errEl = $('tt-pos-error');
      errEl.style.display = 'none';
      try {
        const res2 = await fetch(`${API_BASE}/api/users/${userId}/timetracker/positions`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ positions: readPositionsFromBlock(block) })
        });
        const payload = await res2.json().catch(() => ({}));
        if (!res2.ok) throw new Error(payload.error || 'Не удалось сохранить должности');
        closeAuthModal();
      } catch (err) {
        errEl.textContent = err.message;
        errEl.style.display = 'block';
      }
    });
  }

  async function openCodesModal(userId, label) {
    const now = new Date();
    const defaultMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const [catalogRes] = await Promise.all([fetch(`${API_BASE}/api/users/${userId}/timetracker/codes-catalog`)]);
    const catalog = await catalogRes.json().catch(() => []);
    openAuthModal(`Коды табеля — ${escHtml(label)}`, `
      <div class="hint" style="font-size:11px; color:var(--ink-soft); margin-bottom:8px;">
        «Я» и обычные «В» считаются автоматически по отметкам прихода/ухода — код нужен только для отпуска, больничного и т.п.
      </div>
      <label>Месяц</label>
      <input type="month" id="tt-codes-month" value="${defaultMonth}" style="width:100%; padding:7px 9px; border:1px solid var(--line); border-radius:7px; font-size:13px; background:var(--panel); color:var(--ink); margin-bottom:8px;">
      <div id="tt-codes-list" style="max-height:180px; overflow:auto; border:1px solid var(--line); border-radius:8px; padding:6px; margin-bottom:10px; font-size:12.5px;"></div>
      <div style="display:flex; gap:6px; flex-wrap:wrap; align-items:end;">
        <div><label>Период с</label><input type="date" id="tt-range-from" style="padding:6px 8px; border:1px solid var(--line); border-radius:6px; background:var(--panel); color:var(--ink);"></div>
        <div><label>по</label><input type="date" id="tt-range-to" style="padding:6px 8px; border:1px solid var(--line); border-radius:6px; background:var(--panel); color:var(--ink);"></div>
        <div><label>Код</label>
          <select id="tt-range-code" style="padding:6px 8px; border:1px solid var(--line); border-radius:6px; background:var(--panel); color:var(--ink);">
            ${catalog.map(c => `<option value="${escHtml(c.code)}">${escHtml(c.code)} — ${escHtml(c.label)}</option>`).join('')}
          </select>
        </div>
        <button type="button" class="btn primary" id="tt-range-apply" style="font-size:11.5px;">Применить к периоду</button>
      </div>
      <div id="tt-codes-error" style="display:none; color:var(--danger); font-size:12.5px; margin-top:8px;"></div>
    `, `<button class="btn" id="tt-codes-close">Закрыть</button>`);

    async function loadMonth() {
      const month = $('tt-codes-month').value;
      const listEl = $('tt-codes-list');
      if (!month) return;
      listEl.textContent = 'Загрузка…';
      try {
        const res = await fetch(`${API_BASE}/api/users/${userId}/timetracker/codes?month=${encodeURIComponent(month)}`);
        const rows = await res.json().catch(() => []);
        if (!res.ok) throw new Error((rows && rows.error) || 'Не удалось загрузить коды');
        const withCodes = (rows || []).filter(r => r.code);
        listEl.innerHTML = withCodes.length ? withCodes.map(r => `
          <div style="display:flex; align-items:center; gap:8px; padding:3px 0;">
            <span style="width:90px;">${escHtml(r.date)}</span>
            <span style="font-weight:600;">${escHtml(r.code)}</span>
            <button type="button" class="btn" data-clear-date="${escHtml(r.date)}" style="margin-left:auto; font-size:10.5px; padding:2px 7px;">Убрать</button>
          </div>`).join('') : '<div style="color:var(--ink-soft);">На этот месяц кодов нет.</div>';
        listEl.querySelectorAll('[data-clear-date]').forEach(btn => {
          btn.addEventListener('click', async () => {
            try {
              const res2 = await fetch(`${API_BASE}/api/users/${userId}/timetracker/codes`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ date: btn.dataset.clearDate, code: '' })
              });
              if (!res2.ok) throw new Error((await res2.json().catch(() => ({}))).error || 'Не удалось убрать код');
              loadMonth();
            } catch (err) { alert(err.message); }
          });
        });
      } catch (err) {
        listEl.innerHTML = `<div style="color:var(--danger);">${escHtml(err.message)}</div>`;
      }
    }

    $('tt-codes-month').addEventListener('change', loadMonth);
    $('tt-codes-close').addEventListener('click', closeAuthModal);
    $('tt-range-apply').addEventListener('click', async () => {
      const errEl = $('tt-codes-error');
      errEl.style.display = 'none';
      const from = $('tt-range-from').value;
      const to = $('tt-range-to').value;
      const code = $('tt-range-code').value;
      if (!from || !to) { errEl.textContent = 'Укажите период'; errEl.style.display = 'block'; return; }
      try {
        const res = await fetch(`${API_BASE}/api/users/${userId}/timetracker/codes`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from, to, code })
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(payload.error || 'Не удалось применить период');
        loadMonth();
      } catch (err) {
        errEl.textContent = err.message;
        errEl.style.display = 'block';
      }
    });
    loadMonth();
  }

  let usersSearchWired = false;
  function wireUsersSearchOnce() {
    if (usersSearchWired) return;
    const input = $('users-search');
    if (!input) return;
    usersSearchWired = true;
    input.addEventListener('input', () => renderUsersRows(lastUsersFull, lastRoles));
  }

  async function renderUsersList(opts) {
    opts = opts || {};
    const listEl = $('users-list');
    if (!listEl) return;
    wireUsersSearchOnce();
    // Фоновые обновления (см. refreshUsersListIfIdle) не должны стирать
    // список на надпись "Загрузка…" перед подстановкой новых данных — это
    // на миг схлопывает контейнер и обратно растягивает его, отчего страницу
    // подбрасывает к началу. Плашку показываем только на первом открытии.
    if (opts.showLoading !== false) {
      listEl.innerHTML = '<div style="padding:10px; color:var(--ink-soft); font-size:12.5px;">Загрузка…</div>';
    }
    try {
      const [users, roles] = await Promise.all([loadUsers(), loadRoles()]);
      // Сервисный аккаунт — служебная запись для самой системы, не сотрудник;
      // в списке управления пользователями его не показываем.
      lastUsersFull = users.filter(u => u.role !== 'service');
      lastRoles = roles;
      renderUsersRows(lastUsersFull, roles);
    } catch (err) {
      listEl.innerHTML = `<div style="padding:10px; color:var(--danger); font-size:12.5px;">${escHtml(err.message)}</div>`;
    }
  }

  async function fillNewUserRoleSelect() {
    const roles = await loadRoles();
    const sel = $('nu-role');
    if (!sel) return;
    sel.innerHTML = roles.filter(r => r.key !== 'service')
      .map(r => `<option value="${escHtml(r.key)}">${escHtml(r.label)}</option>`).join('');
  }

  // ---------- вкладка «Роли»: переименование, права, создание, удаление ----------
  function permCheckboxes(role) {
    const dis = role.isSystem ? 'disabled' : '';
    const rows = [
      ['canManageUsers', 'Управлять аккаунтами и ролями'],
      ['canManageActivity', 'Очищать журнал и отменять действия'],
      ['canReadActivity', 'Видеть журнал (чтение)'],
      ['canManageTasks', 'Ставить задания сотрудникам'],
      ['canImportData', 'Импортировать данные (загружать новый файл)'],
      ['canBecomeTtAdmin', 'Становиться админом в учёте времени'],
      ['canAccessWarehouse', 'Доступ к складу (схема, пикинг и т.д.)'],
      ['canEditLayout', 'Изменять схему склада (без права — только просмотр)']
    ];
    return rows.map(([key, label]) => `
      <label>
        <input type="checkbox" data-perm="${key}" ${role.perms[key] ? 'checked' : ''} ${dis}>
        ${label}
      </label>`).join('');
  }

  async function renderRolesList() {
    const listEl = $('roles-list');
    if (!listEl) return;
    listEl.innerHTML = '<div style="padding:10px; color:var(--ink-soft); font-size:12.5px;">Загрузка…</div>';
    try {
      const roles = await loadRoles(true);
      listEl.innerHTML = roles.map(r => `
        <div class="role-card" data-key="${escHtml(r.key)}">
          <div class="role-card-head">
            <input type="text" class="role-label-input" value="${escHtml(r.label)}" title="Название роли">
            <div class="role-card-actions">
              <button type="button" class="icon-btn" data-action="save-label" title="Сохранить название">💾</button>
              ${r.isSystem ? `<span class="role-badge">системная</span>` : `<button type="button" class="icon-btn danger" data-action="delete-role" title="Удалить роль">🗑</button>`}
            </div>
          </div>
          <div class="role-perms-label">Права</div>
          <div class="role-perms-grid">
            ${permCheckboxes(r)}
          </div>
          ${!r.isSystem
            ? `<div class="role-card-footer"><button type="button" class="btn primary" data-action="save-perms">Сохранить права</button></div>`
            : `<div class="role-card-note">Права сервисной роли всегда полные и не редактируются.</div>`
          }
        </div>
      `).join('');

      listEl.querySelectorAll('.role-card').forEach(row => {
        const key = row.dataset.key;
        const labelInput = row.querySelector('.role-label-input');
        row.querySelectorAll('.icon-btn, .btn').forEach(btn => {
          btn.addEventListener('click', async () => {
            const action = btn.dataset.action;
            try {
              if (action === 'save-label') {
                const res = await fetch(`${API_BASE}/api/roles/${encodeURIComponent(key)}`, {
                  method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ label: labelInput.value.trim() })
                });
                const payload = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(payload.error || 'Не удалось переименовать роль');
                if (currentUser && currentUser.role === key) {
                  currentUser.roleLabel = payload.role.label;
                  applyUserToUI();
                }
              } else if (action === 'save-perms') {
                const perms = {};
                row.querySelectorAll('[data-perm]').forEach(cb => { perms[cb.dataset.perm] = cb.checked; });
                const res = await fetch(`${API_BASE}/api/roles/${encodeURIComponent(key)}`, {
                  method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ perms })
                });
                const payload = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(payload.error || 'Не удалось сохранить права');
                if (currentUser && currentUser.role === key) {
                  currentUser.perms = payload.role.perms;
                  applyUserToUI();
                }
              } else if (action === 'delete-role') {
                if (!confirm(`Удалить роль «${labelInput.value}»? Это возможно только если она никому не назначена.`)) return;
                const res = await fetch(`${API_BASE}/api/roles/${encodeURIComponent(key)}`, { method: 'DELETE' });
                const payload = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(payload.error || 'Не удалось удалить роль');
              }
              cachedRoles = [];
              renderRolesList();
              fillNewUserRoleSelect();
            } catch (err) {
              alert(err.message);
            }
          });
        });
      });
    } catch (err) {
      listEl.innerHTML = `<div style="padding:10px; color:var(--danger); font-size:12.5px;">${escHtml(err.message)}</div>`;
    }
  }

  function switchUsersTab(tab) {
    $('users-tab-users').classList.toggle('active', tab === 'users');
    $('users-tab-roles').classList.toggle('active', tab === 'roles');
    $('users-panel-users').style.display = tab === 'users' ? '' : 'none';
    $('users-panel-roles').style.display = tab === 'roles' ? '' : 'none';
    if (tab === 'roles') renderRolesList();
  }

  // ---------- панель «Пользователи и роли» теперь встроена прямо в раздел
  // "Аккаунты" (а не всплывает модалкой) — разметка живёт в index.html
  // статически, здесь только один раз навешиваем обработчики. Загрузка
  // данных — по требованию, когда раздел действительно открыли
  // (см. loadUsersRolesPanel, дёргается из app.js при переходе на "Аккаунты").
  let usersRolesPanelWired = false;
  function wireUsersRolesPanelOnce() {
    if (usersRolesPanelWired) return;
    if (!$('users-tab-users')) return; // раздел ещё не в DOM (не должно случиться, но на всякий случай)
    usersRolesPanelWired = true;

    $('users-tab-users').addEventListener('click', () => switchUsersTab('users'));
    $('users-tab-roles').addEventListener('click', () => switchUsersTab('roles'));
    $('new-role-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = $('nr-error');
      errEl.style.display = 'none';
      const perms = {
        canManageUsers: $('nr-perm-users').checked,
        canManageActivity: $('nr-perm-manage-activity').checked,
        canReadActivity: $('nr-perm-read-activity').checked,
        canManageTasks: $('nr-perm-tasks').checked,
        canImportData: $('nr-perm-import').checked,
        canBecomeTtAdmin: $('nr-perm-tt-admin').checked,
        canAccessWarehouse: $('nr-perm-warehouse').checked,
        canEditLayout: $('nr-perm-edit-layout').checked
      };
      try {
        const res = await fetch(API_BASE + '/api/roles', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: $('nr-key').value.trim(), label: $('nr-label').value.trim(), perms })
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(payload.error || 'Не удалось создать роль');
        $('new-role-form').reset();
        cachedRoles = [];
        renderRolesList();
        fillNewUserRoleSelect();
      } catch (err) {
        errEl.textContent = err.message;
        errEl.style.display = 'block';
      }
    });
    $('new-user-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = $('nu-error');
      errEl.style.display = 'none';
      const body = {
        username: $('nu-username').value.trim(),
        displayName: $('nu-displayname').value.trim(),
        password: $('nu-password').value,
        role: $('nu-role').value
      };
      try {
        const res = await fetch(API_BASE + '/api/users', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(payload.error || 'Не удалось создать аккаунт');
        $('new-user-form').reset();
        renderUsersList();
      } catch (err) {
        errEl.textContent = err.message;
        errEl.style.display = 'block';
      }
    });
  }

  // Вызывается из app.js при каждом открытии раздела "Аккаунты" — обновляет
  // список пользователей и селект ролей (дёшево, можно смело дёргать при
  // каждом заходе на вкладку).
  function loadUsersRolesPanel() {
    wireUsersRolesPanelOnce();
    cachedRoles = [];
    fillNewUserRoleSelect();
    renderUsersList();
    // Если открыта вкладка "Роли" — обновим и её тоже.
    if ($('users-tab-roles') && $('users-tab-roles').classList.contains('active')) renderRolesList();
  }
  window.__loadUsersRolesPanel = loadUsersRolesPanel;

  // Лёгкое обновление списка (для статуса "онлайн") — не трогаем, если
  // прямо сейчас кто-то редактирует логин/имя, чтобы не сбросить ввод.
  function refreshUsersListIfIdle() {
    const listEl = $('users-list');
    if (!listEl || listEl.querySelector('.user-row.editing')) return;
    renderUsersList({ showLoading: false });
  }
  window.__refreshUsersListIfIdle = refreshUsersListIfIdle;

  // Кнопка в профиле теперь просто открывает раздел "Аккаунты" (там всё —
  // и заявки на регистрацию, и управление пользователями/ролями).
  $('pp-manage-users').addEventListener('click', () => {
    closeProfilePage();
    if (window.__activateView) window.__activateView('accounts');
  });

  // ---------- перехват истёкшей/недействительной сессии ----------
  // Если во время работы сессия истекла, любой запрос к /api/* (кроме
  // /api/auth/*) вернёт 401 — в этом случае мягко возвращаем на экран входа,
  // не роняя приложение молча.
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const res = await nativeFetch(input, init);
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (res.status === 401 && url.indexOf('/api/') !== -1 && url.indexOf('/api/auth/') === -1 && currentUser) {
      // currentUser был непустым — значит это не фоновый опрос до входа,
      // а реально истёкшая/недействительная сессия у залогиненного человека.
      currentUser = null;
      window.__whenAuthed = new Promise((resolve) => { resolveAuthed = resolve; });
      showAuthScreen();
    }
    return res;
  };

  // ---------- старт ----------
  (async function initAuth() {
    try {
      const res = await nativeFetch(API_BASE + '/api/auth/me');
      if (res.ok) {
        const payload = await res.json();
        currentUser = payload.user;
        applyUserToUI();
        resolveAuthed(currentUser);
        return;
      }
    } catch (_) {}
    showAuthScreen();
  })();

  // Периодически тихо перечитываем свои права: если админ поменял права
  // роли (например, включил canManageActivity завскладам), это применится
  // в открытой вкладке само, без релогина и без перезагрузки страницы.
  // Раз в 2 минуты и только пока вкладка активна — не нагружает сервер
  // впустую и не мешает основному опросу истёкшей сессии выше (тот же
  // window.fetch перехватит 401, если сессию тем временем завершили).
  const PERMS_REFRESH_MS = 120000;
  setInterval(async () => {
    if (!currentUser || document.hidden) return;
    try {
      const res = await nativeFetch(API_BASE + '/api/auth/me');
      if (res.ok) {
        const payload = await res.json();
        currentUser = payload.user;
        applyUserToUI();
      }
    } catch (_) {}
  }, PERMS_REFRESH_MS);
})();
