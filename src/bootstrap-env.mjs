// 副作用模块：在任何其它业务模块初始化之前加载 .env。
// bot.mjs 第一行 import 本模块，借 ESM「import 按顺序先于后续 import 求值」的语义，
// 保证 models.mjs / reply.mjs 等在读 process.env 时，.env 里的值（含带引号的 JSON）已就位。
import { loadEnv } from './env.mjs';

const r = loadEnv();
if (r.loaded) console.log(`[env] 已从 .env 载入 ${r.count} 项配置`);
