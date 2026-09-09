// 幂等 id：command_id 用 UUID v4；同一逻辑命令重试必须复用同一 id
// （daemon 按 fingerprint 幂等，换 id = 可能重复执行，§2 MUST）。

export function newCommandId(): string {
  return crypto.randomUUID();
}

export function newClientInstanceId(): string {
  return crypto.randomUUID();
}

/**
 * 逻辑命令 → command_id 的复用账本。
 * UI 层对同一逻辑操作（如"发送这条消息"）重试时应传同一 logicalKey。
 * TTL 过期后回收（防泄漏；TTL 内的重复 key 得到同一 id）。
 */
export class CommandIdTracker {
  private entries = new Map<string, { id: string; expiresAt: number }>();

  idFor(logicalKey: string, ttlMs = 5 * 60_000): string {
    const now = Date.now();
    const hit = this.entries.get(logicalKey);
    if (hit && hit.expiresAt > now) return hit.id;
    const id = newCommandId();
    this.entries.set(logicalKey, { id, expiresAt: now + ttlMs });
    return id;
  }

  clear(): void {
    this.entries.clear();
  }
}
