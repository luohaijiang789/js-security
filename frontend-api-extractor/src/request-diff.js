// Comparison keys are scoped anchors, not permanent cross-version endpoint IDs.
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const encode=value=>JSON.stringify(canonical(value));
const sorted=values=>[...(values??[])].map(canonical).sort((a,b)=>encode(a).localeCompare(encode(b)));
const conditions=row=>sorted((row.conditions??[]).map(({file,line,column,expression,outcome})=>({file,line,column,expression,outcome})));
export const comparisonFields=['sourceKind','discoveryBasis','method','host','hostBasis','hostState','url','resolvedUrl','query','body','headers','parameterFields','resolution','generatedFile','generatedLine','generatedColumn','sourceVersionMatch','gaps'];
export function comparisonKey(row) {
  if(typeof row.sourceFile!=='string'||!Number.isSafeInteger(row.sourceLine)||row.sourceLine<1||!Number.isSafeInteger(row.sourceColumn)||row.sourceColumn<1||typeof row.stage!=='string')throw new Error('请求行缺少有效源码位置或阶段');
  const chain=(row.callChain??[]).map(({file,line,column,symbol})=>({file,line,column,symbol}));
  return encode([[row.repository??null,row.commit??null,row.deploymentUrl??null],row.sourceFile,row.sourceLine,row.sourceColumn,row.stage,conditions(row),chain]);
}
const projection=row=>Object.fromEntries(comparisonFields.map(key=>[key,['parameterFields','gaps'].includes(key)?sorted(row[key]):row[key]]));
const unknown=(value,key)=>value===undefined||value===null&&['host','resolvedUrl'].includes(key)||Boolean(value&&typeof value==='object'&&Object.hasOwn(value,'__unknown'))||typeof value==='string'&&/\{[^}]+\}/.test(value);
function unknownTransitions(before,after,path=[],result=[]) {
  const key=path.at(-1);
  if(after!==undefined&&!unknown(before,key)&&unknown(after,key)){result.push(path);return result;}
  if(before&&after&&typeof before==='object'&&typeof after==='object')for(const key of Object.keys(before))unknownTransitions(before[key],after[key],[...path,key],result);
  return result;
}

export function compareRequests(expected,actual) {
  const read=value=>{
    const rows=Array.isArray(value)?value:value?.rows;
    if(!Array.isArray(rows))throw new Error('输入必须为请求行数组或包含 rows 的 JSON');
    const groups=new Map();
    for(const row of rows){const key=comparisonKey(row);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(projection(row));}
    return {rows,groups};
  };
  const left=read(expected),right=read(actual),added=[],removed=[],changed=[],ambiguous=[],contextConflicts=[],analysisChanges=[];
  for(const key of ['repository','commit','deploymentUrl','mode'])if(!Array.isArray(expected)&&!Array.isArray(actual)&&encode(expected[key]??null)!==encode(actual[key]??null))contextConflicts.push({field:key,expected:expected[key]??null,actual:actual[key]??null});
  for(const field of ['repository','commit','deploymentUrl']) {
    const contexts=rows=>sorted([...new Set(rows.map(r=>encode(r[field]??null)))]);
    if(encode(contexts(left.rows))!==encode(contexts(right.rows)))contextConflicts.push({field:'rows.'+field,expected:contexts(left.rows),actual:contexts(right.rows)});
  }
  if(!Array.isArray(expected)&&!Array.isArray(actual)) {
    const state=value=>({complete:value.stats?.complete??null,partitions:sorted((value.stats?.partitions??[]).map(({file,phase,state,reason})=>({file,phase,state,reason}))),diagnostics:sorted((value.diagnostics??[]).map(({code,file,line,column})=>({code,file,line,column}))),gaps:sorted(value.gaps),buildGaps:sorted(value.buildGaps)});
    const before=state(expected),after=state(actual);
    for(const field of Object.keys(before))if(encode(before[field])!==encode(after[field]))analysisChanges.push({field,expected:before[field],actual:after[field]});
  }
  let unchanged=0;
  for(const key of [...new Set([...left.groups.keys(),...right.groups.keys()])].sort()){
    const before=[...(left.groups.get(key)??[])],after=[...(right.groups.get(key)??[])];
    // First cancel exact multisets; duplicate observations must not disappear.
    for(let i=before.length-1;i>=0;i--){const index=after.findIndex(row=>encode(row)===encode(before[i]));if(index>=0){before.splice(i,1);after.splice(index,1);unchanged++;}}
    if(!before.length){for(const row of after)added.push({key,row});continue;}
    if(!after.length){for(const row of before)removed.push({key,row});continue;}
    if(before.length!==1||after.length!==1){ambiguous.push({key,expected:before,actual:after,reason:'同一锚点有多个不相同的候选，未任意配对'});continue;}
    const fields=comparisonFields.filter(field=>encode(before[0][field])!==encode(after[0][field])).map(field=>({field,expected:before[0][field]??null,actual:after[0][field]??null}));
    changed.push({key,fields,becameUnknown:unknownTransitions(before[0],after[0])});
  }
  return {schemaVersion:1,passed:!added.length&&!removed.length&&!changed.length&&!ambiguous.length&&!contextConflicts.length&&!analysisChanges.length,summary:{expected:left.rows.length,actual:right.rows.length,unchanged,added:added.length,removed:removed.length,changed:changed.length,ambiguous:ambiguous.length,becameUnknown:changed.reduce((n,c)=>n+c.becameUnknown.length,0)},analysisChanges,cost:{expectedSteps:expected.stats?.steps??null,actualSteps:actual.stats?.steps??null},contextConflicts,added,removed,changed,ambiguous};
}

export function diffMarkdown(diff) {
  const escape=value=>JSON.stringify(value).replaceAll('|','\\|').replaceAll('\n',' ');
  const rows=[];
  for(const kind of ['added','removed','changed','ambiguous'])for(const item of diff[kind])rows.push(`| ${kind} | ${escape(JSON.parse(item.key))} | ${escape(item.fields??item.row??item.reason)} |`);
  return '# 请求差异报告\n\n结果：'+(diff.passed?'一致':'有差异')+'；'+JSON.stringify(diff.summary)+'\n\n上下文差异：'+escape(diff.contextConflicts)+'\n\n分析状态差异：'+escape(diff.analysisChanges)+'；求值成本：'+escape(diff.cost)+'\n\n| 类型 | 源码/阶段/条件/调用链锚点 | 详情 |\n| --- | --- | --- |\n'+rows.join('\n')+'\n\n变未知字段路径：'+escape(diff.changed.flatMap(c=>c.becameUnknown.map(path=>({key:c.key,path}))))+'\n';
}
