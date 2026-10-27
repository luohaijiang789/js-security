import { parse as parseVue } from '@vue/compiler-sfc';
import { parse as parseSvelte } from 'svelte/compiler';
import path from 'node:path';

// Preserve every offset (including CRLF) so AST locations refer to the original file.
export function scriptSource(file, source) {
  const ext = path.extname(file);
  if (!['.vue', '.svelte'].includes(ext)) return source;
  let ranges;
  if (ext === '.vue') {
    const { descriptor, errors } = parseVue(source, { filename: file });
    if (errors.length) throw new Error(errors.map(e => e.message ?? String(e)).join('; '));
    const blocks = [descriptor.script, descriptor.scriptSetup].filter(Boolean);
    if (blocks.some(b => b.src)) throw new Error('外部 script src 尚未支持，请直接扫描对应脚本');
    ranges = blocks.map(b => [b.loc.start.offset, b.loc.end.offset]);
  } else {
    const ast = parseSvelte(source);
    ranges = [ast.instance, ast.module].filter(Boolean).map(b => [b.content.start, b.content.end]);
  }
  const chars = source.split('').map(c => c === '\n' || c === '\r' ? c : ' ');
  for (const [start, end] of ranges) for (let i = start; i < end; i++) chars[i] = source[i];
  return chars.join('');
}
