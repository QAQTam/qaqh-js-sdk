// 状态投影：SSE batch / bootstrap / timeline 快照 → 视图模型的唯一写入口。
// 单向流（§6）：UI 只读 snapshot，绝不直接改缓存；历史权威是 timeline，
// 频道事件只做"未密封轮次"的实时增量。

import type {
  ConversationEvent,
  ContentRef,
  TimelineBlock,
  TimelineFailure,
  TimelineSnapshot,
  TimelineTurn,
  TimelineTurnState,
  ToolEvent,
  ToolResult,
  ControlEvent,
  RingingEventBatch,
  SessionState,
  ActivityState,
} from "../protocol/types.js";

export interface RoundView {
  roundNum: number;
  isFinal: boolean;
  sealed: boolean;
  thinking?: string | null;
  answer?: string | null;
  outputRef?: ContentRef | null;
  /** round_completed 到来前的流式缓冲（kind → 累积文本）。 */
  streaming: { thinking: string; answer: string };
  blocks: TimelineBlock[];
}

export interface TurnView {
  turnId: string;
  createdSeq: number;
  userText: string;
  sealed: boolean;
  state: TimelineTurnState | "running";
  failure?: TimelineFailure | null;
  usage?: { total: number; input: number; output: number } | null;
  rounds: RoundView[];
}

export interface ToolPermissionRequest {
  toolCallId: string;
  toolName: string;
  reason: string;
  paths: string[];
  category: string;
  level: number;
  risk: string;
  consequence: string;
}

export interface ToolCallView {
  toolCallId: string;
  turnId: string;
  roundNum: number;
  name: string;
  argsSoFar: string;
  status: "prepared" | "running" | "finished";
  result?: ToolResult;
  permission?: ToolPermissionRequest;
}

export interface NoticeView {
  ts: number;
  level?: string;
  text: string;
}

export interface SessionView {
  seed: string;
  title?: string | null;
  sessionState?: SessionState;
  activity?: ActivityState;
  turns: TurnView[];
  tools: ToolCallView[];
  /** 等待 UI 审批的工具调用（tool_permission_requested → tool_finished/respond 清除）。 */
  pendingPermissions: ToolCallView[];
  notices: NoticeView[];
}

export interface ProjectionSnapshot {
  revision: number;
  sessions: ReadonlyMap<string, SessionView>;
}

function roundKey(n: number): string {
  return `r${n}`;
}

function parseTurnSeqFallback(turnId: string): number {
  const m = /(\d+)$/.exec(turnId);
  return m ? Number(m[1]) : 0;
}

function turnFromTimeline(t: TimelineTurn): TurnView {
  return {
    turnId: t.turn_id,
    createdSeq: t.created_seq,
    userText: t.user_text,
    sealed: t.sealed,
    state: t.state,
    failure: t.failure ?? null,
    usage: null,
    rounds: t.rounds.map((r) => ({
      roundNum: r.round_num,
      isFinal: r.is_final,
      sealed: r.sealed,
      streaming: { thinking: "", answer: "" },
      blocks: r.blocks,
      thinking: undefined,
      answer: undefined,
      outputRef: undefined,
    })),
  };
}

export class Projection {
  private data = new Map<string, SessionView>();
  private rev = 0;
  private snap: ProjectionSnapshot = { revision: 0, sessions: new Map() };
  private listeners = new Set<() => void>();

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): ProjectionSnapshot => this.snap;

  private session(seed: string): SessionView {
    let s = this.data.get(seed);
    if (!s) {
      s = { seed, turns: [], tools: [], pendingPermissions: [], notices: [] };
      this.data.set(seed, s);
    }
    return s;
  }

  private touch(): void {
    this.rev += 1;
    this.snap = { revision: this.rev, sessions: new Map(this.data) };
    for (const fn of this.listeners) fn();
  }

  // -------------------------------------------------------------- 恢复面

  /** timeline 快照是 transcript 权威：整体替换该 seed 的轮次。 */
  hydrateTimeline(seed: string, snap: TimelineSnapshot): void {
    const s = this.session(seed);
    const turns = snap.turns.map(turnFromTimeline);
    turns.sort((a, b) =>
      a.createdSeq !== b.createdSeq || a.createdSeq !== 0
        ? a.createdSeq - b.createdSeq
        : parseTurnSeqFallback(a.turnId) - parseTurnSeqFallback(b.turnId),
    );
    s.turns = turns;
    // 权威快照落地后，运行中轮次的流式缓冲以快照为准清空重置
    this.touch();
  }

  /** bootstrap 三频道快照：M1 阶段仅记录（state 为 JsonValue，强类型由后端投影注入）。 */
  hydrateBootstrap(seed: string): void {
    this.session(seed);
    this.touch();
  }

  // -------------------------------------------------------------- 实时事件

  applyBatch(batch: RingingEventBatch): void {
    let dirty = false;
    for (const env of batch.envelopes) {
      const ev = env.event;
      if (ev.channel === "conversation") {
        this.applyConversation(batch.seed, ev as ConversationEvent);
        dirty = true;
      } else if (ev.channel === "tool") {
        this.applyTool(batch.seed, ev as ToolEvent);
        dirty = true;
      } else if (ev.channel === "control") {
        dirty = this.applyControl(ev as ControlEvent) || dirty;
      }
    }
    if (dirty) this.touch();
  }

  private round(turn: TurnView, roundNum: number): RoundView {
    let r = turn.rounds.find((x) => x.roundNum === roundNum);
    if (!r) {
      r = {
        roundNum,
        isFinal: false,
        sealed: false,
        streaming: { thinking: "", answer: "" },
        blocks: [],
      };
      turn.rounds.push(r);
      turn.rounds.sort((a, b) => a.roundNum - b.roundNum);
    }
    return r;
  }

  private applyConversation(seed: string, ev: ConversationEvent): void {
    const s = this.session(seed);
    switch (ev.type) {
      case "turn_started": {
        if (!s.turns.some((t) => t.turnId === ev.turn_id)) {
          s.turns.push({
            turnId: ev.turn_id,
            createdSeq: 0,
            userText: ev.user_text,
            sealed: false,
            state: "running",
            failure: null,
            usage: null,
            rounds: [],
          });
        }
        break;
      }
      case "round_delta": {
        const turn = s.turns.find((t) => t.turnId === ev.turn_id);
        if (!turn) break;
        const r = this.round(turn, ev.round_num);
        if (ev.kind === "thinking") r.streaming.thinking += ev.delta;
        else if (ev.kind === "answering") r.streaming.answer += ev.delta;
        // kind === "tool_calling"：工具流由 tool 频道事件承载，此处不累积
        break;
      }
      case "round_completed": {
        const turn = s.turns.find((t) => t.turnId === ev.turn_id);
        if (!turn) break;
        const r = this.round(turn, ev.round_num);
        r.thinking = ev.thinking ?? (r.streaming.thinking || undefined);
        r.answer = ev.answer ?? (r.streaming.answer || undefined);
        r.outputRef = ev.output_ref ?? null;
        r.isFinal = ev.is_final;
        r.streaming = { thinking: "", answer: "" };
        break;
      }
      case "turn_completed": {
        const turn = s.turns.find((t) => t.turnId === ev.turn_id);
        if (turn) {
          turn.state = "completed";
          turn.sealed = true;
          if (ev.usage) {
            turn.usage = {
              total: ev.usage.total_tokens,
              input: ev.usage.prompt_tokens,
              output: ev.usage.completion_tokens,
            };
          }
        }
        break;
      }
      case "turn_failed": {
        const turn = s.turns.find((t) => t.turnId === ev.turn_id);
        if (turn) {
          turn.state = "failed";
          turn.failure = { code: ev.error.code, message: ev.error.message };
        }
        break;
      }
      case "conversation_cancelled": {
        const running = [...s.turns].reverse().find((t) => t.state === "running");
        if (running) {
          running.state = "cancelled";
          running.sealed = true;
        }
        s.notices.push({ ts: Date.now(), text: "回合已取消" });
        break;
      }
      case "provider_retrying": {
        s.notices.push({
          ts: Date.now(),
          text: `provider 重试 ${ev.attempt}/${ev.max_retries}（${ev.delay_secs}s 后）：${ev.error_message}`,
        });
        break;
      }
      case "compact_started": {
        s.notices.push({ ts: Date.now(), text: `上下文压缩开始（共 ${ev.turns_total} 轮，保留 ${ev.turns_keeping} 轮）` });
        break;
      }
      case "compact_finished": {
        s.notices.push({ ts: Date.now(), text: `上下文压缩完成：${ev.status}` });
        break;
      }
      default:
        break;
    }
  }

  private applyTool(seed: string, ev: ToolEvent): void {
    const s = this.session(seed);
    const find = (toolCallId: string) => s.tools.find((t) => t.toolCallId === toolCallId);
    switch (ev.type) {
      case "tool_call_prepared": {
        s.tools.push({
          toolCallId: ev.tool_call_id,
          turnId: ev.turn_id,
          roundNum: ev.round_num,
          name: ev.name,
          argsSoFar: ev.args_so_far,
          status: "prepared",
        });
        break;
      }
      case "tool_started": {
        const t = find(ev.tool_call_id);
        if (t) t.status = "running";
        else {
          s.tools.push({
            toolCallId: ev.tool_call_id,
            turnId: ev.turn_id,
            roundNum: ev.round_num,
            name: ev.name,
            argsSoFar: "",
            status: "running",
          });
        }
        break;
      }
      case "tool_permission_requested": {
        let t = find(ev.tool_call_id);
        if (!t) {
          t = {
            toolCallId: ev.tool_call_id,
            turnId: ev.turn_id,
            roundNum: ev.round_num,
            name: ev.tool_name,
            argsSoFar: "",
            status: "prepared",
          };
          s.tools.push(t);
        }
        t.permission = {
          toolCallId: ev.tool_call_id,
          toolName: ev.tool_name,
          reason: ev.reason,
          paths: ev.paths,
          category: ev.category,
          level: ev.level,
          risk: ev.risk,
          consequence: ev.consequence,
        };
        if (!s.pendingPermissions.some((p) => p.toolCallId === ev.tool_call_id)) {
          s.pendingPermissions.push(t);
        }
        break;
      }
      case "tool_finished": {
        const t = find(ev.tool_call_id);
        if (t) {
          t.status = "finished";
          t.result = ev.result;
        }
        s.pendingPermissions = s.pendingPermissions.filter((p) => p.toolCallId !== ev.tool_call_id);
        break;
      }
      case "tool_notice": {
        s.notices.push({ ts: Date.now(), level: ev.level, text: ev.message });
        break;
      }
      case "audit_recorded": {
        s.notices.push({
          ts: Date.now(),
          text: `审计 ${ev.tool_name}：${ev.result_summary}（${ev.success ? "成功" : "失败"}）`,
        });
        break;
      }
      case "code_changed": {
        s.notices.push({
          ts: Date.now(),
          text: `代码变更 +${ev.lines_added}/-${ev.lines_removed}${ev.file ? `（${ev.file}）` : ""}`,
        });
        break;
      }
      default:
        break;
    }
  }

  /** control 频道：多数为全局事件；返回是否产生了会话级变化。 */
  private applyControl(ev: ControlEvent): boolean {
    // ControlEvent 联合里保留了一个裸 number 占位变体（保留扩展位），非对象直接忽略
    if (typeof ev !== "object" || !("type" in ev)) return false;
    switch (ev.type) {
      case "session_meta_changed": {
        const s = this.session(ev.seed);
        s.title = ev.title ?? null;
        return true;
      }
      case "session_state_changed": {
        const s = this.session(ev.seed);
        s.sessionState = ev.state;
        return true;
      }
      case "session_activity_changed": {
        const s = this.session(ev.seed);
        s.activity = ev.state;
        return true;
      }
      case "system_notice": {
        for (const s of this.data.values()) s.notices.push({ ts: Date.now(), level: ev.level, text: ev.message });
        return true;
      }
      default:
        return false;
    }
  }
}
