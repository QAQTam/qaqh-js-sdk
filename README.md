# qaqh-js-sdk

QAQ-Harness Ringing V1 协议的 TypeScript SDK。壳无关：Electron / Tauri webview / 浏览器 webUI 共用同一实现。

**规则真源**：`QAQ-Harness/docs/frontend-contract.md`（冻结契约）与 `docs/webui-development-standard.md`（MUST/NEVER 清单）。类型单一来源是 `src/protocol/bindings/`（ts-rs 从 `qaqh-domain` / `qaqh-ringing` / `qaqh-types` 生成，勿手改）。

## 安装

```bash
# 以本地路径依赖接入（monorepo 开发模式）
npm i file:../qaqh-js-sdk
```

## 快速开始（渲染层）

```ts
import { Projection, QaqhClient, browserProvider, staticProvider } from "qaqh-js-sdk";

const provider =
  window.__QAQH_DEBUG__ ? browserProvider()           // daemon /debug/ 托管
  : /* 桌面壳 */ staticProvider(await shell.getConfig(), "shell");

const projection = new Projection();
const client = await QaqhClient.connect({
  provider,
  onBatch: (b) => projection.applyBatch(b),
  onReset: (s) => rebootstrap(s),   // epoch 变化 / 跳号 / reset 帧 → 全量重建
});
```

## 分层

| 层 | 模块 | 职责 |
|---|---|---|
| protocol | `version/errors/service-methods/bindings` | 线协议常量、错误码字典、服务面方法表、ts-rs 类型 |
| connection | `provider/state` | 三模式连接配置、生命周期状态机 |
| transport | `http/sse` | 双头注入 fetch、fetch-SSE 消费 + 重连循环（**禁用 EventSource**，N2） |
| core | `ids/envelope` | 幂等 id、envelope 构造与本地校验 |
| client | `client.ts` | open/续租/命令/服务面/bootstrap/timeline/content 门面 |
| state | `projection.ts` | 事件 → 视图模型唯一写入口（UI 只读快照） |
| node | `node.ts` | **仅主进程**：daemon.json 发现、spawn、stop-if-idle |

## 硬约束（实现已内置，UI 层仍须遵守）

- token 仅内存持有，不入 URL/日志/持久存储（N3）
- 所有命令携带 open 签发的 `client_session_id`（N4）
- 会话生命周期只走三频道 envelope，服务面发会被 404（N5）
- 无 load_more——历史权威是 bootstrap/timeline，翻页用 `timelineSnapshot(seed, { beforeTurn })`（N6）
- `dispatch_failed/timed_out` 按 §4 换 id 重试一次；其余重试必须复用同一 command_id

## 再生 bindings

```bash
# QAQ-Harness 仓库
cargo build -p qaqh-domain -p qaqh-ringing -p qaqh-types --features ts
# 拷贝 bindings/qaqh 与 bindings/serde_json 到 src/protocol/bindings/ 并重建 bindings.ts barrel
```
