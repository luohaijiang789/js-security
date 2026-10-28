// A supplied deployment base is context, not evidence of an observed request.
export function deploymentUrl(value) {
  if(value==null)return null;
  if(typeof value!=='string'||!/^https?:\/\//i.test(value)||/[{}\s\\]/.test(value))throw new Error('deploymentUrl 必须是无凭据的 HTTP/HTTPS 页面绝对地址');
  const url=new URL(value);
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('deploymentUrl 必须是无凭据的 HTTP/HTTPS 页面绝对地址');
  // Hash routing is not the browser document base. Keep search for ?query requests.
  url.hash='';return url.href;
}

export function deploymentAddress(stage,base=null) {
  const gaps=[],codeHost=stage.address?.host??null;
  const result={host:codeHost,hostBasis:codeHost?'static-code':'unknown',hostState:codeHost?(stage.address?.hostState??'resolved'):'unknown',resolvedUrl:null,deploymentUrl:base,gaps};
  const input=stage.url;
  if(typeof input!=='string'||/[{}\s\\]/.test(input)) {
    gaps.push('URL 含动态占位或不支持的字符，未使用部署上下文补全');return result;
  }
  const absolute=/^https?:\/\//i.test(input),networkRelative=input.startsWith('//');
  if(!absolute&&!networkRelative&&/^[a-z][\w+.-]*:/i.test(input)) {
    gaps.push('URL 非 HTTP/HTTPS 请求地址，未使用部署上下文补全');return result;
  }
  if(!absolute&&!base)return result;
  try {
    const url=new URL(input,base??undefined);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('unsupported address');
    if(codeHost&&codeHost!==url.host){gaps.push('代码 Host 与 URL 解析结果冲突，未补全');return result;}
    url.hash='';result.resolvedUrl=url.href;
    result.host=url.host;
    if(!codeHost){result.hostBasis=absolute||networkRelative?'static-code':'deployment-context';result.hostState=result.hostBasis==='deployment-context'?'context-candidate':'resolved';}
    return result;
  } catch {gaps.push('URL 无法安全解析，未使用部署上下文补全');return result;}
}
