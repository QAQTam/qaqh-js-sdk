// Node 侧扩展（Electron main / CLI）：daemon discovery 读取与生命周期助手。
// 只应在主进程使用 —— renderer 永不直接触碰文件系统（N7）。

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RingingError } from "./protocol/errors.js";

export interface DaemonDiscovery {
  /** 形如 http://127.0.0.1:8712。 */
  endpoint: string;
  token: string;
  pid: number;
  server_epoch: string;
  protocol_version: number;
  daemon_version?: string;
  build_id?: string;
  channel?: string;
  exe_path?: string;
}

/** 全局数据根（Windows: %USERPROFILE%\\.deepx；其余: ~/.config/qaqh；QAQH_DATA_DIR 重定向）。 */
export function dataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env["QAQH_DATA_DIR"];
  if (override && override.length > 0) return override;
  if (process.platform === "win32") {
    return path.join(env["USERPROFILE"] ?? os.homedir(), ".deepx");
  }
  return path.join(os.homedir(), ".config", "qaqh");
}

export function discoveryPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(dataDir(env), "daemon.json");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** 读取并校验 daemon.json（字段契约见 qaqh-types::DaemonDiscovery）。 */
export async function readDiscovery(env: NodeJS.ProcessEnv = process.env): Promise<DaemonDiscovery | null> {
  let raw: string;
  try {
    raw = await readFile(discoveryPath(env), "utf8");
  } catch {
    return null; // ENOENT：daemon 未运行
  }
  const obj: unknown = JSON.parse(raw);
  if (!isRecord(obj)) throw new RingingError(0, "bad_discovery", "daemon.json 不是对象");
  const endpoint = obj["endpoint"];
  const token = obj["token"];
  if (typeof endpoint !== "string" || endpoint.length === 0) {
    throw new RingingError(0, "bad_discovery", "daemon.json 缺少 endpoint");
  }
  if (typeof token !== "string" || token.length === 0) {
    throw new RingingError(0, "bad_discovery", "daemon.json 缺少 token");
  }
  return obj as unknown as DaemonDiscovery;
}

/** 探测进程存活（kill(pid,0)：ESRCH=不存在，EPERM=存在但无权限）。 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface EnsureDaemonOptions {
  /** daemon 可执行文件；缺省不 spawn，仅发现既有实例。 */
  binPath?: string;
  env?: NodeJS.ProcessEnv;
  /** 等待 discovery 写盘的超时（毫秒）。 */
  timeoutMs?: number;
  /** spawn 时附加的 stdio 策略。 */
  detached?: boolean;
}

/**
 * 确保 daemon 可用：已有健康实例（pid 存活）→ 直接复用；
 * 没有 → 若提供 binPath 则 spawn `daemon run` 并轮询 discovery。
 * 返回可用 discovery；超时/不可用抛 RingingError。
 */
export async function ensureDaemon(opts: EnsureDaemonOptions = {}): Promise<DaemonDiscovery> {
  const env = opts.env ?? process.env;
  const existing = await readDiscovery(env);
  if (existing && isPidAlive(existing.pid)) return existing;

  if (!opts.binPath) {
    throw new RingingError(0, "daemon_not_found", `未发现运行中的 daemon（${discoveryPath(env)}），且未提供 binPath`);
  }
  const child = spawn(opts.binPath, ["run"], {
    env: { ...process.env, ...env },
    stdio: "ignore",
    detached: opts.detached ?? false,
  });
  child.unref();
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await new Promise((r) => setTimeout(r, 250));
    const d = await readDiscovery(env);
    if (d && isPidAlive(d.pid)) return d;
    if (Date.now() > deadline) {
      throw new RingingError(0, "daemon_start_timeout", `daemon 在 ${timeoutMs}ms 内未完成 discovery 写盘`);
    }
  }
}

/** 安装器断电协议：200=已安全关闭；409=忙碌（不应再等）。仅限壳进程管理"自己拉起的 daemon"。 */
export async function stopDaemonIfIdle(
  discovery: DaemonDiscovery,
  timeoutMs = 5_000,
): Promise<"stopped" | "busy"> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${discovery.endpoint.replace(/\/+$/, "")}/control/v1/stop-if-idle`, {
      method: "POST",
      headers: { Authorization: `Bearer ${discovery.token}` },
      signal: controller.signal,
    });
    if (res.status === 200) return "stopped";
    if (res.status === 409) return "busy";
    throw new RingingError(res.status, null, `stop-if-idle 返回 ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}
