// QaqhClient —— Ringing V1 客户端门面。
// 职责：open 协商 → lease 续租循环 → 三频道 SSE 订阅（stream_seq 连续性校验）
//       → 命令投递（幂等 id + dispatch_failed 换 id 重试一次）
//       → 服务面 RPC（方法表校验）→ bootstrap/timeline → content 上传下载。
// 铁律：token 仅内存；SSE 只用 fetch 流；UI 永不调用 /control/v1/stop*。

import { browserProvider, normalizeEndpoint, staticProvider, type ConnectionConfig, type ConnectionConfigProvider } from "./connection/provider.js";
import type { ConnInfo, ConnState, ResetReason, ResetSignal } from "./connection/state.js";
import { RingingError, ringingErrorFromResponse } from "./protocol/errors.js";
import { lookupServiceMethod, type ServiceMethod } from "./protocol/service-methods.js";
import { HEADER_CLIENT_SESSION, RINGING_ENDPOINTS, RINGING_SCHEMA, RINGING_VERSION, SSE_RESET_EVENT } from "./protocol/version.js";
import type {
  ClientOpenRequest,
  ClientOpenResponse,
  ContentRef,
  RingingChannel,
  RingingCommand,
  RingingCommandAck,
  RingingCommandEnvelope,
  RingingCommandStatus,
  RingingEventBatch,
  RingingResetRequired,
  RingingSessionBootstrap,
  TimelineSnapshot,
} from "./protocol/types.js";
import { buildCommandEnvelope, validateEnvelopeLocal } from "./core/envelope.js";
import { newClientInstanceId, newCommandId } from "./core/ids.js";
import { HttpTransport } from "./transport/http.js";
import { runSseLoop, type SseMessage } from "./transport/sse.js";

const DEFAULT_CHANNELS: readonly RingingChannel[] = ["control", "conversation", "tool"];

export interface QaqhClientOptions {
  provider: ConnectionConfigProvider;
  /** 缺省自动生成 UUID v4；同一安装应保持稳定。 */
  clientInstanceId?: string;
  /** 订阅的事件频道，缺省三个全订。 */
  channels?: readonly RingingChannel[];
  /** 每 batch 原样上抛（整 batch 传递，禁止逐事件展开后丢失 batch 上下文）。 */
  onBatch?: (batch: RingingEventBatch) => void;
  /** 重建信号：UI 据此 re-bootstrap / 全量恢复。 */
  onReset?: (signal: ResetSignal) => void;
  onState?: (state: ConnState, info?: ConnInfo) => void;
  /** batch 解析失败诊断（协议 bug / 代差）。 */
  onParseError?: (err: unknown, channel: RingingChannel, raw: string) => void;
  requestTimeoutMs?: number;
}

interface RetryOutcome {
  ack?: RingingCommandAck;
  transportErr?: RingingError;
}

/**
 * timeline 分页响应（镜像 qaqh-client::TimelinePage；qaqh-client 未导出 ts-rs，
 * 此处手工镜像，改动须对照后端 PR）。真身快照在 snapshot 字段。
 */
export interface TimelinePage {
  schema: string;
  version: number;
  server_epoch: string;
  seed: string;
  snapshot: TimelineSnapshot;
  has_more: boolean;
  total_turns?: number;
}

export class QaqhClient {
  private readonly opts: QaqhClientOptions;
  private readonly transport: HttpTransport;
  private readonly channels: readonly RingingChannel[];

  private _state: ConnState = "idle";
  private _info: ConnInfo | null = null;
  private readonly clientInstanceId: string;

  private closed = false;
  private reopening = false;
  private renewTimer: ReturnType<typeof setTimeout> | null = null;
  private renewFailures = 0;
  private readonly sseControllers = new Map<RingingChannel, AbortController>();
  /** 每 (epoch, channel) 全局递增游标：batch 连续性校验 + 去重。 */
  private readonly lastStreamSeq = new Map<RingingChannel, number>();
  /** SSE Last-Event-ID 游标（重连续传）。 */
  private readonly lastEventIds = new Map<RingingChannel, string>();

  private constructor(opts: QaqhClientOptions) {
    this.opts = opts;
    this.channels = opts.channels ?? DEFAULT_CHANNELS;
    this.clientInstanceId = opts.clientInstanceId ?? newClientInstanceId();
    this.transport = new HttpTransport({
      provider: opts.provider,
      sessionId: () => this._info?.clientSessionId ?? null,
      onAuthExpired: () => {
        this.scheduleReopen("lease_expired");
      },
      defaultTimeoutMs: opts.requestTimeoutMs,
    });
  }

  // ---------------------------------------------------------------- 生命周期

  static async connect(opts: QaqhClientOptions): Promise<QaqhClient> {
    const client = new QaqhClient(opts);
    await client.open();
    client.startSseLoops();
    return client;
  }

  get state(): ConnState {
    return this._state;
  }

  get info(): ConnInfo | null {
    return this._info;
  }

  get instanceId(): string {
    return this.clientInstanceId;
  }

  private setState(state: ConnState, info?: ConnInfo): void {
    if (info) this._info = info;
    this._state = state;
    this.opts.onState?.(state, this._info ?? undefined);
  }

  private async open(): Promise<void> {
    this.setState(this._info ? "reconnecting" : "opening");
    const req: ClientOpenRequest = {
      schema: RINGING_SCHEMA,
      version: RINGING_VERSION,
      client_instance_id: this.clientInstanceId,
    };
    const res = await this.transport.request<ClientOpenResponse>(RINGING_ENDPOINTS.open, {
      method: "POST",
      body: req,
      withLease: false,
      timeoutMs: this.opts.requestTimeoutMs,
    });
    if (res.schema !== RINGING_SCHEMA || res.version !== RINGING_VERSION || !res.accepted) {
      throw new RingingError(426, "unsupported_version", `open rejected: schema=${res.schema} version=${res.version} accepted=${res.accepted}`, res);
    }
    const prevEpoch = this._info?.serverEpoch;
    this._info = {
      clientSessionId: res.client_session_id,
      serverEpoch: res.server_epoch,
      leaseTtlMs: res.lease_ttl_ms,
      renewIntervalMs: res.renew_interval_ms,
    };
    this.renewFailures = 0;
    this.transport.resetAuthFlag();
    this.setState("ready", this._info);
    if (prevEpoch !== undefined && prevEpoch !== res.server_epoch) {
      // daemon 重启：SSE 游标全部作废，UI 需全量重建
      this.lastEventIds.clear();
      this.lastStreamSeq.clear();
      this.emitReset({ reason: "epoch_changed", serverEpoch: res.server_epoch });
    }
  }

  private startSseLoops(): void {
    if (this.closed) return;
    for (const channel of this.channels) {
      const controller = new AbortController();
      this.sseControllers.set(channel, controller);
      void runSseLoop({
        url: this.sseUrl(channel),
        headers: () => this.sseHeaders(),
        signal: controller.signal,
        onMessage: (msg) => this.onSseMessage(channel, msg),
      }).catch((err: unknown) => {
        this.sseControllers.delete(channel);
        if (this.closed || controller.signal.aborted) return;
        if (err instanceof RingingError && err.status === 401) {
          this.scheduleReopen("lease_expired");
        } else {
          // runSseLoop 对非 401 已内部退避重试；到这里说明异常逃逸，保守重开
          this.scheduleReopen("lease_expired");
        }
      });
    }
  }

  private sseHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    // SSE 头异步解析 provider 会带来竞态，这里要求 provider.getConfig() 同步可用。
    const cfg = this.opts.provider.getConfig();
    if (cfg && typeof (cfg as ConnectionConfig).token === "string") {
      headers.Authorization = `Bearer ${(cfg as ConnectionConfig).token}`;
    }
    const sid = this._info?.clientSessionId;
    if (sid) headers[HEADER_CLIENT_SESSION] = sid;
    return headers;
  }

  private sseUrl(channel: RingingChannel): string {
    // endpoint 解析放 headers 侧会导致 URL 缓存问题；这里用同步 provider 约定。
    const cfg = this.opts.provider.getConfig();
    if (cfg && typeof (cfg as ConnectionConfig).endpoint === "string") {
      return `${normalizeEndpoint((cfg as ConnectionConfig).endpoint)}${RINGING_ENDPOINTS.events(channel)}`;
    }
    throw new Error("sse provider 必须同步返回 endpoint（如需异步，先 await getConfig 再 connect）");
  }

  private onSseMessage(channel: RingingChannel, msg: SseMessage): void {
    if (msg.id) this.lastEventIds.set(channel, msg.id);
    if (msg.event === SSE_RESET_EVENT) {
      let payload: RingingResetRequired | null = null;
      try {
        payload = JSON.parse(msg.data) as RingingResetRequired;
      } catch {
        payload = null;
      }
      this.emitReset({
        reason: "reset_frame",
        channel: payload?.channel ?? channel,
        seed: payload?.seed,
        serverEpoch: this._info?.serverEpoch ?? "",
      });
      return;
    }
    if (!msg.data) return;
    let batch: RingingEventBatch;
    try {
      batch = JSON.parse(msg.data) as RingingEventBatch;
    } catch (err) {
      this.opts.onParseError?.(err, channel, msg.data);
      return;
    }
    const last = this.lastStreamSeq.get(channel);
    // 跳号 = 丢事件 → 触发重建（§3.4）。仍把 batch 上抛（event_id 幂等，UI 可自行取舍）。
    if (last !== undefined && batch.from_stream_seq > last + 1) {
      this.emitReset({ reason: "stream_gap", channel, seed: batch.seed, serverEpoch: batch.server_epoch });
    }
    this.lastStreamSeq.set(channel, Math.max(last ?? -1, batch.to_stream_seq));
    this.opts.onBatch?.(batch);
  }

  private emitReset(signal: ResetSignal): void {
    this.opts.onReset?.(signal);
  }

  // ---------------------------------------------------------------- 重开与续租

  private scheduleReopen(reason: ResetReason): void {
    if (this.closed || this.reopening) return;
    this.reopening = true;
    void this.reopenLoop(reason);
  }

  private async reopenLoop(reason: ResetReason): Promise<void> {
    this.stopSseLoops();
    this.stopRenewTimer();
    let attempt = 0;
    for (;;) {
      if (this.closed) {
        this.reopening = false;
        return;
      }
      try {
        await this.open();
        this.reopening = false;
        this.startSseLoops();
        this.scheduleRenewTick();
        if (reason !== "epoch_changed") {
          // 重连成功；epoch 未变时 UI 可增量续传，epoch 变化已由 open() 发出全量信号
        }
        return;
      } catch (err) {
        if (this.closed) {
          this.reopening = false;
          return;
        }
        if (err instanceof RingingError && err.isTokenInvalid) {
          // token 错误：禁止重试循环（§4），保持 reconnecting 让 UI 提示
          this.reopening = false;
          return;
        }
        attempt += 1;
        const delay = Math.min(8_000, 400 * 2 ** Math.min(attempt, 6));
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  private stopSseLoops(): void {
    for (const controller of this.sseControllers.values()) controller.abort();
    this.sseControllers.clear();
  }

  private scheduleRenewTick(): void {
    this.stopRenewTimer();
    if (this.closed || !this._info) return;
    const interval = Math.max(1_000, this._info.renewIntervalMs);
    this.renewTimer = setTimeout(() => {
      void this.renewTick();
    }, interval);
  }

  private stopRenewTimer(): void {
    if (this.renewTimer !== null) {
      clearTimeout(this.renewTimer);
      this.renewTimer = null;
    }
  }

  private async renewTick(): Promise<void> {
    if (this.closed) return;
    try {
      await this.transport.post(RINGING_ENDPOINTS.leasesRenew);
      this.renewFailures = 0;
    } catch (err) {
      if (this.closed) return;
      if (err instanceof RingingError && err.status === 401) {
        return; // onAuthExpired 已触发 scheduleReopen
      }
      this.renewFailures += 1;
      if (this.renewFailures >= 2) {
        this.scheduleReopen("renew_failed");
        return;
      }
    } finally {
      if (!this.closed && !this.reopening) this.scheduleRenewTick();
    }
  }

  // ---------------------------------------------------------------- 命令投递

  /**
   * 发送频道命令。重试语义：
   * - ack 只有 accepted/rejected；业务终态以 causation_id=command_id 的可靠事件为准；
   * - HTTP 502/504（dispatch_failed/timed_out）→ 按 §4 换 id 重试一次，再败上抛；
   * - 其余网络失败的调用方重试必须复用同一 commandId（fingerprint 幂等）。
   */
  async sendCommand(
    channel: RingingChannel,
    command: RingingCommand,
    opts: { seed?: string; expectedRevision?: number; commandId?: string } = {},
  ): Promise<RingingCommandAck> {
    if (!this._info) throw new RingingError(0, "not_opened", "client 未完成 open 协商（N4：命令必须携带 open 签发的 client_session_id）");
    const attempt = async (commandId: string): Promise<RetryOutcome> => {
      const envelope: RingingCommandEnvelope = buildCommandEnvelope(channel, command, {
        clientInstanceId: this.clientInstanceId,
        clientSessionId: this._info!.clientSessionId,
        seed: opts.seed ?? null,
        expectedRevision: opts.expectedRevision,
        commandId,
      });
      const errors = validateEnvelopeLocal(envelope);
      if (errors.length > 0) {
        throw new RingingError(400, "invalid_envelope", `本地校验失败: ${errors.join("; ")}`, errors);
      }
      try {
        const ack = await this.transport.post<RingingCommandAck>(RINGING_ENDPOINTS.commands(channel), envelope);
        return { ack };
      } catch (err) {
        if (err instanceof RingingError && (err.status === 502 || err.status === 504)) {
          return { transportErr: err };
        }
        throw err;
      }
    };

    const firstId = opts.commandId ?? newCommandId();
    const first = await attempt(firstId);
    if (first.ack) return first.ack;
    // §4：dispatch_failed 可换 id 重试一次
    const second = await attempt(newCommandId());
    if (second.ack) return second.ack;
    throw second.transportErr ?? first.transportErr ?? new RingingError(502, "dispatch_failed", "command dispatch failed");
  }

  async commandStatus(commandId: string): Promise<RingingCommandStatus> {
    return this.transport.get<RingingCommandStatus>(RINGING_ENDPOINTS.commandStatus(commandId));
  }

  // ---------------------------------------------------------------- 服务面 RPC

  /** POST /ringing/v1/service/{method}。params 若带 seed 会做 lease 归属校验。 */
  async service<T = unknown>(method: ServiceMethod, params?: Record<string, unknown>): Promise<T> {
    const meta = lookupServiceMethod(method);
    if (!meta) throw new RingingError(404, "unknown_method", `未知服务方法: ${method}`);
    const seed = params?.["seed"];
    if (meta.requiresSeed && (typeof seed !== "string" || seed.length === 0)) {
      throw new RingingError(400, "missing_seed", `方法 ${method} 必须携带 seed`);
    }
    return this.transport.post<T>(RINGING_ENDPOINTS.service(method), params ?? {});
  }

  // ---------------------------------------------------------------- 恢复面

  async bootstrap(seed: string): Promise<RingingSessionBootstrap> {
    const res = await this.transport.get<RingingSessionBootstrap>(RINGING_ENDPOINTS.bootstrap(seed));
    return res;
  }

  /**
   * 将 seed 附着到当前 lease —— timeline / bootstrap 读取的前置条件
   * （服务端校验 lease 归属，未附着返回 401 lease_required "attach the session seed"）。
   * 等价 control 频道 session_resume 命令；session_create 之后也需要先 attach 再读。
   */
  async attachSession(seed: string): Promise<RingingCommandAck> {
    return this.sendCommand("control", { channel: "control", type: "session_resume", seed }, { seed });
  }

  /** timeline 快照分页（向上翻页用 beforeTurn；bootstrap 已给全量历史）。 */
  async timelineSnapshot(seed: string, opts: { beforeTurn?: string; limit?: number } = {}): Promise<TimelinePage> {
    const q = new URLSearchParams();
    if (opts.beforeTurn !== undefined) q.set("before_turn", String(opts.beforeTurn));
    if (opts.limit !== undefined) q.set("limit", String(opts.limit));
    const qs = q.toString();
    return this.transport.get<TimelinePage>(`${RINGING_ENDPOINTS.timeline(seed)}${qs ? `?${qs}` : ""}`);
  }

  /** 订阅 per-session timeline SSE（Last-Event-ID 格式 <epoch>:timeline:<seq>）。 */
  subscribeTimeline(
    seed: string,
    onMessage: (msg: SseMessage) => void,
    opts: { lastSeq?: number; signal?: AbortSignal } = {},
  ): AbortController {
    const controller = new AbortController();
    const initialLastEventId =
      opts.lastSeq !== undefined && this._info
        ? `${this._info.serverEpoch}:timeline:${opts.lastSeq}`
        : undefined;
    void runSseLoop({
      url: this.timelineEventsUrl(seed),
      headers: () => this.sseHeaders(),
      signal: opts.signal ?? controller.signal,
      initialLastEventId,
      onMessage,
    }).catch(() => undefined);
    return controller;
  }

  private timelineEventsUrl(seed: string): string {
    const cfg = this.opts.provider.getConfig() as ConnectionConfig;
    return `${normalizeEndpoint(cfg.endpoint)}${RINGING_ENDPOINTS.timelineEvents(seed)}`;
  }

  // ---------------------------------------------------------------- 附件 content

  async uploadContent(
    seed: string,
    content: Blob,
    mediaType: string,
    filename?: string,
  ): Promise<ContentRef & { truncated?: boolean }> {
    const cfg = (await this.transport.resolveConfig()) as { base: string; token: string };
    const sid = this._info?.clientSessionId;
    const headers: Record<string, string> = { Authorization: `Bearer ${cfg.token}` };
    if (sid) headers[HEADER_CLIENT_SESSION] = sid;
    const form = new FormData();
    form.append("seed", seed);
    form.append("media_type", mediaType);
    form.append("content", content, filename);
    const res = await fetch(`${cfg.base}${RINGING_ENDPOINTS.content}`, { method: "POST", headers, body: form });
    if (!res.ok) throw await ringingErrorFromResponse(res);
    return (await res.json()) as ContentRef & { truncated?: boolean };
  }

  async downloadContent(contentId: string, seed: string): Promise<Blob> {
    const cfg = await this.transport.resolveConfig();
    const sid = this._info?.clientSessionId;
    const headers: Record<string, string> = { Authorization: `Bearer ${cfg.token}` };
    if (sid) headers[HEADER_CLIENT_SESSION] = sid;
    const res = await fetch(`${cfg.base}${RINGING_ENDPOINTS.contentById(contentId, seed)}`, { headers });
    if (!res.ok) throw await ringingErrorFromResponse(res);
    return res.blob();
  }

  // ---------------------------------------------------------------- 关闭

  /** 关闭客户端（幂等）。页面卸载无需调用 /control/v1/stop*（安装器专用，UI 不得调用）。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopRenewTimer();
    this.stopSseLoops();
    this.setState("closed");
  }

  /** 便捷：三模式 provider 快捷入口。 */
  static providers = { staticProvider, browserProvider };
}
