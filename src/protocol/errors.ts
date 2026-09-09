// 错误码字典与统一错误类型（真源：docs/webui-development-standard.md §4）。
// 契约冻结：错误 code 集合即协议的一部分。

/** daemon 返回的稳定错误码（§4 字典 + content 面补充）。 */
export const ERROR_CODES = {
  /** 401 —— 未 open / lease 过期，应回 OPENING 重建。 */
  leaseRequired: "lease_required",
  /** 400 —— 我方 bug：envelope 未过本地校验。 */
  invalidEnvelope: "invalid_envelope",
  /** 400 —— command.channel 与 path channel 不一致。 */
  channelMismatch: "channel_mismatch",
  /** 400 —— 非 session_create 命令缺 seed。 */
  missingSeed: "missing_seed",
  /** 409 —— 同 command_id 不同载荷，必然是实现 bug。 */
  duplicateCommandMismatch: "duplicate_command_mismatch",
  /** 422 —— 设计性拒绝（如 conversation_load_more），删调用方代码。 */
  unsupportedCommand: "unsupported_command",
  /** 426 —— RINGING_VERSION 代差，展示"需更新"并停止重试。 */
  unsupportedVersion: "unsupported_version",
  /** Read 方法失败。 */
  queryFailed: "query_failed",
  /** Write 方法失败。 */
  actionFailed: "action_failed",
  /** 403 —— 跨 seed 读取附件。 */
  contentForbidden: "content_forbidden",
  /** 附件 sha256 与 content_id 不符。 */
  attachmentMismatch: "attachment_mismatch",
  /** 404 —— 未知 service 方法。 */
  unknownMethod: "unknown_method",
} as const;

export type KnownErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** 统一运行时错误：保留 HTTP 状态码与 daemon 稳定 code。 */
export class RingingError extends Error {
  readonly status: number;
  /** daemon 稳定错误码；Bearer 错误的 401 无 code（null）。 */
  readonly code: string | null;
  readonly body: unknown;

  constructor(status: number, code: string | null, message: string, body?: unknown) {
    super(message);
    this.name = "RingingError";
    this.status = status;
    this.code = code;
    this.body = body;
  }

  /** 401 lease_required —— 回 OPENING 重建，之后按 epoch 决定增量或全量恢复。 */
  get isLeaseRequired(): boolean {
    return this.status === 401 && this.code === ERROR_CODES.leaseRequired;
  }

  /** 401 无 code —— Bearer token 错误，提示用户，禁止重试循环。 */
  get isTokenInvalid(): boolean {
    return this.status === 401 && this.code === null;
  }

  /** 426 —— 版本代差，停重试，展示"需更新"。 */
  get isUnsupportedVersion(): boolean {
    return this.status === 426 && this.code === ERROR_CODES.unsupportedVersion;
  }

  /** 400 类（invalid_envelope / channel_mismatch / missing_seed）—— 我方 bug，不得原样重发。 */
  get isOwnBug(): boolean {
    return (
      this.status === 400 &&
      (this.code === ERROR_CODES.invalidEnvelope ||
        this.code === ERROR_CODES.channelMismatch ||
        this.code === ERROR_CODES.missingSeed)
    );
  }

  /** 422 unsupported_command —— 设计性拒绝（如 load_more），删调用方代码。 */
  get isUnsupportedCommand(): boolean {
    return this.status === 422 && this.code === ERROR_CODES.unsupportedCommand;
  }
}

/** 把非 2xx Response 转成 RingingError（尽力解析 body.code）。 */
export async function ringingErrorFromResponse(res: Response): Promise<RingingError> {
  let code: string | null = null;
  let body: unknown = null;
  try {
    body = await res.json();
    const candidate = (body as { code?: unknown } | null)?.code;
    if (typeof candidate === "string") code = candidate;
  } catch {
    // body 非 JSON：保持 code=null
  }
  return new RingingError(res.status, code, `qaqh http ${res.status}${code ? ` (${code})` : ""}`, body);
}
