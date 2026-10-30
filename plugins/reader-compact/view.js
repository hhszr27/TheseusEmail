async function render() {
  const subject = document.getElementById('subject');
  const from = document.getElementById('from');
  const body = document.getElementById('body');
  if (!subject || !from || !body) return;

  const result = await window.mailAPI.getCurrentEmail();
  if (!result.ok || !result.data) {
    subject.textContent = '未选择邮件';
    from.textContent = result.error || '';
    return;
  }

  const email = result.data;
  subject.textContent = email.subject;
  from.textContent = email.from
    .map((item) => (item.name ? `${item.name} <${item.address}>` : item.address))
    .join(', ');

  // 正文已由主进程净化，这里只做显示
  body.innerHTML = email.body || '<p class="view-empty">（无正文）</p>';
}

window.mailAPI.onEmailChanged(() => {
  void render();
});

void render();
