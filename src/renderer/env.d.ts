/// <reference types="vite/client" />

import type { MailforgeApi, RecoveryApi } from '../shared/ipc';

declare global {
  interface Window {
    api: MailforgeApi;
    recoveryAPI: RecoveryApi;
  }
}

export {};
