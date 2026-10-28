import {createHash} from 'node:crypto';
import {deploymentUrl,deploymentAddress} from './deployment-address.js';

const json=value=>value===undefined?'未知':value===null?'无显式字段':JSON.stringify(value);
export const sinkId=p=>`${p.file}:${p.line}:${p.column}`;

export function requestRows(report,metadata={},locations=new Map()) {
  const result=[],base=deploymentUrl(metadata.deploymentUrl);
  for(const [kind,endpoints] of [['entry',report.endpoints],['unlinked',report.assetCandidates??[]]])for(const endpoint of endpoints)for(const usage of endpoint.usages) {
    const sink=usage.callChain.at(-1),positions=locations.get(sinkId(sink))??[];
    const stages=[{stage:'call-site',method:endpoint.method,url:endpoint.url,address:usage.address,query:usage.query,body:usage.body,headers:usage.headers,resolution:usage.resolution,parameterFields:usage.parameterFields}];
    for(const variant of usage.afterRequestHooks?.variants??[])stages.push({stage:'after-request-hooks',...variant});
    for(const stage of stages)for(const position of positions.length?positions:[null]) {
      const address=deploymentAddress(stage,base);
      const gaps=[...usage.unresolved,...address.gaps];
      if(!address.host)gaps.push('Host 未解析');
      if(metadata.mode==='source-map-assisted'&&!position)gaps.push('发送位置未找到产物映射，保留源码候选');
      const row={sourceKind:'repository-static',discoveryBasis:kind==='unlinked'?'unlinked-asset':metadata.mode??'source-static',repository:metadata.repository??null,commit:metadata.commit??null,
        generatedFile:position?.file??null,generatedLine:position?.line??null,generatedColumn:position?.column??null,
        sourceFile:sink.file,sourceLine:sink.line,sourceColumn:sink.column,sourceVersionMatch:position?.sourceVersionMatch??null,
        method:stage.method,host:address.host,hostBasis:address.hostBasis,hostState:address.hostState,url:stage.url,resolvedUrl:address.resolvedUrl,deploymentUrl:base,query:stage.query,body:stage.body,headers:stage.headers,stage:stage.stage,resolution:stage.resolution,
        parameterFields:stage.parameterFields??[],conditions:stage.conditions??usage.conditions??[],callChain:usage.callChain,gaps:[...new Set(gaps)]};
      row.id=createHash('sha256').update(JSON.stringify(row)).digest('hex').slice(0,20);result.push(row);
    }
  }
  return result;
}

export const tableColumns=['id','repository','commit','discoveryBasis','generatedFile','generatedLine','generatedColumn','sourceFile','sourceLine','sourceColumn','sourceVersionMatch','method','host','hostBasis','hostState','url','resolvedUrl','deploymentUrl','query','body','headers','parameterFields','stage','resolution','conditions','gaps'];
export function requestCsv(rows) {
  const cell=value=>{
    let text=value==null?'未知':typeof value==='object'?JSON.stringify(value):String(value);
    if(/^\s*[=+@-]/.test(text))text="'"+text;
    return '"'+text.replaceAll('"','""')+'"';
  };
  return '\uFEFF'+[tableColumns.map(cell).join(','),...rows.map(row=>tableColumns.map(key=>cell(row[key]===null&&['query','body','headers'].includes(key)?'无显式字段':row[key])).join(','))].join('\r\n')+'\r\n';
}

export function requestMarkdown(rows,metadata={}) {
  const escape=value=>String(value??'未知').replaceAll('|','\\|').replaceAll('\n','<br>').replaceAll('\r','');
  const location=(file,line,column)=>file?`${file}:${line}:${column}`:'未映射';
  return `# 构建关联的请求表\n\n仓库：${metadata.repository??'未知'}\n\nCommit：${metadata.commit??'未知'}\n\n模式：${metadata.mode??'source-static'}；记录：${rows.length}。每行保留独立调用/条件/阶段。静态发送候选不证明运行时执行；未知和缺口必须保留。\n\n部署基址：${escape(metadata.deploymentUrl)}。deployment-context/context-candidate 表示给定基址下的候选 Host；不证明真实部署或运行请求。解析 URL 未合并 Query 配置、未证明最终序列化。\n\n| 产物 JS 位置 | 对应源码位置 | 方法 | Host | Host 依据/状态 | 原始 URL | 解析 URL | Query | Body | Header | 阶段/状态 |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n`+
    rows.map(r=>'| '+[location(r.generatedFile,r.generatedLine,r.generatedColumn),location(r.sourceFile,r.sourceLine,r.sourceColumn),r.method,r.host,r.hostBasis+'/'+r.hostState,r.url,r.resolvedUrl,json(r.query),json(r.body),json(r.headers),r.stage+'/'+r.resolution].map(escape).join(' | ')+' |').join('\n')+
    '\n\n## 缺口\n\n'+[...new Set([...(metadata.gaps??[]),...rows.flatMap(r=>r.gaps)])].map(g=>'- '+escape(g)).join('\n')+'\n';
}
