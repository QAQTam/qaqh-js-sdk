// 连接生命周期状态机（docs/webui-development-standard.md §1）。
// boot → OPENING → READY(leased) → ATTACHED(seed…) ⇄ RECONNECTING

export type ConnState = "idle" | "opening" | "ready" | "reconnecting" | "closed";

/** open 协商成功后的连接级信息。 */
export interface ConnInfo {
  clientSessionId: string;
  serverEpoch: string;
  leaseTtlMs: number;
  renewIntervalMs: number;
}

/** 重建触发原因（§1：401 lease_required / epoch 变化 / 跳号 / reset 帧）。 */
export type ResetReason = "lease_expired" | "epoch_changed" | "stream_gap" | "reset_frame" | "renew_failed";

export interface ResetSignal {
  reason: ResetReason;
  /** gap/reset_frame 时给出具体频道。 */
  channel?: string;
  /** gap/reset_frame/epoch 变化影响到的会话（epoch 变化时为空 = 全量）。 */
  seed?: string;
  /** 当前 server_epoch（重建后可能变化，UI 据此决定增量或全量）。 */
  serverEpoch: string;
}
