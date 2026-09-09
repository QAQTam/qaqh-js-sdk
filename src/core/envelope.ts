// 命令 envelope 构造与本地校验（webui 标准 §3.2：不过校验不发，快速失败）。

import { RINGING_SCHEMA, RINGING_VERSION } from "../protocol/version.js";
import type { RingingChannel, RingingCommand, RingingCommandEnvelope } from "../protocol/types.js";
import { newCommandId } from "./ids.js";

export interface EnvelopeContext {
  clientInstanceId: string;
  clientSessionId: string;
  seed?: string | null;
  expectedRevision?: number;
  /** 缺省自动生成 UUID v4；重试场景必须显式传入同一 id。 */
  commandId?: string;
}

export function buildCommandEnvelope(
  channel: RingingChannel,
  command: RingingCommand,
  ctx: EnvelopeContext,
): RingingCommandEnvelope {
  return {
    schema: RINGING_SCHEMA,
    version: RINGING_VERSION,
    channel,
    command_id: ctx.commandId ?? newCommandId(),
    client_instance_id: ctx.clientInstanceId,
    client_session_id: ctx.clientSessionId,
    seed: ctx.seed ?? null,
    expected_revision: ctx.expectedRevision,
    command,
  };
}

/** 命令是否允许缺 seed（仅 control 频道的 session_create）。 */
function seedOptional(command: RingingCommand): boolean {
  return command.channel === "control" && command.type === "session_create";
}

/**
 * 发送前本地校验（§3.2 规则）。返回错误列表；非空则禁止发送。
 * 规则：schema/version 匹配；command.channel === 信封 channel；
 * command_id / client_instance_id / client_session_id 非空；
 * 除 session_create 外必须带 seed。
 */
export function validateEnvelopeLocal(env: RingingCommandEnvelope): string[] {
  const errors: string[] = [];
  if (env.schema !== RINGING_SCHEMA) errors.push(`schema mismatch: ${env.schema}`);
  if (env.version !== RINGING_VERSION) errors.push(`version mismatch: ${env.version}`);
  if (env.command.channel !== env.channel) {
    errors.push(`channel mismatch: envelope=${env.channel} command=${env.command.channel}`);
  }
  if (!env.command_id) errors.push("missing command_id");
  if (!env.client_instance_id) errors.push("missing client_instance_id");
  if (!env.client_session_id) errors.push("missing client_session_id");
  if (!env.seed && !seedOptional(env.command)) {
    errors.push(`missing seed for ${env.channel}/${env.command.type}`);
  }
  return errors;
}
