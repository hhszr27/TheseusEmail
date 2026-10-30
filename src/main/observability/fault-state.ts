import { FaultRecovery } from './fault-recovery';

/** 进程级故障状态单例，供主窗口/恢复窗口/IPC 共享。 */
export const faultRecovery = new FaultRecovery();
