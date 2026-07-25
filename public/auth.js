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
    const label = currentUser.displayName || currentUser.username;
    const avatar = $('profile-avatar');
    applyAvatarTo(avatar, label, currentUser.avatarUrl);
    const dot = document.createElement('span');
    dot.className = 'status-dot';
    avatar.appendChild(dot); // textContent write above already cleared any previous dot
    $('profile-name').textContent = label;
    $('profile-role').textContent = currentUser.roleLabel;

    applyAvatarTo($('pp-avatar'), label, currentUser.avatarUrl);
    $('pp-name').textContent = label;
    $('pp-role').textContent = currentUser.roleLabel;
    $('pp-manage-users').style.display = currentUser.perms.canManageUsers ? '' : 'none';
    $('pp-avatar-remove-btn').style.display = currentUser.avatarUrl ? '' : 'none';

    document.body.classList.toggle('perm-no-read-activity', !currentUser.perms.canReadActivity);
    document.body.classList.toggle('perm-no-manage-activity', !currentUser.perms.canManageActivity);
    document.body.classList.toggle('perm-no-manage-tasks', !currentUser.perms.canManageTasks);
    document.body.classList.toggle('perm-no-manage-users', !currentUser.perms.canManageUsers);
    document.body.classList.toggle('perm-no-import-data', !currentUser.perms.canImportData);

    // Для тех, у кого нет прав на управление аккаунтами, раздел показывает
    // только список коллег и их ролей — переименовываем пункт меню, чтобы
    // это было понятно сразу, не открывая его.
    const accountsLabel = currentUser.perms.canManageUsers ? '👥 Аккаунты' : '👥 Сотрудники';
    const bnAccountsLabel = currentUser.perms.canManageUsers ? 'Аккаунты' : 'Сотрудники';
    if ($('nav-accounts-label')) $('nav-accounts-label').textContent = accountsLabel;
    if ($('bn-accounts-label')) $('bn-accounts-label').textContent = bnAccountsLabel;
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
          <div class="u-login">@${escHtml(u.username)}</div>
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
      });
  }

  let usersSearchWired = false;
  function wireUsersSearchOnce() {
    if (usersSearchWired) return;
    const input = $('users-search');
    if (!input) return;
    usersSearchWired = true;
    input.addEventListener('input', () => renderUsersRows(lastUsersFull, lastRoles));
  }

  async function renderUsersList() {
    const listEl = $('users-list');
    if (!listEl) return;
    wireUsersSearchOnce();
    listEl.innerHTML = '<div style="padding:10px; color:var(--ink-soft); font-size:12.5px;">Загрузка…</div>';
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
      ['canImportData', 'Импортировать данные (загружать новый файл)']
    ];
    return rows.map(([key, label]) => `
      <label style="display:flex; align-items:center; gap:6px; font-size:12px; font-weight:400; padding:4px 0;">
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
        <div class="role-row" data-key="${escHtml(r.key)}" style="border-bottom:1px solid var(--line); padding:12px 4px;">
          <div style="display:flex; align-items:center; gap:8px;">
            <input type="text" class="role-label-input" value="${escHtml(r.label)}" style="flex:1; padding:7px 9px; border:1px solid var(--line); border-radius:7px; font-size:13px; background:var(--panel); color:var(--ink);">
            <button type="button" class="icon-btn" data-action="save-label" title="Сохранить название">💾</button>
            ${r.isSystem ? `<span class="role-badge" style="background:var(--accent-soft); color:var(--accent); font-size:10.5px; padding:3px 8px; border-radius:999px;">системная</span>` : ''}
            ${!r.isSystem ? `<button type="button" class="icon-btn danger" data-action="delete-role" title="Удалить роль">🗑</button>` : ''}
          </div>
          <div style="display:flex; gap:16px; flex-wrap:wrap; margin-top:6px;">
            ${permCheckboxes(r)}
          </div>
          ${!r.isSystem ? `<button type="button" class="btn" data-action="save-perms" style="margin-top:6px; font-size:11.5px; padding:6px 10px;">Сохранить права</button>` : `<div style="font-size:11px; color:var(--ink-soft); margin-top:4px;">Права сервисной роли всегда полные и не редактируются.</div>`}
        </div>
      `).join('');

      listEl.querySelectorAll('.role-row').forEach(row => {
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
        canImportData: $('nr-perm-import').checked
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
    renderUsersList();
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
})();
