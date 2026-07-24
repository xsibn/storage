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

  const ROLE_OPTIONS = [
    { value: 'boss', label: 'Начальник' },
    { value: 'warehouse_manager', label: 'Завсклад' },
    { value: 'employee', label: 'Сотрудник' }
  ];

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

  // ---------- экран входа ----------
  function showAuthScreen() {
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

  // ---------- профиль (виджет в шапке) ----------
  function applyUserToUI() {
    if (!currentUser) return;
    const avatar = $('profile-avatar');
    avatar.textContent = initials(currentUser.displayName || currentUser.username);
    const dot = document.createElement('span');
    dot.className = 'status-dot';
    avatar.appendChild(dot); // textContent write above already cleared any previous dot
    $('profile-name').textContent = currentUser.displayName || currentUser.username;
    $('profile-role').textContent = currentUser.roleLabel;
    $('profile-menu-name').textContent = currentUser.displayName || currentUser.username;
    $('profile-menu-role').textContent = currentUser.roleLabel;
    $('profile-manage-users-btn').style.display = currentUser.perms.canManageUsers ? '' : 'none';

    document.body.classList.toggle('perm-no-read-activity', !currentUser.perms.canReadActivity);
    document.body.classList.toggle('perm-no-manage-activity', !currentUser.perms.canManageActivity);
  }

  $('profile-pill').addEventListener('click', () => {
    $('profile-widget').classList.toggle('open');
  });
  document.addEventListener('click', (e) => {
    const w = $('profile-widget');
    if (w.classList.contains('open') && !w.contains(e.target)) w.classList.remove('open');
  });

  $('profile-logout-btn').addEventListener('click', async () => {
    try { await fetch(API_BASE + '/api/auth/logout', { method: 'POST' }); } catch (_) {}
    location.reload();
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
  $('profile-change-password-btn').addEventListener('click', () => {
    $('profile-widget').classList.remove('open');
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

  // ---------- управление пользователями (сервисный аккаунт / начальник) ----------
  async function loadUsers() {
    const res = await fetch(API_BASE + '/api/users');
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || 'Не удалось загрузить список пользователей');
    return payload.users || [];
  }

  function roleSelectHtml(selected, disabled) {
    return `<select ${disabled ? 'disabled' : ''} class="u-role-select">` +
      ROLE_OPTIONS.map(o => `<option value="${o.value}" ${o.value === selected ? 'selected' : ''}>${o.label}</option>`).join('') +
      `</select>`;
  }

  async function renderUsersList() {
    const listEl = $('users-list');
    if (!listEl) return;
    listEl.innerHTML = '<div style="padding:10px; color:var(--ink-soft); font-size:12.5px;">Загрузка…</div>';
    try {
      const users = await loadUsers();
      if (!users.length) {
        listEl.innerHTML = '<div style="padding:10px; color:var(--ink-soft); font-size:12.5px;">Пока нет ни одного аккаунта.</div>';
        return;
      }
      listEl.innerHTML = users.map(u => {
        const isService = u.role === 'service';
        const isSelf = currentUser && u.id === currentUser.id;
        return `
        <div class="user-row ${u.disabled ? 'disabled' : ''}" data-id="${u.id}">
          <div class="u-info">
            <div class="u-name">${escHtml(u.display_name || u.username)}${isSelf ? ' <span style="color:var(--ink-soft); font-weight:400;">(вы)</span>' : ''}</div>
            <div class="u-login">@${escHtml(u.username)}</div>
          </div>
          ${isService ? `<span class="role-badge" style="background:var(--accent-soft); color:var(--accent); font-size:11px; padding:3px 9px; border-radius:999px;">Сервисный</span>`
            : roleSelectHtml(u.role, false)}
          ${!isService ? `<button type="button" class="icon-btn" data-action="reset-pw" title="Сбросить пароль">🔑</button>` : ''}
          ${!isService ? `<button type="button" class="icon-btn" data-action="toggle-disabled" title="${u.disabled ? 'Разблокировать' : 'Заблокировать'}">${u.disabled ? '✅' : '⛔'}</button>` : ''}
          ${!isService && !isSelf ? `<button type="button" class="icon-btn danger" data-action="delete" title="Удалить">🗑</button>` : ''}
        </div>`;
      }).join('');

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
            try {
              if (action === 'delete') {
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
    } catch (err) {
      listEl.innerHTML = `<div style="padding:10px; color:var(--danger); font-size:12.5px;">${escHtml(err.message)}</div>`;
    }
  }

  function openUsersModal() {
    $('profile-widget').classList.remove('open');
    openAuthModal('Пользователи и роли', `
      <form class="new-user-form" id="new-user-form">
        <input type="text" id="nu-username" placeholder="Логин" required>
        <input type="text" id="nu-displayname" placeholder="Имя (необязательно)">
        <input type="password" id="nu-password" placeholder="Пароль (от 6 символов)" required>
        ${roleSelectHtml('employee', false).replace('class="u-role-select"', 'id="nu-role"')}
        <div id="nu-error" class="full" style="display:none; color:var(--danger); font-size:12px;"></div>
        <button type="submit" class="btn primary full" id="nu-submit">+ Создать аккаунт</button>
      </form>
      <div id="users-list"></div>
    `, `<button class="btn" id="users-close">Закрыть</button>`);
    $('users-close').addEventListener('click', closeAuthModal);
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
    renderUsersList();
  }
  $('profile-manage-users-btn').addEventListener('click', openUsersModal);

  // ---------- перехват истёкшей/недействительной сессии ----------
  // Если во время работы сессия истекла, любой запрос к /api/* (кроме
  // /api/auth/*) вернёт 401 — в этом случае мягко возвращаем на экран входа,
  // не роняя приложение молча.
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const res = await nativeFetch(input, init);
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (res.status === 401 && url.indexOf('/api/') !== -1 && url.indexOf('/api/auth/') === -1) {
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
