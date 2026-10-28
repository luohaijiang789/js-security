import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import glob from 'fast-glob';
import ts from 'typescript';
import {TraceMap,eachMapping} from '@jridgewell/trace-mapping';
import {pathToFileURL} from 'node:url';
import {analyze} from './analyzer.js';
import {unpackWebpack} from './webpack-modules.js';
import {sinkId} from './request-table.js';

export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const relative=(root,file)=>path.relative(root,file).split(path.sep).join('/');
export function ownedSource(name) {
  const clean=name.replaceAll('\\','/').split('?')[0];
  if(clean.includes('/node_modules/')||clean.startsWith('node_modules/'))return null;
  const match=/(?:^|\/)(src\/.*)$/.exec(clean);
  if(!match||match[1].split('/').some(part=>part==='..'||part==='')||! /\.(?:[cm]?[jt]sx?|vue|svelte)$/.test(match[1]))return null;
  return match[1];
}

export async function analyzeBuild(checkout,artifactDirs,output,options={},originalHashes=null) {
  const virtual=path.join(output,'mapped-sources');await fs.mkdir(virtual,{recursive:true});
  const assets=[],contexts=[],contents=new Map(),conflicts=new Set(),gaps=[];
  const original=originalHashes??new Map();
  if(!originalHashes)for(const name of await glob('src/**/*.{js,jsx,ts,tsx,mjs,cjs,vue,svelte}',{cwd:checkout,followSymbolicLinks:false})) {
    const file=path.join(checkout,name);if(!(await fs.lstat(file)).isSymbolicLink())original.set(name,sha256(await fs.readFile(file)));
  }
  const byHash=new Map();for(const [name,hash] of original){if(!byHash.has(hash))byHash.set(hash,[]);byHash.get(hash).push(name);}
  let sourceBytes=0,mapBytes=0,excludedSources=0;
  for(const dir of artifactDirs) {
    const root=path.resolve(checkout,dir);
    if(!root.startsWith(path.resolve(checkout)+path.sep))throw new Error('产物目录必须位于 checkout 内部');
    if(!(await fs.stat(root)).isDirectory())throw new Error('构建没有产生声明的产物目录: '+dir);
    if(!(await fs.realpath(root)).startsWith((await fs.realpath(checkout))+path.sep))throw new Error('产物目录软链接越过 checkout');
    const files=await glob(['**/*.{js,mjs,cjs}'],{cwd:root,absolute:true,followSymbolicLinks:false});
    for(const file of files.sort()) {
      if((await fs.lstat(file)).isSymbolicLink())throw new Error('JS 资产不能是软链接');
      const data=await fs.readFile(file);if(data.length>32*1024*1024)throw new Error('单 JS 超过 32 MiB 限额');
      const asset={file:relative(checkout,file),bytes:data.length,sha256:sha256(data)};assets.push(asset);
      if(assets.length>1000)throw new Error('JS 文件数超过 1000');
      const mapFile=file+'.map';let raw;
      try{if((await fs.lstat(mapFile)).isSymbolicLink())throw new Error('source map 不能是软链接');raw=await fs.readFile(mapFile);}catch(error){if(error.code!=='ENOENT')throw error;gaps.push('无相邻 source map: '+asset.file);continue;}
      mapBytes+=raw.length;if(raw.length>32*1024*1024||mapBytes>128*1024*1024)throw new Error('source map 字节预算超限');
      const comment=/sourceMappingURL=([^\s]+)/.exec(data.toString('utf8').slice(-2048));
      if(!comment||comment[1]!==path.basename(mapFile)){gaps.push('source map 与 JS 引用不匹配: '+asset.file);continue;}
      let map;try{map=JSON.parse(raw);}catch{gaps.push('source map JSON 解析失败: '+asset.file);continue;}
      if(map.version!==3||!Array.isArray(map.sources)||!Array.isArray(map.sourcesContent)){gaps.push('不支持的 source map 或缺 sourcesContent: '+asset.file);continue;}
      asset.sourceMap={file:relative(checkout,mapFile),sha256:sha256(raw),bytes:raw.length};
      const trace=new TraceMap(map,pathToFileURL(mapFile).href),names=new Map();
      for(const [index,name] of map.sources.entries()) {
        const text=map.sourcesContent[index],clean=name.replaceAll('\\','/').split('?')[0];
        if(typeof text!=='string'||clean.includes('node_modules/')){excludedSources++;continue;}
        const hash=sha256(text);
        const candidates=(byHash.get(hash)??[]).filter(file=>clean===file||clean.endsWith('/'+file)||clean===file.slice(4)||clean.endsWith('/'+file.slice(4)));
        const target=candidates.length===1?candidates[0]:null;
        if(!target) {
          const declared=ownedSource(name);
          if(declared&&original.has(declared)&&!clean.split('/').includes('..')){conflicts.add(declared);gaps.push('同名 source 内容冲突: '+declared);}
          excludedSources++;continue;
        }
        names.set(trace.resolvedSources[index],target);
        const previous=contents.get(target);
        if(previous&&previous.hash!==sha256(text)){conflicts.add(target);gaps.push('同名 source 内容冲突: '+target);continue;}
        if(!previous){sourceBytes+=Buffer.byteLength(text);if(sourceBytes>64*1024*1024)throw new Error('sourcesContent 超过 64 MiB');contents.set(target,{text,hash:sha256(text)});}
      }
      contexts.push({trace,names,asset});
    }
  }
  if(!assets.length)throw new Error('构建未产生 JS 资产');
  for(const [name,source] of contents)if(!conflicts.has(name)){const target=path.join(virtual,name);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,source.text);}
  let mode=contents.size>conflicts.size?'source-map-assisted':'artifact-static';
  const webpack=mode==='artifact-static'?await unpackWebpack(checkout,assets,output):null;
  if(webpack?.files.length)mode='webpack-module-static';
  if(webpack)gaps.push(...webpack.gaps);
  const analysisRoot=mode==='source-map-assisted'?virtual:mode==='webpack-module-static'?webpack.root:checkout;
  const config=mode==='source-map-assisted'?options:mode==='webpack-module-static'?{...options,entries:[],include:['**/*.js'],exclude:[]}:{...options,include:assets.map(a=>a.file),exclude:['**/node_modules/**','**/.git/**']};
  const report=await analyze(analysisRoot,config),locations=new Map(),wanted=new Map(),sendIds=new Set();
  for(const endpoint of [...report.endpoints,...report.assetCandidates])for(const usage of endpoint.usages) {
    const sink=usage.callChain.at(-1),id=sinkId(sink);if(wanted.has(id))continue;
    sendIds.add(id);
    if(mode==='webpack-module-static'){const position=webpack.locations.get(id);if(position)locations.set(id,position);continue;}
    if(mode==='artifact-static'){locations.set(id,[{file:sink.file,line:sink.line,column:sink.column,sourceVersionMatch:null}]);continue;}
    const source=contents.get(sink.file);if(!source||conflicts.has(sink.file))continue;
    const sf=ts.createSourceFile(sink.file,source.text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JSX);
    let range;
    const visit=node=>{if(ts.isCallExpression(node)){const start=sf.getLineAndCharacterOfPosition(node.getStart());if(start.line+1===sink.line&&start.character+1===sink.column){const end=sf.getLineAndCharacterOfPosition(node.end);range={endLine:end.line+1,endColumn:end.character+1};}}ts.forEachChild(node,visit);};visit(sf);
    if(range)wanted.set(id,{...sink,...range});
  }
  for(const context of contexts) {
    const found=new Set();
    eachMapping(context.trace,mapping=>{
      const name=context.names.get(mapping.source);if(!name||conflicts.has(name)||mapping.originalLine==null)return;
      for(const [id,sink] of wanted) {
        if(sink.file!==name||found.has(id))continue;
        const line=mapping.originalLine,column=mapping.originalColumn+1;
        if(line<sink.line||line===sink.line&&column<sink.column||line>sink.endLine||line===sink.endLine&&column>sink.endColumn)continue;
        if(!locations.has(id))locations.set(id,[]);
        locations.get(id).push({file:context.asset.file,line:mapping.generatedLine,column:mapping.generatedColumn+1,sourceHash:contents.get(name).hash});found.add(id);
      }
    });
  }
  for(const [id,positions] of locations) {
    const source=wanted.get(id);if(!source)continue;let match=false;
    if(originalHashes)match=originalHashes.get(source.file)===contents.get(source.file).hash;
    else try{const file=await fs.realpath(path.join(checkout,source.file));if(file.startsWith((await fs.realpath(checkout))+path.sep))match=sha256(await fs.readFile(file))===contents.get(source.file).hash;}catch{}
    for(const position of positions)position.sourceVersionMatch=match;
  }
  const unmapped=[...sendIds].filter(id=>!locations.has(id)).length;if(unmapped)gaps.push(`${unmapped} 个源码发送位置无产物映射，不能确认在产物中保留`);
  if(excludedSources)gaps.push(`未分析第三方/非 src/非脚本/缺内容 source 条目 ${excludedSources} 个；不能据此断言没有请求`);
  if(mode==='artifact-static')gaps.push('未取得可用应用 sourcesContent；打包 runtime 不保证支持');
  return {mode,assets,report,locations,gaps,webpack:webpack?{modules:webpack.moduleAssets,chunks:webpack.chunks}:null,mappedSources:[...contents].filter(([name])=>!conflicts.has(name)).map(([file,s])=>({file,sha256:s.hash})),excludedSources};
}
