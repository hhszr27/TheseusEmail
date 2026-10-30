/** 日历同步 worker 协议（§16.6：每个日历账户独立 worker，与邮件同步隔离）。 */

export interface CalendarWorkerConfig {
  id: string;
  kind: 'caldav' | 'ics';
  url: string;
  username: string;
  password: string;
  ctag: string | null;
  syncToken: string | null;
}

export interface CalendarWorkerEvent {
  href: string;
  etag: string | null;
  deleted: boolean;
  uid: string;
  summary: string;
  startsAt: number;
  endsAt: number;
  allDay: boolean;
  location?: string;
  description?: string;
}

export interface CalendarWriteCommand {
  method: 'PUT' | 'DELETE';
  href: string;
  payload?: string;
  etag?: string;
}

export type CalendarWorkerCommand =
  | {
      id: number;
      type: 'sync';
      config: CalendarWorkerConfig;
      writes: CalendarWriteCommand[];
      windowEnd: number;
    }
  | { id: number; type: 'close' };

export type CalendarWorkerResponse =
  | {
      id: number;
      type: 'synced';
      mode: 'unchanged' | 'incremental' | 'full' | 'ics';
      ctag: string | null;
      syncToken: string | null;
      events: CalendarWorkerEvent[];
      writeFailures: number;
    }
  | { id: number; type: 'error'; message: string };
