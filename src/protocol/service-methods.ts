// 服务面方法表（POST /ringing/v1/service/{method}）。
// 单一权威清单镜像自 qaqh-runtime::ringing::service_methods（Rust 字符串表），
// 改动须对照后端 PR。会话生命周期命令刻意不在表中（N5：只走三频道 envelope）。

export interface ServiceMethodInfo {
  /** Read = 无副作用查询；Write = 变更操作（决定错误码形状）。 */
  kind: "read" | "write";
  /** 要求 params 携带 seed 并做 lease 归属校验（缺 seed → 400）。 */
  requiresSeed: boolean;
}

/** 与后端 lookup() 逐条对齐；未列出的名字 daemon 返回 404 unknown_method。 */
export const SERVICE_METHODS = {
  // daemon / 会话只读
  "daemon.version": { kind: "read", requiresSeed: false },
  "session.list": { kind: "read", requiresSeed: false },
  "session.meta": { kind: "read", requiresSeed: true },
  "session.activity": { kind: "read", requiresSeed: false },
  "session.dashboard": { kind: "read", requiresSeed: true },
  "session.get_activity": { kind: "read", requiresSeed: true },
  // workspace
  "workspace.get": { kind: "read", requiresSeed: true },
  "workspace.status": { kind: "read", requiresSeed: false },
  "workspace.list": { kind: "read", requiresSeed: false },
  "workspace.diagnose": { kind: "read", requiresSeed: false },
  "workspace.set": { kind: "write", requiresSeed: false },
  "workspace.set_mode": { kind: "write", requiresSeed: false },
  "workspace.install_wsl": { kind: "write", requiresSeed: false },
  "workspace.create": { kind: "write", requiresSeed: false },
  "workspace.rename": { kind: "write", requiresSeed: false },
  "workspace.delete": { kind: "write", requiresSeed: false },
  "workspace.move_session": { kind: "write", requiresSeed: false },
  "workspace.detach": { kind: "write", requiresSeed: false },
  // fs
  "fs.list": { kind: "read", requiresSeed: false },
  "fs.read": { kind: "read", requiresSeed: false },
  // config / profile
  "config.load": { kind: "read", requiresSeed: false },
  "config.save": { kind: "write", requiresSeed: false },
  "config.set_permission_level": { kind: "write", requiresSeed: false },
  "profile.apply": { kind: "write", requiresSeed: false },
  "profile.save_current": { kind: "write", requiresSeed: false },
  "profile.delete": { kind: "write", requiresSeed: false },
  // skills
  "skills.list_tools": { kind: "read", requiresSeed: false },
  "skills.operation": { kind: "write", requiresSeed: false },
  "skills.reload": { kind: "write", requiresSeed: false },
  // todo / plan / stats
  "todo.status": { kind: "read", requiresSeed: true },
  "todo.list": { kind: "read", requiresSeed: true },
  "todo.set": { kind: "write", requiresSeed: true },
  "plan.read": { kind: "read", requiresSeed: true },
  "plan.context_stats": { kind: "read", requiresSeed: true },
  "stats.token_usage": { kind: "read", requiresSeed: false },
  // git（只读与变更分列）
  "git.diff": { kind: "read", requiresSeed: true },
  "git.branch": { kind: "read", requiresSeed: true },
  "git.branches": { kind: "read", requiresSeed: true },
  "git.file_diff": { kind: "read", requiresSeed: true },
  "git.switch_branch": { kind: "write", requiresSeed: false },
  "git.commit": { kind: "write", requiresSeed: false },
  // subagent / tool mode
  "subagent.spawn": { kind: "write", requiresSeed: false },
  "session.set_tool_mode": { kind: "write", requiresSeed: false },
} as const satisfies Record<string, ServiceMethodInfo>;

export type ServiceMethod = keyof typeof SERVICE_METHODS;

export function lookupServiceMethod(method: string): ServiceMethodInfo | null {
  return Object.prototype.hasOwnProperty.call(SERVICE_METHODS, method)
    ? ((SERVICE_METHODS as Record<string, ServiceMethodInfo>)[method] ?? null)
    : null;
}
