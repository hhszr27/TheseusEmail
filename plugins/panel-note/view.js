/**
 * SafetyHelper · 账户信息面板
 *
 * 必须作为「外部脚本」加载：
 * 插件的 CSP 是 `script-src 'self'`（src/main/plugins/protocol.ts），内联 <script> 会被
 * 静默拦截、浏览器控制台只给一条 CSP 警告，表现就是面板永远停在静态的「正在加载账户…」。
 * 2026-10-27 实测踩过这个坑，千万不要把这段代码搬回 HTML 里。
 */
(function () {
  'use strict';

  var content = document.getElementById('content');
  var sub = document.getElementById('sub');
  var toast = document.getElementById('toast');

  // 单次调用超时：主进程无响应时也要给出可见错误，而不是无限 loading。
  var CALL_TIMEOUT_MS = 5000;
  var MAX_ATTEMPTS = 3;
  var RETRY_DELAY_MS = 400;

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var STATUS = {
    active: ['在线', 'ok'],
    online: ['在线', 'ok'],
    idle: ['空闲', 'muted'],
    syncing: ['同步中', 'warn'],
    offline: ['离线', 'muted'],
    first_sync: ['待首次同步', 'muted'],
    error: ['连接错误', 'danger'],
    requires_reauth: ['需要重新授权', 'warn'],
    disabled: ['已禁用', 'muted'],
  };

  var AUTH = {
    ok: '正常',
    oauth: 'OAuth 授权',
    password: '密码',
    none: '未设置',
    expired: '已过期',
    invalid: '无效',
    pending: '待验证',
  };

  var PROVIDER = {
    gmail: '📧',
    google: '📧',
    outlook: '🌐',
    'outlook.com': '🌐',
    office365: '🌐',
    microsoft: '🌐',
    qq: '🐧',
    'qq.com': '🐧',
    foxmail: '🐧',
    '163.com': '📨',
    '126.com': '📨',
    'sina.com': '📨',
    imap: '🗄️',
    custom: '⚙️',
  };

  var AVATAR_COLORS = ['#4c9aff', '#58b982', '#d9a441', '#e07a7a', '#a371f7', '#3fb6c4', '#e6956b'];

  function avatarColor(seed) {
    var text = String(seed || '?');
    var hash = 0;
    for (var i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    return AVATAR_COLORS[hash % AVATAR_COLORS.length];
  }

  function statusBadge(status, enabled) {
    if (enabled === false) return '<span class="badge muted">已禁用</span>';
    var item = STATUS[status] || [esc(status || '未知'), 'muted'];
    return '<span class="badge ' + item[1] + '">' + item[0] + '</span>';
  }

  function providerIcon(preset) {
    if (!preset) return '⚙️';
    return PROVIDER[String(preset).toLowerCase()] || PROVIDER[preset] || '⚙️';
  }

  function field(label, value, mono) {
    if (value === undefined || value === null || value === '') return '';
    return (
      '<div class="row"><span class="k">' + esc(label) + '</span>' +
      '<span class="v' + (mono ? ' mono' : '') + '">' + esc(value) + '</span></div>'
    );
  }

  function serverLine(label, host, port, secure) {
    if (!host) return '';
    var value = host + (port ? ':' + port : '') + (secure ? ' · SSL' : '');
    return field(label, value, true);
  }

  function accountBlock(account) {
    var a = account || {};
    var display = a.displayName || a.email || '未知账户';
    var initial = String(display).trim().charAt(0).toUpperCase() || '?';
    var color = avatarColor(a.email || a.id || display);
    var protocol = (providerIcon(a.providerPreset) + ' ' + (a.protocol || '') +
      (a.providerPreset ? ' · ' + a.providerPreset : '')).trim();

    var head =
      '<div class="account-head">' +
      '<div class="avatar" style="background:' + color + '">' + esc(initial) + '</div>' +
      '<div class="who">' +
      '<div class="name">' + esc(display) + '</div>' +
      '<div class="email"><span>' + esc(a.email) + '</span>' +
      '<button type="button" class="copy" data-email="' + esc(a.email) + '">复制</button></div>' +
      '</div>' +
      '<div>' + statusBadge(a.status, a.enabled) + '</div>' +
      '</div>';

    var meta =
      '<div class="section-title">连接</div>' +
      field('协议', protocol) +
      field('认证状态', AUTH[a.authState] || esc(a.authState)) +
      field('启用', a.enabled === false ? '否' : '是') +
      serverLine('IMAP', a.imapHost, a.imapPort, a.imapSecure) +
      serverLine('SMTP', a.smtpHost, a.smtpPort, a.smtpSecure);

    var stats =
      '<div class="section-title">统计</div>' +
      '<div class="stat-grid">' +
      '<div class="stat"><div class="num">' + esc(a.unreadCount == null ? 0 : a.unreadCount) +
      '</div><div class="lbl">收件箱未读</div></div>' +
      '<div class="stat"><div class="num">' + (a.enabled === false ? '—' : '✓') +
      '</div><div class="lbl">账户状态</div></div>' +
      '</div>';

    return '<div class="account">' + head + meta + stats + '</div>';
  }

  function toastMsg(message) {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(function () { toast.classList.remove('show'); }, 1400);
  }

  function delay() {
    return new Promise(function (resolve) { setTimeout(resolve, RETRY_DELAY_MS); });
  }

  /** 单次能力调用：包一层超时，避免主进程不响应时永久卡在 loading。 */
  function invoke(method, arg) {
    return new Promise(function (resolve, reject) {
      if (!window.mailAPI || typeof window.mailAPI[method] !== 'function') {
        reject(new Error('插件能力未就绪：' + method));
        return;
      }

      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error('调用超时：' + method));
      }, CALL_TIMEOUT_MS);

      var promise;
      try {
        promise = arg === undefined ? window.mailAPI[method]() : window.mailAPI[method](arg);
      } catch (err) {
        settled = true;
        clearTimeout(timer);
        reject(err);
        return;
      }

      Promise.resolve(promise).then(
        function (value) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        function (err) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  /**
   * 带重试的调用：面板 webview 可能在插件/账户尚未就绪时就挂载，
   * 首调会因「握手未完成 / 能力句柄失效」而失败；最多重试 3 次。
   */
  function callApi(method, arg, attempt) {
    var current = attempt || 1;
    return invoke(method, arg)
      .then(function (res) {
        if (res && res.ok) return res;
        if (current >= MAX_ATTEMPTS) return res;
        return delay().then(function () { return callApi(method, arg, current + 1); });
      })
      .catch(function (err) {
        if (current >= MAX_ATTEMPTS) throw err;
        return delay().then(function () { return callApi(method, arg, current + 1); });
      });
  }

  function showError(message, accountId) {
    content.innerHTML =
      '<p class="err">读取失败：' + esc(message) + '</p>' +
      '<p><button type="button" class="retry" id="retry">重试</button></p>';
    var button = document.getElementById('retry');
    if (button) {
      button.addEventListener('click', function () { render(accountId || null); });
    }
  }

  function render(accountId) {
    if (!content) return;
    if (!window.mailAPI) {
      content.innerHTML = '<p class="err">插件能力未就绪（preload 未注入 mailAPI）</p>';
      return;
    }

    applyTheme();
    content.innerHTML = '<p class="hint">正在加载账户…</p>';

    var method = accountId ? 'getAccount' : 'getAccounts';
    callApi(method, accountId || undefined, 1)
      .then(function (res) {
        if (!res || !res.ok) {
          showError((res && res.error) || '未知错误', accountId);
          return;
        }

        var data = res.data;
        if (Array.isArray(data)) {
          if (data.length === 0) {
            if (sub) sub.textContent = '账户信息面板';
            content.innerHTML = '<p class="hint">没有已配置的账户。</p>';
            return;
          }
          if (sub) sub.textContent = '已配置账户（' + data.length + '）';
          content.innerHTML = data.map(accountBlock).join('');
          bindCopy();
          return;
        }

        if (!data) {
          showError('账户数据为空', accountId);
          return;
        }
        if (sub) sub.textContent = data.email || '账户信息面板';
        content.innerHTML = accountBlock(data);
        bindCopy();
      })
      .catch(function (err) {
        showError(err && err.message ? err.message : String(err), accountId);
      });
  }

  function bindCopy() {
    var buttons = content.querySelectorAll('.copy');
    Array.prototype.forEach.call(buttons, function (button) {
      button.addEventListener('click', function () {
        var email = button.getAttribute('data-email') || '';
        if (!email) return;
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(email).then(
            function () { toastMsg('已复制 ' + email); },
            function () { toastMsg('复制失败'); },
          );
        } else {
          toastMsg('当前环境不支持复制');
        }
      });
    });
  }

  /** 跟随宿主明暗主题：每次打开面板都重新取一次，切主题后重开即生效。 */
  function applyTheme() {
    if (!window.mailAPI || !window.mailAPI.getThemeVariables) return;
    Promise.resolve(window.mailAPI.getThemeVariables()).then(function (res) {
      if (!res || !res.ok || !res.data || typeof res.data !== 'object') return;
      var root = document.documentElement;
      Object.keys(res.data).forEach(function (key) {
        root.style.setProperty(key, res.data[key]);
      });
    }).catch(function () {
      // 主题取不到就沿用页面里的默认值，不影响账户信息展示
    });
  }

  if (window.mailAPI && window.mailAPI.onCommand) {
    window.mailAPI.onCommand(function (command) {
      if (command && command.id === 'panel.account') {
        render(command.accountId || null);
      }
    });
  }

  applyTheme();
  // 命令未下发时也要有内容：默认列出已配置账户，失败会自动重试并给出重试按钮。
  render(null);
})();
