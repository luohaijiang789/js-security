import {TAG,UNKNOWN,clean,isUnknown,text,dynamic,cloneEnv} from './values.js';

export function addressEvidence(requestUrl,baseURL,effective,hooks=[]) {
  let host=null,origin=null;
  const authority=/^(?:https?:)?\/\/([^/?#]+)/i.exec(effective);
  if (authority && !/[{}]/.test(authority[1])) {
    try { const u=new URL(effective.startsWith('//')?'https:'+effective:effective); host=u.host; origin=effective.startsWith('//')?null:u.origin; } catch {}
  }
  const raw=text(requestUrl);
  const path=authority ? effective.slice(authority[0].length).split(/[?#]/)[0] || '/' : raw.replace(/^https?:\/\/[^/?#]+/i,'').split(/[?#]/)[0];
  return {requestUrl:raw,baseURL:clean(baseURL ?? null),host,origin,path,
    hostState:host ? hooks.length ? 'partial' : 'resolved' : 'unknown',stage:'call-site'};
}

export function parameterFields(fields,requestUrl) {
  const result=[];
  const walk=(value,carrier,path,seen=new Set())=>{
    if(value?.[TAG]==='instance'){walk(value.properties,carrier,path,seen);return;}
    if (value == null) return;
    if (isUnknown(value)) {result.push({carrier,path,state:'unknown-value',stage:'constructed'});return;}
    if (typeof value!=='object') { if(path.length)result.push({carrier,path,state:'known-field',stage:'constructed'});return; }
    if (seen.has(value)) return;
    const next=new Set(seen).add(value);
    for(const [key,item] of Object.entries(value)) {
      if(key===UNKNOWN) result.push({carrier,path,state:'unknown-spread',stage:'constructed'});
      else {const p=[...path,key];result.push({carrier,path:p,state:'known-field',stage:'constructed'});if(item && typeof item==='object')walk(item,carrier,p,next);}
    }
  };
  for(const [carrier,original] of Object.entries(fields)) {
    const value=original?.[TAG]==='serialized'?original.input:original;
    if(value?.[TAG]==='form') {
      for(const [entryIndex,[name,item]] of value.entries.entries()){result.push({carrier,path:[name],state:'known-field',stage:'constructed',entryIndex,format:value.format});if(isUnknown(item))result.push({carrier,path:[name],state:'unknown-value',stage:'constructed',entryIndex,format:value.format});}
      if(value.gap)result.push({carrier,path:[],state:'unknown-spread',stage:'constructed',format:value.format});
    } else walk(value,carrier,[]);
  }
  const querySource=typeof requestUrl==='string'?requestUrl.split('#')[0]:'';
  if(querySource.includes('?'))for(const pair of querySource.split('?').slice(1).join('?').split('&')) {
    const key=pair.split('=')[0];
    if(!key || /[{}]/.test(key))continue;
    let name=key;try{name=decodeURIComponent(key);}catch{}
    result.push({carrier:'query',path:[name],state:'known-field',stage:'constructed',source:'url'});
  }
  return result;
}

export const builtinNames=new Set(['Object','atob','decodeURI','decodeURIComponent','encodeURI','encodeURIComponent','String.fromCharCode','JSON.stringify','JSON.parse','Object.assign']);
export function staticOperation(name,args,nodeText,onFailure) {
  if(name==='Object')return args[0]&&typeof args[0]==='object'?args[0]:{__unknown:'Object boxing'};
  if(name==='JSON.stringify') {
    const input=cloneEnv(new Map([['input',args[0]]])).get('input');
    const encoded=clean(input);
    const unsupported=args[1]!=null || args[2]!=null && typeof args[2]==='object';
    if(unsupported)onFailure();
    return {[TAG]:'serialized',format:'json',input,value:unsupported || dynamic(encoded) ? {__unknown:nodeText} : JSON.stringify(encoded,null,args[2])};
  }
  if(name==='JSON.parse' && args[1]!=null){onFailure();return {__unknown:nodeText};}
  if(args.some(v=>isUnknown(v) || v!=null && typeof v==='object'))return {__unknown:nodeText};
  if(args.length>1024 || args.some(v=>typeof v==='string' && v.length>65536)) {onFailure();return {__unknown:nodeText};}
  try {
    switch(name) {
      case 'atob':return atob(args[0]);
      case 'decodeURI':return decodeURI(args[0]);
      case 'decodeURIComponent':return decodeURIComponent(args[0]);
      case 'encodeURI':return encodeURI(args[0]);
      case 'encodeURIComponent':return encodeURIComponent(args[0]);
      case 'String.fromCharCode':return String.fromCharCode(...args);
      case 'JSON.parse':return JSON.parse(args[0]);
    }
  } catch {onFailure();}
  return {__unknown:nodeText};
}
