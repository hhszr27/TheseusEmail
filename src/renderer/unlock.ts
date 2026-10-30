interface UnlockApi {
  submit(password: string): Promise<{ ok: boolean; message?: string }>;
  cancel(): Promise<void>;
}

interface Window {
  unlockApi: UnlockApi;
}

const form = document.getElementById('form') as HTMLFormElement | null;
const input = document.getElementById('password') as HTMLInputElement | null;
const errorBox = document.getElementById('error') as HTMLDivElement | null;
const submit = document.getElementById('submit') as HTMLButtonElement | null;
const cancel = document.getElementById('cancel') as HTMLButtonElement | null;

async function attempt(): Promise<void> {
  if (!input || !errorBox || !submit) return;
  const password = input.value;
  if (!password) {
    errorBox.textContent = '请输入主密码。';
    return;
  }

  submit.disabled = true;
  errorBox.textContent = '';
  try {
    const result = await window.unlockApi.submit(password);
    if (!result.ok) {
      errorBox.textContent = result.message ?? '主密码不正确。';
      input.select();
    }
  } catch {
    errorBox.textContent = '解锁失败，请重试。';
  } finally {
    submit.disabled = false;
  }
}

form?.addEventListener('submit', (event) => {
  event.preventDefault();
  void attempt();
});

cancel?.addEventListener('click', () => {
  void window.unlockApi.cancel();
});
