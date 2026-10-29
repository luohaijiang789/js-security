import { TAG, CLIENT_STATE, UNKNOWN, unknown, isUnknown, hasUnknown, text } from './values.js';

export const methods = new Set(['get','post','put','patch','delete','head','options']);

export function libraryClient(moduleName, importName = 'default') {
  if(moduleName==='jquery'&&['default','*','ajax','get','post','getJSON'].includes(importName))return {[TAG]:'client',kind:'jquery',...(['default','*'].includes(importName)?{}:{member:importName})};
  if (moduleName === 'axios' && ['default','*','request','create',...methods].includes(importName)) return {[TAG]:'client',kind:'axios',...(['default','*'].includes(importName) ? {} : {member:importName})};
  if (['node-fetch','cross-fetch','isomorphic-fetch','whatwg-fetch'].includes(moduleName) && ['default','fetch','*'].includes(importName)) return {[TAG]:'client',kind:'fetch'};
  if (['ofetch','$fetch'].includes(importName) && moduleName === 'ofetch') return {[TAG]:'client',kind:'ofetch'};
  if (['ky','ky-universal'].includes(moduleName) && importName === 'default') return {[TAG]:'client',kind:'ky'};
}

export function requestCall(target, args, mergeConfig) {
  let {kind,member} = target;
  if(kind==='axios'&&member==='default')member=undefined;
  if (['create','extend'].includes(member) && ['axios','ofetch','ky'].includes(kind)) {
    const data = mergeConfig(target,args[0] ?? {});
    delete data.member;
    if(kind==='axios') {delete data.bindingIds;data[CLIENT_STATE]={hooks:[],seen:new Set(),gaps:[],nextId:0};}
    return {value:{...data,[TAG]:'client',kind}};
  }
  let data = {}, method, url;
  if(kind==='jquery') {
    if(member==='ajaxSetup'){if(target.jqueryState)target.jqueryState.uncertain=true;return {value:unknown('jquery ajaxSetup'),gap:'jquery ajaxSetup defaults are not modeled'};}
    if(!['ajax','get','post','getJSON'].includes(member))return {value:unknown('jquery non-request member')};
    if(member==='ajax') {
      data=typeof args[0]==='string'?{...args[1],url:args[0]}:args[0]??{};
      url=data.url??(isUnknown(data)?data:unknown('jquery url'));
      method=data.method??data.type??(hasUnknown(data)||target.jqueryState?.uncertain?unknown('jquery method'):'GET');
    } else {
      url=args[0];method=member==='post'?'POST':'GET';
      const payload=args[1]?.[TAG]==='function'?undefined:args[1];data=payload===undefined?{}:{data:payload};
    }
    const verb=typeof method==='string'?method.toUpperCase():null;
    data={...data,...(['GET','HEAD'].includes(verb)?{params:data.data,data:undefined}:{})};
    if(target.jqueryState?.uncertain)data[UNKNOWN]='jquery ajaxSetup defaults unresolved';
    if(data.beforeSend||data.dataFilter||data.dataType==='jsonp')return {method,url,data:{...data,[UNKNOWN]:'jquery hooks/JSONP unmodeled'},gap:'jquery hooks/JSONP may alter the request'};
    return {method,url,data};
  }
  if (kind === 'fetch' || kind === 'ofetch' || kind === 'ky') {
    if (member && !(kind === 'ky' && methods.has(member)) && !(kind === 'ofetch' && member === 'raw')) return {value:unknown('unsupported client member')};
    const request = args[0]?.[TAG] === 'request' ? args[0] : null;
    url = request ? request.url : args[0];
    data = {...request?.config,...args[1]};
    if (isUnknown(args[1])) data = { ...data, [UNKNOWN]:text(args[1]), method:unknown('options.method') };
    if (kind === 'ofetch' || kind === 'ky') data = mergeConfig(target,data);
    method = methods.has(member) ? member : data.method ?? (hasUnknown(data) ? unknown('options.method') : 'GET');
    if (kind === 'ky') {
      if (data.searchParams !== undefined) data.params = data.searchParams;
      if (data.json !== undefined) data.body = data.json;
      if (data.prefixUrl !== undefined) data.baseURL = data.prefixUrl;
    } else if (kind === 'ofetch') {
      if (data.query !== undefined) data.params = data.params && typeof data.params === 'object' && !isUnknown(data.params) ? {...data.params,...data.query} : data.query;
    }
  } else if (methods.has(member)) {
    method = member; url = args[0];
    const hasBody = ['post','put','patch'].includes(member);
    data = {...args[hasBody ? 2 : 1],...(hasBody ? {data:args[1]} : {})};
  } else if (!member || member === 'request') {
    data = typeof args[0] === 'string' ? {...args[1],url:args[0]} : args[0] ?? {};
    url = data.url ?? (isUnknown(data) ? data : undefined);
    method = data.method ?? (target.methodField ? data[target.methodField] : undefined) ?? (hasUnknown(data) ? unknown('config.method') : target.method ?? 'GET');
  } else return {value:unknown('unsupported client member')};
  return {method,url,data};
}
