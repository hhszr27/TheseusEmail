// compose-view 示例：通过能力句柄读写宿主草稿
const subjectEl = document.getElementById('subject');
const recipientsEl = document.getElementById('recipients');
const bodyEl = document.getElementById('body');
const hintEl = document.getElementById('hint');

let latest = null;

function render(draft) {
  latest = draft;
  subjectEl.textContent = draft.subject || '（未填写主题）';
  const to = (draft.to || []).map((item) => item.address).join(', ');
  recipientsEl.textContent = `收件人：${to || '—'}`;
  bodyEl.textContent = draft.body || '（空正文）';
}

async function refresh() {
  const result = await window.mailAPI.getDraftContext();
  if (!result.ok) {
    hintEl.textContent = result.error || '无法读取草稿';
    return;
  }
  render(result.data);
}

async function patch(next) {
  const result = await window.mailAPI.setDraftContent(next);
  hintEl.textContent = result.ok ? '已写回草稿' : result.error || '写回失败';
}

document.getElementById('append').addEventListener('click', () => {
  const body = latest ? latest.body : '';
  void patch({ body: `${body}${body ? '\n' : ''}——来自简洁撰写器` });
});

document.getElementById('sign').addEventListener('click', () => {
  const body = latest ? latest.body : '';
  void patch({ body: `${body}${body ? '\n' : ''}此致\nMailForge 用户` });
});

// 宿主在草稿变化时推送快照，保证写回后能看到最新内容
window.mailAPI.onDraftChanged((draft) => render(draft));

window.mailAPI.onCommand((command) => {
  if (command.id === 'compose.signature') {
    const body = latest ? latest.body : '';
    void patch({ body: `${body}${body ? '\n' : ''}此致\nMailForge 用户` });
  }
});

void refresh();
