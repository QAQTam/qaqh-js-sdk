// fetch + ReadableStream 的 SSE 消费与受监督重连循环。
// N2：禁止 EventSource（无法设置 Authorization / 会话头）——这是架构铁律。
// 消费循环骨架源自 webui 标准 §5 参考实现，扩展：透传 SSE event 名（reset 帧识别用）。

export interface SseMessage {
  /** SSE id 行（Last-Event-ID 游标）。 */
  id: string;
  /** SSE event 行；缺省为 "message"。 */
  event: string;
  /** data 行按规范拼接后的载荷。 */
  data: string;
}

export interface ConsumeOptions {
  url: string;
  headers: Record<string, string>;
  lastEventId?: string;
  onMessage: (msg: SseMessage) => void;
  signal: AbortSignal;
}

/**
 * 消费一条 SSE 流直到 EOF / abort / 网络错误。
 * 返回 "eof" 表示服务端正常关流（应带最新 Last-Event-ID 重连），
 * 返回 "aborted" 表示调用方主动取消；HTTP 非 2xx 直接抛 RingingError。
 */
export async function consumeSse(opts: ConsumeOptions): Promise<"eof" | "aborted"> {
  const headers: Record<string, string> = {
    ...opts.headers,
    Accept: "text/event-stream",
    ...(opts.lastEventId ? { "Last-Event-ID": opts.lastEventId } : {}),
  };
  const resp = await fetch(opts.url, { headers, signal: opts.signal });
  if (!resp.ok || !resp.body) {
    let status = resp.status;
    let bodyText: unknown = null;
    try {
      bodyText = await resp.json();
    } catch {
      // ignore
    }
    const err = new Error(`sse ${status}`);
    (err as Error & { status: number; body: unknown }).status = status;
    (err as Error & { status: number; body: unknown }).body = bodyText;
    throw err;
  }

  const reader = resp.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  let id = "";
  let event = "message";
  let data: string[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return "eof";
      buf += value;
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line === "") {
          // 事件边界
          if (data.length > 0) {
            opts.onMessage({ id, event, data: data.join("\n") });
          }
          id = "";
          event = "message";
          data = [];
        } else if (line.startsWith("id:")) {
          id = line.slice(3).trim();
        } else if (line.startsWith("event:")) {
          event = line.slice(6).trim() || "message";
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).trimStart());
        }
        // 注释行（:…）与其他字段按规范忽略
      }
    }
  } catch (e) {
    if (opts.signal.aborted) return "aborted";
    throw e;
  } finally {
    reader.releaseLock();
  }
}

export interface SseLoopOptions {
  url: string;
  headers: () => Record<string, string>;
  onMessage: (msg: SseMessage) => void;
  /** 非 2xx 且 status===401 时抛给 owner（触发 re-open），不在本层消化。 */
  signal: AbortSignal;
  /** 诊断回调（可选）。 */
  onRetry?: (attempt: number, err: unknown) => void;
  /** 首连携带的 Last-Event-ID（timeline 断点续传 <epoch>:timeline:<seq>）。 */
  initialLastEventId?: string;
  /** 首连失败也重试；指数退避 400ms→8s。 */
  backoffBaseMs?: number;
  backoffCapMs?: number;
}

/**
 * 受监督的 SSE 循环：断流自动重连并回传最新 Last-Event-ID（增量续传）。
 * 401 会向上抛出（RingingError），由客户端统一 re-open 后重启本循环。
 */
export async function runSseLoop(opts: SseLoopOptions): Promise<void> {
  const base = opts.backoffBaseMs ?? 400;
  const cap = opts.backoffCapMs ?? 8_000;
  let attempt = 0;
  let lastEventId: string | undefined = opts.initialLastEventId;
  for (;;) {
    if (opts.signal.aborted) return;
    try {
      const result = await consumeSse({
        url: opts.url,
        headers: opts.headers(),
        lastEventId,
        onMessage: (msg) => {
          if (msg.id) lastEventId = msg.id;
          opts.onMessage(msg);
        },
        signal: opts.signal,
      });
      if (result === "aborted") return;
      // eof：服务端关流，重置退避后立即重连
      attempt = 0;
    } catch (e) {
      if (opts.signal.aborted) return;
      const status = (e as { status?: number }).status;
      if (status === 401) throw e; // lease 过期 → owner 负责 re-open
      attempt += 1;
      opts.onRetry?.(attempt, e);
      const delay = Math.min(cap, base * 2 ** Math.min(attempt, 6));
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, delay);
        opts.signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
      });
    }
  }
}
