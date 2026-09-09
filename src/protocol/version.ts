// Ringing V1 线协议常量（真源：docs/frontend-contract.md + qaqh-ringing）。
// 改动须对照后端 PR —— 契约冻结项：schema/version、会话头名称、端点集。
export const RINGING_SCHEMA = "qaqh.Ringing";
export const RINGING_VERSION = 1;

/** 所有请求必须携带的会话头（名称冻结，§1 契约表）。 */
export const HEADER_CLIENT_SESSION = "X-QAQH-Client-Session-Id";

/** 业务面 / timeline 面共用前缀。 */
export const RINGING_BASE_PATH = "/ringing/v1";

/** timeline SSE 断点续传的 Last-Event-ID 前缀格式：<epoch>:timeline:<seq>。 */
export const CONTROL_PROTOCOL_STOP = "/control/v1/stop";
export const CONTROL_PROTOCOL_STOP_IF_IDLE = "/control/v1/stop-if-idle";

export const RINGING_ENDPOINTS = {
  open: `${RINGING_BASE_PATH}/clients/open`,
  leasesRenew: `${RINGING_BASE_PATH}/leases/renew`,
  commands: (channel: string) => `${RINGING_BASE_PATH}/commands/${channel}`,
  commandStatus: (commandId: string) =>
    `${RINGING_BASE_PATH}/commands/${encodeURIComponent(commandId)}`,
  events: (channel: string) => `${RINGING_BASE_PATH}/events/${channel}`,
  bootstrap: (seed: string) =>
    `${RINGING_BASE_PATH}/sessions/${encodeURIComponent(seed)}/bootstrap`,
  timeline: (seed: string) =>
    `${RINGING_BASE_PATH}/sessions/${encodeURIComponent(seed)}/timeline`,
  timelineEvents: (seed: string) =>
    `${RINGING_BASE_PATH}/sessions/${encodeURIComponent(seed)}/timeline/events`,
  service: (method: string) =>
    `${RINGING_BASE_PATH}/service/${encodeURIComponent(method)}`,
  content: `${RINGING_BASE_PATH}/content`,
  contentById: (contentId: string, seed: string) =>
    `${RINGING_BASE_PATH}/content/${encodeURIComponent(contentId)}?seed=${encodeURIComponent(seed)}`,
} as const;

/** SSE 重置帧的事件名（payload 为 RingingResetRequired）。 */
export const SSE_RESET_EVENT = "ringing.reset_required";
