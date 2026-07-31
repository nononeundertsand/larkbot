// 零依赖 .env 加载器。
//
// 为什么需要它：start.sh 早期用 `set -a; . ./.env` 让 shell source .env，
// 但 shell 会吞掉值里的双引号（如 LLM_MODELS 的 JSON），导致解析失败。
// 改由 Node 自己按行解析，任何带引号/JSON/特殊字符的值都能原样读入。
//
// 规则：
//   - 忽略空行与以 # 开头的注释行
//   - KEY=VALUE，按第一个 = 切分；KEY 需是合法环境变量名
//   - VALUE 两端若被成对的单引号或双引号包裹，则去掉这层引号（内部内容原样保留）
//   - 不做变量展开、不处理续行；已存在于 process.env 的键不覆盖（真实环境变量优先）

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export function loadEnv(path = join(__dirname, '..', '.env')) {
  if (!existsSync(path)) return { loaded: false, count: 0 };
  let text = '';
  try { text = readFileSync(path, 'utf8'); } catch { return { loaded: false, count: 0 }; }

  let count = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    // 去掉成对的外层引号（单或双），内部内容原样保留（JSON 里的引号得以保住）
    if (value.length >= 2 && ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
      count += 1;
    }
  }
  return { loaded: true, count };
}
