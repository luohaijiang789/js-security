import { TAG, UNKNOWN, unknown, isUnknown, hasUnknown, text } from './values.js';

export const methods = new Set(['get','post','put','patch','delete','head','options']);

export function libraryClient(moduleName, importName = 'default') {
  if (moduleName === 'axios' && ['default','*','request','create',...methods].includes(importName)) return {[TAG]:'client',kind:'axios',...(['default','*'].includes(importName) ? {} : {member:importName})};
  if (['node-fetch','cross-fetch','isomorphic-fetch','whatwg-fetch'].includes(moduleName) && ['default','fetch','*'].includes(importName)) return {[TAG]:'client',kind:'fetch'};
  if (['ofetch','$fetch'].includes(importName) && moduleName === 'ofetch') return {[TAG]:'client',kind:'ofetch'};
  if (['ky','ky-universal'].includes(moduleName) && importName === 'default') return {[TAG]:'client',kind:'ky'};
}

export function requestCall(target, args, mergeConfig) {
  const {kind,member} = target;
  if (['create','extend'].includes(member) && ['axios','ofetch','ky'].includes(kind)) {
    const data = mergeConfig(target,args[0] ?? {});
    delete data.member;
    return {value:{...data,[TAG]:'client',kind}};
  }
  let data = {}, method, url;
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
    method = data.method ?? (hasUnknown(data) ? unknown('config.method') : target.method ?? 'GET');
  } else return {value:unknown('unsupported client member')};
  return {method,url,data};
}
