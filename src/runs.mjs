// 从 Coopanion 的运行日志里捞全量对话：data/runs/<run>/events.jsonl
//
// 为什么用它而不是交接笔记：
//   1) 时间是真实 ISO 时间戳，不用猜（交接笔记只有 HH:MM，跨零点要靠文件时间反推）
//   2) 覆盖的是每一个外来事件与她每一次开口，不只"值得写进交接的那部分"
//   3) 交接笔记会被 slim 折叠/搬走，运行日志还在原地
//
// 只取"人说的话"这几类，系统状态、视频日志、戳一戳、交接回执都跳过。
import fs from 'node:fs';
import path from 'node:path';
import { parseFact, classifyEntry } from './coo-adapt.mjs';

const KEEP = new Set([
  'qq.message', // 别人发进 QQ 的（含主人）
  'qq.self', // 她自己发的 QQ
  'desktop-pet.self', // 她自己的气泡台词
  'desktop-pet.message', // 对方在桌宠里打的字
  'desktop-pet.speech', // 主人说的话（语音识别）
  'desktop-pet.answer', // 主人对她的提问选项作答
  'console.message', // 控制台上她俩的对话
]);

const PET_PREFIX = /^\[\d{1,2}:\d{2}(?::\d{2})?\]\s*(?:\[[a-z]+\]\s*)?/i;
const SPEAKER = /^(哥哥|主人|你|我|控制台)\s*[:：]\s*/;

/** 桌宠/语音/控制台那几路：正文前面是 `[23:41] [voice] 哥哥:` 这种前缀。 */
function parsePet(text) {
  const body = String(text ?? '').replace(PET_PREFIX, '').trim();
  const speaker = SPEAKER.exec(body)?.[1] ?? '';
  const rest = body.replace(SPEAKER, '').replace(/\s+/g, ' ').trim();
  if (rest.length < 4) return null;
  const role = speaker === '你' || speaker === '我' ? 'self' : speaker ? 'owner' : '';
  return { text: rest, role };
}

const listRuns = (root) => {
  try {
    return fs
      .readdirSync(root)
      .filter((name) => name.startsWith('r-'))
      .sort();
  } catch {
    return [];
  }
};

/**
 * @returns {{messages: {id:string,text:string,at:number,proto:string,scene:string,group:string}[], files:number}}
 */
export function readRunEvents(home, cutoff) {
  const root = path.join(home, 'data', 'runs');
  const messages = [];
  let files = 0;

  for (const run of listRuns(root)) {
    const file = path.join(root, run, 'events.jsonl');
    let raw = '';
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    files += 1;
    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i]) continue;
      let event;
      try {
        event = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (!KEEP.has(event?.type)) continue;
      // 桌宠的「做了:end_turn」这类是界面动作提示，不是她说的话
      if (event.meta?.kind === 'activity') continue;
      const at = Date.parse(event.ts ?? '');
      if (!Number.isFinite(at) || at < cutoff) continue;

      let parsed;
      let proto;
      let scene;
      let group = '';
      if (event.type.startsWith('qq.')) {
        // QQ 那几路的正文跟事实库同一套前缀：#id [私聊 23:21] 昵称(QQ): 内容
        parsed = parseFact(event.text);
        if (!parsed) continue;
        const cls = classifyEntry(String(event.senderKey ?? ''), parsed);
        if (cls.system) continue;
        proto = cls.proto;
        scene = cls.scene;
        group = cls.group;
        // qq.self 是她自己发的，分类器可能把它当"别人"，这里按事件来源纠正
        if (event.type === 'qq.self') proto = parsed.isGroup ? 'self-group' : 'self';
      } else {
        parsed = parsePet(event.text);
        if (!parsed) continue;
        proto = parsed.role === 'self' ? 'self' : parsed.role === 'owner' ? 'private' : 'private';
        scene = 'direct';
      }

      messages.push({
        id: `run_${run}_${i}`,
        text: parsed.text,
        at,
        proto,
        scene,
        group,
      });
    }
  }

  messages.sort((a, b) => a.at - b.at);
  return { messages, files };
}
