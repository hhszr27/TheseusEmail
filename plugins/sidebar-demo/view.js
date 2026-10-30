/**
 * 侧栏示例插件（views['sidebar-item']）。
 *
 * 必须作为「外部脚本」加载：插件 CSP 是 `script-src 'self'`，内联 <script> 会被
 * 静默拦截，页面会永远停在初始 HTML。
 */
(function () {
  'use strict';

  var target = document.getElementById('accounts');

  // 主进程无响应时也要给出可见错误，而不是无限 loading；首调可能握手未完成，重试 3 次。
  var CALL_TIMEOUT_MS = 5000;
  var MAX_ATTEMPTS = 3;
  var RETRY_DELAY_MS = 400;

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function delay() {
    return new Promise(function (resolve) {
      setTimeout(resolve, RETRY_DELAY_MS);
    });
  }

  function invoke(method) {
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

      Promise.resolve(window.mailAPI[method]()).then(
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

  function callApi(method, attempt) {
    var current = attempt || 1;
    return invoke(method)
      .then(function (res) {
        if (res && res.ok) return res;
        if (current >= MAX_ATTEMPTS) return res;
        return delay().then(function () {
          return callApi(method, current + 1);
        });
      })
      .catch(function (err) {
        if (current >= MAX_ATTEMPTS) throw err;
        return delay().then(function () {
          return callApi(method, current + 1);
        });
      });
  }

  function render(accounts) {
    if (!accounts.length) {
      target.className = 'hint';
      target.textContent = '还没有账户（添加账户后这里会列出来）。';
      return;
    }

    target.className = '';
    target.innerHTML = accounts
      .map(function (account) {
        var name = account.displayName || account.email || '未命名账户';
        var email = account.email || '';
        var disabled = account.enabled === false;
        return (
          '<div class="row">' +
          '<span class="name">' + esc(name) + (disabled ? '（已禁用）' : '') + '</span>' +
          '<span class="mail">' + esc(email) + '</span>' +
          '</div>'
        );
      })
      .join('');
  }

  function showError(message) {
    target.className = 'err';
    target.innerHTML =
      '读取失败：' +
      esc(message) +
      ' <button type="button" class="retry" id="retry">重试</button>';

    var button = document.getElementById('retry');
    if (button) {
      button.addEventListener('click', function () {
        target.className = 'hint';
        target.textContent = '正在读取账户…';
        load();
      });
    }
  }

  function load() {
    callApi('getAccounts')
      .then(function (res) {
        if (!res || !res.ok) {
          throw new Error((res && res.error) || '读取账户失败');
        }
        render(res.data || []);
      })
      .catch(function (err) {
        showError(err && err.message ? err.message : String(err));
      });
  }

  load();
})();
