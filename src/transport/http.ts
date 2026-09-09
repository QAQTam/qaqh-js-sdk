// 统一 fetch 封装：双头注入（Authorization + X-QAQH-Client-Session-Id）、
// 401 拦截回调、超时控制（webui 标准 §2 硬约束）。

import { normalizeEndpoint, type ConnectionConfig, type ConnectionConfigProvider } from "../connection/provider.js";
import { HEADER_CLIENT_SESSION } from "../protocol/version.js";
import { RingingError, ringingErrorFromResponse } from "../protocol/errors.js";

export interface HttpTransportDeps {
  provider: ConnectionConfigProvider;
  /** open 成功后返回 client_session_id；open 之前为 null。 */
  sessionId: () => string | null;
  /** 收到 401 lease_required 时触发（客户端负责回 OPENING 重建）。 */
  onAuthExpired?: (err: RingingError) => void;
  /** 默认超时（毫秒）。SSE 请求不适用。 */
  defaultTimeoutMs?: number;
}

export interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** false = 不带会话头（仅 open 请求）。 */
  withLease?: boolean;
  signal?: AbortSignal;
}

export class HttpTransport {
  private readonly deps: HttpTransportDeps;
  /** 防止 401 回调重入风暴。 */
  private authExpiredFired = false;

  constructor(deps: HttpTransportDeps) {
    this.deps = deps;
  }

  resetAuthFlag(): void {
    this.authExpiredFired = false;
  }

  async resolveConfig(): Promise<{ base: string; token: string }> {
    const cfg: ConnectionConfig = await this.deps.provider.getConfig();
    return { base: normalizeEndpoint(cfg.endpoint), token: cfg.token };
  }

  async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const { base, token } = await this.resolveConfig();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      ...opts.headers,
    };
    const withLease = opts.withLease !== false;
    if (withLease) {
      const sid = this.deps.sessionId();
      if (sid) headers[HEADER_CLIENT_SESSION] = sid;
    }
    const controller = new AbortController();
    const timeoutMs = opts.timeoutMs ?? this.deps.defaultTimeoutMs ?? 15_000;
    const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
    const onOuterAbort = () => controller.abort(opts.signal?.reason);
    opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
    try {
      const res = await fetch(`${base}${path}`, {
        method: opts.method ?? "GET",
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const err = await ringingErrorFromResponse(res);
        if (err.isLeaseRequired && !this.authExpiredFired) {
          this.authExpiredFired = true;
          this.deps.onAuthExpired?.(err);
        }
        throw err;
      }
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onOuterAbort);
    }
  }

  async post<T>(path: string, body?: unknown, opts: Omit<RequestOptions, "method" | "body"> = {}): Promise<T> {
    return this.request<T>(path, { ...opts, method: "POST", body });
  }

  async get<T>(path: string, opts: Omit<RequestOptions, "method"> = {}): Promise<T> {
    return this.request<T>(path, { ...opts, method: "GET" });
  }
}
