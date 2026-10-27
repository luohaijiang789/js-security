import fs from 'node:fs';

export const defaults = {
  include: ['**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts,vue,svelte}'],
  exclude: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**', '**/.next/**', '**/*.d.{ts,mts,cts}'],
  entries: [], layers: [], clients: [], maxDepth: 8, maxSteps: 100000, maxStepsPerFile:null, maxCandidates: 16, includeUnlinked:false,
};

const strings = v => Array.isArray(v) && v.every(s => typeof s === 'string' && s.length > 0);
export function validateConfig(root, options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('配置必须是 JSON 对象');
  for (const key of Object.keys(options)) if (!Object.hasOwn(defaults,key) && key !== 'aliases') throw new Error(`未知配置字段: ${key}`);
  const config = { ...defaults, ...options };
  if(typeof config.includeUnlinked!=='boolean')throw new Error('includeUnlinked 必须是布尔值');
  for (const key of ['include', 'exclude', 'entries']) if (!strings(config[key])) throw new Error(`${key} 必须是 glob 字符串数组`);
  for (const key of ['maxDepth', 'maxSteps', 'maxCandidates']) if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`${key} 必须是安全正整数`);
  if(config.maxStepsPerFile!==null && (!Number.isSafeInteger(config.maxStepsPerFile) || config.maxStepsPerFile<1))throw new Error('maxStepsPerFile 必须是 null 或安全正整数');
  if (!Array.isArray(config.layers) || config.layers.some(l => !l || typeof l.name !== 'string' || !l.name || !strings(l.match))) throw new Error('layers 必须包含 name 和 match glob 数组');
  if (!Array.isArray(config.clients) || config.clients.some(c => !c || typeof c.name !== 'string' || !c.name || !['axios', 'fetch', 'ofetch', 'ky'].includes(c.kind ?? 'axios'))) throw new Error('clients 必须包含 name，kind 仅支持 axios/fetch/ofetch/ky');
  if (config.aliases !== undefined && (!config.aliases || typeof config.aliases !== 'object' || Array.isArray(config.aliases) || !Object.values(config.aliases).every(strings))) throw new Error('aliases 必须是路径到字符串数组的映射');
  if (!fs.statSync(root).isDirectory()) throw new Error('扫描根目录必须是目录');
  return config;
}
