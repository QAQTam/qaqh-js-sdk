// protocol/types.ts —— SDK 协议类型统一入口（§6 单一来源约定）。
// 全部 re-export 自 bindings/（ts-rs 生成物）；禁止在本文件手写协议类型。
export * from "./bindings/index.js";
