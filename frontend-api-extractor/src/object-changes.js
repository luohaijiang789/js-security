import {CHANGES,TAG,isUnknown,clean} from './values.js';

export function mergeChanges(left=[],right=[]) {
  const all=[...left,...right];
  if(all.length<=128)return all;
  const event=all[127];
  return [...all.slice(0,127),{operation:'history-truncated',key:null,file:event.file,line:event.line,column:event.column}];
}

export function rememberChange(target,event,onTruncate) {
  if((target[CHANGES]?.length??0)>=128) {
    if(target[CHANGES].at(-1).operation==='history-truncated')return;
    target[CHANGES]=[...target[CHANGES].slice(0,127),{operation:'history-truncated',key:null,file:event.file,line:event.line,column:event.column}];
    onTruncate?.();return;
  }
  target[CHANGES]=[...(target[CHANGES]??[]),event];
}

export function collectChanges(config,fields) {
  const result=[];
  const events=(value,carrier,path)=>{
    for(const event of value?.[CHANGES]??[])result.push({...event,carrier,path:event.key===null?path:[...path,event.key],stage:'call-site'});
  };
  // Config-level writes are separate from nested payload/carrier writes.
  events(config,'config',[]);
  const walk=(value,carrier,path,seen=new Set())=>{
    if(value?.[TAG]==='instance'){walk(value.properties,carrier,path,seen);return;}
    if(!value || typeof value!=='object' || seen.has(value))return;
    if(value[TAG]==='serialized'){walk(value.input,carrier,path,seen);return;}
    if(value[TAG])return;
    events(value,carrier,path);
    if(isUnknown(value))return;
    const next=new Set(seen).add(value);
    for(const [key,item] of Object.entries(value))walk(item,carrier,[...path,key],next);
  };
  for(const [carrier,value] of Object.entries(fields))walk(value,carrier,[]);
  return clean(result);
}
