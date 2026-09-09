// 连接配置提供者（docs/webui-development-standard.md §1 provider 抽象）。
// renderer 连接配置必须抽象出 provider：桌面壳模式从宿主 IPC 取；
// 浏览器模式读 window.__QAQH_DEBUG__（同源）；LAN 模式用户输入。

export interface ConnectionConfig {
  /** daemon HTTP/SSE 基址，如 http://127.0.0.1:8712（无尾斜杠）。 */
  endpoint: string;
  /** Bearer token，仅内存持有（N3：禁止写入 URL/日志/持久存储）。 */
  token: string;
}

export interface ConnectionConfigProvider {
  /** shell=桌面壳(IPC)；browser=daemon /debug/ 托管(同源+桥脚本)；lan=用户输入直连。 */
  readonly mode: "shell" | "browser" | "lan";
  getConfig(): ConnectionConfig | Promise<ConnectionConfig>;
}

export function staticProvider(
  config: ConnectionConfig,
  mode: ConnectionConfigProvider["mode"] = "lan",
): ConnectionConfigProvider {
  return { mode, getConfig: () => config };
}

/** 桥脚本注入的形状（daemon /debug/__qaqh_bridge__.js）。 */
export interface QaqhDebugBridge {
  token: string;
  nonce: string;
}

declare global {
  interface Window {
    __QAQH_DEBUG__?: QaqhDebugBridge;
  }
}

/** 浏览器（/debug/ 托管）模式：endpoint=同源，token=window.__QAQH_DEBUG__.token。 */
export function browserProvider(): ConnectionConfigProvider {
  return {
    mode: "browser",
    getConfig: () => {
      const bridge = typeof window !== "undefined" ? window.__QAQH_DEBUG__ : undefined;
      if (!bridge || typeof bridge.token !== "string" || bridge.token.length === 0) {
        throw new Error(
          "browserProvider 需要 window.__QAQH_DEBUG__（仅 daemon /debug/ 托管时由桥脚本注入）",
        );
      }
      return { endpoint: window.location.origin, token: bridge.token };
    },
  };
}

/** 规范化 endpoint：去掉尾斜杠。 */
export function normalizeEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, "");
}
