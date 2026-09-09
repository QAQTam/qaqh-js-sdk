// SDK 端到端冒烟测试：对真实 daemon 验证 open/lease/SSE/命令/服务面/timeline/附件。
// 用法：QAQH_DATA_DIR=/tmp/qaqh-smoke node examples/smoke.mjs
// （daemon 需已以同一 QAQH_DATA_DIR 启动；脚本结束时调用 stop-if-idle 优雅关闭）

import { QaqhClient, staticProvider } from "../dist/index.js";
import { readDiscovery, stopDaemonIfIdle } from "../dist/node.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (s) => (typeof s === "string" ? s.slice(0, 10) : s);

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const discovery = await readDiscovery();
if (!discovery) {
  console.error("未找到 daemon.json —— 请先以相同 QAQH_DATA_DIR 启动 daemon");
  process.exit(1);
}
console.log(`discovery: endpoint=${discovery.endpoint} pid=${discovery.pid} epoch=${short(discovery.server_epoch)}`);

let batches = 0;
let resets = [];
const seedsSeen = new Set();

const client = await QaqhClient.connect({
  provider: staticProvider(
    { endpoint: discovery.endpoint.replace(/\/+$/, ""), token: discovery.token },
    "lan",
  ),
  onBatch: (b) => {
    batches += 1;
    seedsSeen.add(b.seed);
    if (batches <= 5) {
      const first = b.envelopes[0]?.event;
      console.log(
        `  [sse] ${b.channel} seed=${short(b.seed)} seq=${b.from_stream_seq}..${b.to_stream_seq} type=${first?.type ?? "?"}`,
      );
    }
  },
  onState: (s, info) => console.log(`  [state] ${s}${info ? ` epoch=${short(info.serverEpoch)} ttl=${info.leaseTtlMs}ms` : ""}`),
  onReset: (sig) => resets.push(sig.reason),
  onParseError: (err, ch) => console.error(`  [parse-error] ${ch}:`, err),
});

check("open 协商", client.state === "ready", `state=${client.state} session=${short(client.info?.clientSessionId)}`);

const ver = await client.service("daemon.version");
check("service daemon.version", ver !== undefined && ver !== null, JSON.stringify(ver).slice(0, 100));

const before = await client.service("session.list");
const beforeCount = Array.isArray(before) ? before.length : -1;
check("service session.list", beforeCount >= 0, `count=${beforeCount}`);

const ack = await client.sendCommand("control", {
  channel: "control",
  type: "session_create",
  close_current: false,
});
check("session_create ack", ack.status === "accepted", `status=${ack.status} id=${short(ack.command_id)}`);

await sleep(800);
const after = await client.service("session.list");
const afterList = Array.isArray(after) ? after : [];
const beforeSeeds = new Set(
  (Array.isArray(before) ? before : []).map((it) => (typeof it === "string" ? it : it?.seed)).filter(Boolean),
);
let seed = afterList
  .map((it) => (typeof it === "string" ? it : it?.seed))
  .find((s) => s && !beforeSeeds.has(s));
if (!seed) seed = [...seedsSeen][0];
check("新会话 seed 可见", Boolean(seed), `seed=${short(seed)} count=${beforeCount}→${afterList.length}`);

const rack = await client.attachSession(seed);
check("attach(会话附着)", rack.status === "accepted", `status=${rack.status}`);

const page = await client.timelineSnapshot(seed);
check(
  "timeline 快照",
  typeof page.snapshot?.watermark === "number" && Array.isArray(page.snapshot?.turns),
  `watermark=${page.snapshot?.watermark} turns=${page.snapshot?.turns.length} has_more=${page.has_more}`,
);

const payload = JSON.stringify({ hello: "qaqh", ts: Date.now() });
const blob = new Blob([payload], { type: "application/json" });
const up = await client.uploadContent(seed, blob, "application/json", "smoke.json");
check("content 上传", typeof up.content_id === "string" && up.sha256 === up.content_id, `content_id=${short(up.content_id)}`);

const down = await client.downloadContent(up.content_id, seed);
const roundtrip = (await down.text()) === payload;
check("content 下载往返", roundtrip);

await sleep(1200);
check("SSE 收到 batch", batches > 0, `batches=${batches} resets=${JSON.stringify(resets)}`);

client.close();
check("close 后状态", client.state === "closed");

const stop = await stopDaemonIfIdle(discovery);
check("stop-if-idle", stop === "stopped" || stop === "busy", `result=${stop}`);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
process.exit(failed.length === 0 ? 0 : 1);
