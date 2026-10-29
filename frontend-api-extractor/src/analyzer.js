import fs from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';
import glob from 'fast-glob';
import picomatch from 'picomatch';
import {sdkCandidates} from './sdk-candidates.js';
import {newForm,formOperation} from './form-values.js';
import { scriptSource } from './adapters.js';
import { validateConfig } from './config.js';
import { TAG, CHANGES, CLIENT_STATE, UNKNOWN, unknown, hasUnknown, isUnknown, isChoice, text, dynamic, clean, mergeConditions, cloneEnv, createDomain } from './values.js';
import {newHookState,interceptorProperty,inspectHook,hookFieldCandidates} from './request-hooks.js';
import {rememberChange,collectChanges,mergeChanges} from './object-changes.js';
import { libraryClient, requestCall } from './request-clients.js';
import {referencePath,reachableAssets} from './asset-graph.js';
import {addressEvidence,parameterFields,builtinNames,staticOperation} from './request-evidence.js';

function mergeObject(target, source, label = 'spread') {
  if(source?.[CHANGES])target[CHANGES]=mergeChanges(target[CHANGES],source[CHANGES]);
  if (hasUnknown(source)) {
    for (const key of Object.keys(target)) target[key] = unknown(`${label}.${key}`);
    target[UNKNOWN] = source[UNKNOWN];
  }
  if (source && typeof source === 'object' && !isUnknown(source)) for (const [key,value] of Object.entries(source)) Object.defineProperty(target,key,{value,enumerable:true,writable:true,configurable:true});
  return target;
}

function mergeConfig(base, overrides) {
  const result = mergeObject({ ...base }, overrides, 'config');
  for (const key of ['headers', 'params', 'query', 'searchParams']) {
    if (base[key] && overrides?.[key] && typeof base[key] === 'object' && typeof overrides[key] === 'object') result[key] = mergeObject({ ...base[key] }, overrides[key], key);
  }
  return result;
}

export async function analyze(root, options = {}) {
  root = path.resolve(root);
  const config = validateConfig(root, options);
  let hookDiagnosticCodes=null;
  const diagnostics = [], seenDiagnostics = new Set();
  function diagnostic(code, message, node) {
    hookDiagnosticCodes?.push(code);
    const location = node ? locate(node) : undefined;
    const d = { code, message, ...location };
    const k = JSON.stringify(d);
    if (!seenDiagnostics.has(k)) { seenDiagnostics.add(k); diagnostics.push(d); }
  }
  function controlHook(target,args,ctx,node) {
    const state=target.state,key=siteKey(node);
    state.seen.add(key);
    if(ctx.conditions?.length||ctx.discovery==='asset-local')state.gaps.push('conditional or unlinked interceptor control');
    if(target.method==='axios-request-use') {
      const gap=inspectHook(args[0],args[1],args[2],expression=>{
        const root=ts.isPropertyAccessExpression(expression)?expression.expression:expression;
        return !symbol(root)?.declarations?.length&&!lexicalDeclaration(expression,root.getText());
      },symbol,identifier=>{
        const s=symbol(identifier),d=s?.valueDeclaration??s?.declarations?.[0];
        if(d&&d.getSourceFile()===args[0].node.getSourceFile()&&d.pos>=args[0].node.pos&&d.end<=args[0].node.end)return true;
        const value=args[0].env.get(s);
        if(value&&typeof value==='object'&&!isUnknown(value))return false;
        return !d?.initializer||!ts.isObjectLiteralExpression(d.initializer)&&!ts.isArrayLiteralExpression(d.initializer)&&!ts.isNewExpression(d.initializer);
      });
      const registration={id:state.nextId++,fn:args[0],gap,evidence:{kind:'request',...locate(node),expression:node.expression.getText(),state:gap?'unmodeled':'eligible'}};
      state.hooks.push(registration);
      if(!gap){if(!analyzedFunctions.has(args[0].node))analyzedFunctions.set(args[0].node,new Set());analyzedFunctions.get(args[0].node).add(ctx.entry);}
      return registration.id;
    }
    if(target.method==='axios-request-clear'){state.hooks=[];return undefined;}
    if(!Number.isInteger(args[0])){state.gaps.push('eject ID unresolved');return undefined;}
    state.hooks=state.hooks.filter(h=>h.id!==args[0]);return undefined;
  }
  function hookInfo(client,node) {
    const state=client[CLIENT_STATE];
    const controls=[...new Map((client.bindingIds??[]).flatMap(id=>hookControls.get(id)??[]).map(c=>[c.key,c])).values()];
    const topLevel=n=>{for(let p=n.parent;p&&!ts.isSourceFile(p);p=p.parent)if(ts.isFunctionLike(p)||ts.isIfStatement(p)||ts.isBlock(p))return false;return true;};
    const unseen=controls.filter(c=>!state?.seen.has(c.key)&&!(c.node.getSourceFile()===node.getSourceFile()&&c.node.getStart()>node.getStart()&&topLevel(c.node)&&topLevel(node)));
    const registrations=state?.hooks??[];
    return {registrations,hooks:[...registrations.map(h=>h.evidence),...unseen.map(c=>c.evidence)],gaps:[...(state?.gaps??[]),...unseen.map(()=> 'interceptor control not connected to this instance')],observed:Boolean(state?.seen.size||state?.gaps.length||unseen.length)};
  }
  function modelHooks(info,method,url,data,ctx,node) {
    const fail=gap=>({state:'unknown',variants:[],executionOrder:[],gaps:[gap]});
    if(info.gaps.length)return {...fail('interceptor order/registration unresolved'),gaps:[...new Set(info.gaps)]};
    let cfg={...data,method:typeof method==='string'?method.toLowerCase():method,url:url??unknown('url'),headers:data.headers??{}};
    for(const key of [TAG,CLIENT_STATE,'bindingIds','kind','member'])delete cfg[key];
    cfg=cloneEnv(new Map([['cfg',cfg]])).get('cfg');
    const order=[];
    for(const registration of [...info.registrations].reverse()) {
      if(registration.gap)return fail(registration.gap);
      const previous=hookDiagnosticCodes;hookDiagnosticCodes=[];
      let result,codes;
      try {result=invoke({...registration.fn,env:cloneEnv(registration.fn.env)},[cfg],{...ctx,hookEvaluation:true},node);codes=hookDiagnosticCodes;}
      finally {hookDiagnosticCodes=previous;}
      if(codes.length)return fail('hook evaluation gap: '+[...new Set(codes)].join(', '));
      if(!result||typeof result!=='object'||isUnknown(result)||isChoice(result)||result[TAG]||!Object.hasOwn(result,'url')||!Object.hasOwn(result,'method'))return fail('hook did not return a supported config object');
      cfg=result;order.push(registration.evidence);
    }
    const variants=[];
    for(const option of expand(cfg,node)) {
      if(isUnknown(option.value))return fail('hook result candidates unresolved');
      const conditions=mergeConditions(ctx.conditions??[],option.conditions);if(!conditions)continue;
      const value=option.value,requestUrl=clean(value.url??unknown('url')),base=clean(value.baseURL??null);
      let effective=text(requestUrl);
      if(base&&!/^([a-z]+:)?\/\//i.test(effective))effective=`${text(base).replace(/\/$/,'')}/${effective.replace(/^\//,'')}`;
      const fields={query:value.params??null,body:value.data??value.body??null,headers:value.headers??null};
      const payloadFields={...fields},serializationInputFields=[];
      if(fields.body?.[TAG]==='serialized') {
        serializationInputFields.push(...parameterFields({body:fields.body.input},null).map(f=>({...f,stage:'serialization-input'})));
        const encoded=fields.body.value;
        if(typeof encoded==='string'){try{payloadFields.body=JSON.parse(encoded);}catch{payloadFields.body=unknown('encoded body structure');}}
        else payloadFields.body=encoded===undefined?undefined:unknown('encoded body structure');
      }
      const address={...addressEvidence(requestUrl,base,effective),stage:'after-request-hooks'};
      const changes=collectChanges(value,fields).map(c=>({...c,stage:'after-request-hooks'}));
      const methodValue=clean(value.method??unknown('method'));
      variants.push({method:isUnknown(methodValue)?text(methodValue):String(methodValue).toUpperCase(),url:effective,address,...clean(fields),parameterFields:parameterFields(payloadFields,requestUrl).map(f=>({...f,stage:'after-request-hooks'})),serializationInputFields,objectChanges:changes,conditions,resolution:dynamic({requestUrl,method:value.method,base,...fields,spread:value[UNKNOWN]})||conditions.length?'partial':'resolved'});
    }
    return {state:'modeled',variants,executionOrder:order,gaps:[],scope:'supported synchronous request interceptors; before Axios transport/transformRequest'};
  }
  const {choice,expand,lift,references,liftRefs} = createDomain(config.maxCandidates,diagnostic);
  const branch = (node,outcome) => ({expression:node.getText(),outcome,...locate(node)});
  const branchContext = (ctx,condition) => {
    const conditions = mergeConditions(ctx.conditions ?? [],[condition]);
    return conditions ? {...ctx,conditions} : null;
  };
  const files = (await glob(config.include, { cwd: root, ignore: config.exclude, absolute: true, onlyFiles: true, followSymbolicLinks: false })).sort();
  const sources = new Map();
  const assetInputs = new Map();
  for (const file of files) {
    try {const raw=fs.readFileSync(file,'utf8');assetInputs.set(file,{sha256:createHash('sha256').update(raw).digest('hex')});sources.set(file,scriptSource(file,raw));}
    catch (e) { diagnostic('FRAMEWORK_PARSE_ERROR', `${path.relative(root, file)}: ${e.message}`); }
  }
  let compilerOptions = {};
  const configFile = ['tsconfig.json', 'jsconfig.json'].map(n => path.join(root, n)).find(fs.existsSync);
  if (configFile) {
    const parsed = ts.readConfigFile(configFile, ts.sys.readFile);
    if (parsed.error) diagnostic('CONFIG_ERROR', ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n'));
    else {
      const result = ts.parseJsonConfigFileContent(parsed.config, ts.sys, root);
      compilerOptions = result.options;
      for (const err of result.errors.filter(e => e.code !== 18003)) diagnostic('CONFIG_ERROR', ts.flattenDiagnosticMessageText(err.messageText, '\n'));
    }
  }
  compilerOptions = { ...compilerOptions, allowJs: true, checkJs: false, noEmit: true, noLib: true, types: [], allowNonTsExtensions: true, jsx: ts.JsxEmit.Preserve,
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    ...(config.aliases ? { baseUrl: compilerOptions.baseUrl ?? root,
      paths: { ...compilerOptions.paths, ...Object.fromEntries(Object.entries(config.aliases).map(([key, targets]) => [key, targets.map(target => path.resolve(root, target))])) } } : {}) };
  const host = ts.createCompilerHost(compilerOptions);
  const originalGet = host.getSourceFile.bind(host);
  host.getSourceFile = (file, language, onError, create) => sources.has(file)
    ? ts.createSourceFile(file, sources.get(file), language, true, /\.(jsx|js)$/.test(file) ? ts.ScriptKind.JSX : /\.(cjs|mjs)$/.test(file) ? ts.ScriptKind.JS : /\.tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    : originalGet(file, language, onError, create);
  host.resolveModuleNames = (names, containing) => names.map(name => {
    // TypeScript's default resolver does not load .vue/.svelte modules.
    if (/\.(vue|svelte)$/.test(name) && name.startsWith('.')) {
      const file = path.resolve(path.dirname(containing), name);
      if (sources.has(file)) return { resolvedFileName: file, extension: ts.Extension.Ts };
    }
    return ts.resolveModuleName(name, containing, compilerOptions, host).resolvedModule;
  });
  const program = ts.createProgram([...sources.keys()], compilerOptions, host);
  const checker = program.getTypeChecker();
  const axiosLibraryStates=new Map(),jqueryLibraryStates=new Map();
  const knownLibrary=(name,member,ctx)=>{
    const value=libraryClient(name,member);
    if(config.modelRequestHooks&&value?.kind==='axios') {
      if(!axiosLibraryStates.has(ctx.entry))axiosLibraryStates.set(ctx.entry,newHookState());
      value[CLIENT_STATE]=axiosLibraryStates.get(ctx.entry);
    }
    if(value?.kind==='jquery'){if(!jqueryLibraryStates.has(ctx.entry))jqueryLibraryStates.set(ctx.entry,{uncertain:false});value.jqueryState=jqueryLibraryStates.get(ctx.entry);}
    return value;
  };
  const angularFactories=new Map(),activeServices=new Set();
  for(const file of sources.keys()){
   const sf=program.getSourceFile(file);const visit=n=>{if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&n.expression.name.text==='factory'&&ts.isStringLiteralLike(n.arguments[0]??{})&&ts.isArrayLiteralExpression(n.arguments[1]??{})){
    const array=n.arguments[1].elements,fn=array.at(-1),name=n.arguments[0].text;
    if((ts.isFunctionExpression(fn)||ts.isArrowFunction(fn))&&array.slice(0,-1).every(ts.isStringLiteralLike)&&n.expression.expression.getText().replaceAll(/\s/g,'').startsWith('angular.module(')){if(!angularFactories.has(name))angularFactories.set(name,[]);angularFactories.get(name).push({fn,names:array.slice(0,-1).map(a=>a.text)});}
   }ts.forEachChild(n,visit);};visit(sf);
  }
  function angularService(name,env,ctx,node){
   const list=angularFactories.get(name)??[];
   if(list.length!==1||activeServices.has(name)){diagnostic('ANGULAR_DI_UNRESOLVED','DI服务缺失、重复或循环: '+name,node);return unknown(name);}
   activeServices.add(name);try{const {fn,names}=list[0],args=names.map(dep=>{const client=config.clients.find(c=>c.name===dep);return client?{[TAG]:'client',kind:client.kind??'axios'}:config.angularServices.includes(dep)?angularService(dep,env,ctx,node):unknown('DI '+dep);});return invoke({[TAG]:'function',node:fn,env},args,ctx,node);}finally{activeServices.delete(name);}
  }
  const mutableWrites=new Set();
  const assets=files.map(file=>{
    const sf=program.getSourceFile(file),imports=[];
    if(sf && sources.has(file)) {
      const visit=node=>{
        if(ts.isBinaryExpression(node) && node.operatorToken.kind>=ts.SyntaxKind.FirstAssignment && node.operatorToken.kind<=ts.SyntaxKind.LastAssignment && ts.isIdentifier(node.left))mutableWrites.add(symbol(node.left));
        let specifier,kind;
        if((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier){specifier=node.moduleSpecifier;kind=ts.isImportDeclaration(node)?'import':'re-export';}
        else if(ts.isCallExpression(node) && (node.expression.kind===ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text==='require' && !symbol(node.expression)?.declarations?.some(d=>sources.has(d.getSourceFile().fileName)))){specifier=node.arguments[0];kind=node.expression.kind===ts.SyntaxKind.ImportKeyword?'dynamic-import':'require';}
        if(specifier){
          const literal=ts.isStringLiteralLike(specifier),name=literal?specifier.text:specifier.getText();
          const resolved=literal?host.resolveModuleNames([name],file)[0]?.resolvedFileName:null;
          imports.push({specifier:name,kind,typeOnly:Boolean(node.isTypeOnly || node.importClause?.isTypeOnly),...locate(specifier),resolvedFile:resolved&&sources.has(resolved)?path.relative(root,resolved).split(path.sep).join('/'):null,
            state:!literal?'dynamic':resolved&&sources.has(resolved)?'internal':/^https?:/.test(name)?'external-not-fetched':'unresolved-or-unscanned'});
        }
        ts.forEachChild(node,visit);
      };visit(sf);
    }
    return {file:path.relative(root,file).split(path.sep).join('/'),...assetInputs.get(file),parseStatus:!sources.has(file)?'failed':sf&&program.getSyntacticDiagnostics(sf).length?'error':'parsed',imports};
  });
  for (const sf of program.getSourceFiles().filter(s => sources.has(s.fileName))) {
    for (const d of program.getSyntacticDiagnostics(sf)) diagnostic('SCRIPT_PARSE_ERROR', ts.flattenDiagnosticMessageText(d.messageText, '\n'), d.start == null ? sf : { getSourceFile: () => sf, getStart: () => d.start });
  }
  function locate(node) {
    const sf = node.getSourceFile();
    const pos = sf.getLineAndCharacterOfPosition(node.getStart());
    const file = path.relative(root, sf.fileName).split(path.sep).join('/');
    const layers = config.layers.filter(l => picomatch(l.match)(file)).map(l => l.name);
    return { file, line: pos.line + 1, column: pos.character + 1, layers };
  }
  function symbol(node) {
    let s = ts.isIdentifier(node) && ts.isShorthandPropertyAssignment(node.parent)
      ? checker.getShorthandAssignmentValueSymbol(node.parent) : checker.getSymbolAtLocation(node);
    if (s?.flags & ts.SymbolFlags.Alias && !s.declarations?.some(d=>ts.isVariableDeclaration(d)||ts.isBindingElement(d))) {
      try { const resolved = checker.getAliasedSymbol(s); if (resolved?.declarations?.length) s = resolved; } catch {}
    }
    return s;
  }
  function lexicalDeclaration(node,name) {
    // TS treats globalThis specially even when a script declares a local name.
    for (let scope=node.parent; scope; scope=scope.parent) {
      if (scope.locals?.get(name)?.declarations?.length) return true;
    }
    return false;
  }
  const bindingId = node => {
    let d=symbol(node)?.valueDeclaration ?? symbol(node)?.declarations?.[0];
    const seen=new Set();
    while(d && !seen.has(d) && ts.isVariableDeclaration(d) && d.initializer && ts.isIdentifier(d.initializer)) {
      seen.add(d); const next=symbol(d.initializer)?.valueDeclaration;
      if(!next)break; d=next;
    }
    return d ? `${d.getSourceFile().fileName}:${d.getStart()}` : null;
  };
  const hookRegistrations=new Map(),hookControls=new Map();
  const siteKey=node=>`${node.getSourceFile().fileName}:${node.getStart()}`;
  const access=node=>ts.isPropertyAccessExpression(node)?{object:node.expression,name:node.name.text}:ts.isElementAccessExpression(node)&&node.argumentExpression&&ts.isStringLiteralLike(node.argumentExpression)?{object:node.expression,name:node.argumentExpression.text}:null;
  for(const sf of program.getSourceFiles().filter(s=>sources.has(s.fileName))) {
    const visit=node=>{
      if(ts.isCallExpression(node)) {
        const use=access(node.expression),request=use&&access(use.object),interceptors=request&&access(request.object);
        if(use&&['use','eject','clear'].includes(use.name)&&request?.name==='request'&&interceptors?.name==='interceptors') {
          const id=bindingId(interceptors.object);
          if(id){
            const evidence={kind:'request',...locate(node),expression:node.expression.getText(),state:'unmodeled',fieldCandidates:hookFieldCandidates(node.arguments[0],locate,checker)};
            if(!hookControls.has(id))hookControls.set(id,[]);hookControls.get(id).push({node,key:siteKey(node),evidence});
            if(use.name==='use'){if(!hookRegistrations.has(id))hookRegistrations.set(id,[]);hookRegistrations.get(id).push(evidence);}
          }
        }
      }
      ts.forEachChild(node,visit);
    };visit(sf);
  }
  const attachBinding=(value,node)=>isChoice(value) ? lift([value],v=>attachBinding(v,node),node) : value?.[TAG]==='client' ? {...value,bindingIds:[...new Set([...(value.bindingIds??[]),bindingId(node)].filter(Boolean))]} : value;
  const endpoints = new Map(),assetCandidateMap=new Map(),observedSinks=new Set();
  const sinkKey=node=>`${node.getSourceFile().fileName}:${node.getStart()}`;
  const analyzedFunctions = new Map();
  let steps = 0, exhausted = false, currentPartition=null;
  // Unwind nested evaluators immediately instead of propagating fabricated return values.
  const partitions=[],budgetStop=Symbol('budget stop');
  function tick(node) {
    if(steps>=config.maxSteps) {
      if(!exhausted)diagnostic('BUDGET_EXCEEDED',`达到 maxSteps=${config.maxSteps}，结果不完整`,node);
      exhausted=true;
      currentPartition.reason='global-budget';
      throw budgetStop;
    }
    if(currentPartition.steps>=currentPartition.limit) {
      currentPartition.reason='partition-budget';
      diagnostic('PARTITION_BUDGET_EXCEEDED',`分区 ${currentPartition.file} 达到求值预算 ${currentPartition.limit}，继续分析其他文件；本分区不完整`,node);
      throw budgetStop;
    }
    steps++;currentPartition.steps++;
    return true;
  }
  function record(node, client, method, url, data, ctx) {
    if(ctx.discovery==='asset-local' && observedSinks.has(sinkKey(node)))return;
    if(ctx.discovery!=='asset-local')observedSinks.add(sinkKey(node));
    const collector=ctx.discovery==='asset-local'?assetCandidateMap:endpoints;
    data = mergeConfig(client, data);
    const urlValue=clean(url??unknown('url'));
    const rawUrl=urlValue&&typeof urlValue==='object'&&!isUnknown(urlValue)?unknown('non-string request URL'):urlValue;
    method = clean(method);
    let effective = text(rawUrl);
    const base = clean(data.baseURL ?? client.baseURL);
    if (base && !/^([a-z]+:)?\/\//i.test(effective)) effective = `${text(base).replace(/\/$/, '')}/${effective.replace(/^\//, '')}`;
    const verb = isUnknown(method) ? text(method) : String(method ?? 'GET').toUpperCase();
    // An unknown config spread may contain carriers we have not seen. Absence in
    // the abstract object is not proof that the request has no such fields.
    const missingCarrier=name=>hasUnknown(data)?unknown(`config.${name}`):null;
    const constructed = { query: data.params !== undefined ? data.params : missingCarrier('params'), body: data.data !== undefined ? data.data : data.body !== undefined ? data.body : missingCarrier('body'), headers: data.headers !== undefined ? data.headers : missingCarrier('headers') };
    const info=config.modelRequestHooks?hookInfo(client,node):null;
    const hooks=info?info.hooks:[...new Map((client.bindingIds??[]).flatMap(id=>hookRegistrations.get(id)??[]).map(h=>[JSON.stringify(h),h])).values()];
    const address=addressEvidence(rawUrl,base,effective,hooks);
    const extractedFields=parameterFields(constructed,isUnknown(rawUrl)?null:rawUrl);
    const objectChanges=collectChanges(data,constructed);
    if(objectChanges.some(c=>c.operation==='history-truncated'))diagnostic('OBJECT_CHANGE_LIMIT','对象改写证据有截断，不代表完整历史',node);
    const hookEvidence={hookFieldCandidates:hooks.flatMap(h=>h.fieldCandidates??[]),address,parameterFields:extractedFields,objectChanges,parameterStage:"call-site",postHookState:hooks.length ? "unknown" : "not-observed",hooks};
    const fields = clean(constructed);
    const unresolved = [];
    for (const [key, value] of Object.entries({ url: rawUrl, method, baseURL: base, ...fields, spread: data[UNKNOWN] })) {
      if (dynamic(constructed[key]?.[TAG]==='serialized'?constructed[key]:value) || key === 'spread' && value) unresolved.push(key === 'spread' ? `未知配置展开: ${value}` : `${key} 含动态值`);
    }
    if(ctx.discovery==='asset-local')unresolved.push('业务入口未连接，值仅为资产级局部候选');
    if(hooks.length||info?.observed){unresolved.push(config.modelRequestHooks?'request hook 后结果另见 afterRequestHooks':'request hook 未建模，Host/URL/参数可能继续变化');if(!config.modelRequestHooks)diagnostic('REQUEST_HOOK_UNMODELED','检测到可能的请求拦截器；仅报告调用处构造值',node);}
    if(client.compiledModel)unresolved.push('固定编译客户端facade契约候选；依赖实现与transport未证明');
    if (ctx.conditions?.length) unresolved.push('接口属于条件分支候选');
    const resolution = isUnknown(rawUrl) ? 'unresolved' : unresolved.length ? 'partial' : 'resolved';
    const key = JSON.stringify([verb, effective]);
    const linkage={linkState:ctx.discovery==='asset-local'?'unlinked':ctx.functionInventory?'function-inventory':'entry-trace',referencedBy:ctx.referencedBy??[],assetPath:referencePath(assets,ctx.entry,locate(node).file)};
    const usage = { ...linkage, ...(client.compiledModel?{clientModel:client.compiledModel}:{}), entry: ctx.entry, callChain: [...ctx.chain, { symbol: node.expression.getText(), ...locate(node) }], unresolved, conditions:ctx.conditions ?? [], resolution, ...fields, ...hookEvidence };
    if (!collector.has(key)) collector.set(key, { method: verb, url: effective, resolution, ...fields, ...hookEvidence, usages: [] });
    const ep = collector.get(key);
    if(hooks.length){ep.postHookState='unknown';ep.hooks=[...new Map([...ep.hooks,...hooks].map(h=>[JSON.stringify(h),h])).values()];if(ep.address.host)ep.address={...ep.address,hostState:'partial'};}
    if ({resolved:0,partial:1,unresolved:2}[resolution] > {resolved:0,partial:1,unresolved:2}[ep.resolution]) ep.resolution = resolution;
    if (!ep.usages.some(u => JSON.stringify(u) === JSON.stringify(usage))) ep.usages.push(usage);
    if(info?.observed) {
      // Keep the call-site result even if hook evaluation hits the shared budget.
      const after={state:'unknown',variants:[],executionOrder:[],gaps:['hook evaluation interrupted']};
      usage.afterRequestHooks=after;
      Object.assign(after,modelHooks(info,method,url,data,ctx,node));
      usage.postHookState=after.state==='modeled'?'modeled':'unknown';
      ep.postHookState=ep.usages.some(u=>u.postHookState==='unknown')?'unknown':ep.usages.some(u=>u.postHookState==='modeled')?'modeled':'not-observed';
      if(after.state==='unknown')diagnostic('REQUEST_HOOK_UNMODELED',after.gaps.join('; '),node);
    }
  }
  function clientImport(s,ctx) {
    for (const d of s?.declarations ?? []) {
      let p = d;
      while (p && !ts.isImportDeclaration(p)) p = p.parent;
      if (p) return knownLibrary(p.moduleSpecifier.text,ts.isImportSpecifier(d) ? d.propertyName?.text ?? d.name.text : ts.isNamespaceImport(d) ? '*' : 'default',ctx);
    }
  }
  function bind(pattern, value, env, ctx) {
    if (ts.isIdentifier(pattern)) { env.set(symbol(pattern), attachBinding(value,pattern)); return; }
    for (const [index, element] of pattern.elements.entries()) {
      if (!ts.isBindingElement(element)) continue;
      const key = ts.isArrayBindingPattern(pattern) ? index : element.propertyName?.text ?? element.name.text;
      let selected;
      if (element.dotDotDotToken && !isUnknown(value) && value != null) {
        selected = ts.isArrayBindingPattern(pattern) ? value.slice(index) : Object.fromEntries(Object.entries(value).filter(([k]) => !pattern.elements.some(e => !e.dotDotDotToken && (e.propertyName?.text ?? e.name?.text) === k)));
      } else if(value?.[TAG]==='module')selected=moduleExport(value,key,env,ctx,element);
      else if (value?.[TAG] === 'client') selected = { ...value, member: String(key) };
      else if (isUnknown(value) || value == null) selected = unknown(`${text(value)}.${key}`);
      else selected = value[key];
      if (selected === undefined && element.initializer) selected = evaluate(element.initializer, env, ctx);
      if (selected === undefined && hasUnknown(value)) selected = unknown(`${value[UNKNOWN]}.${key}`);
      bind(element.name, selected, env, ctx);
    }
  }
  function requireModule(node, env, ctx, visiting) {
    const name = node.arguments[0];
    if (!name || !ts.isStringLiteralLike(name)) { diagnostic('DYNAMIC_REQUIRE', '无法解析动态 require', node); return unknown(node.getText()); }
    const library = knownLibrary(name.text,'default',ctx);
    if (library) return library;
    const resolved = ts.resolveModuleName(name.text, node.getSourceFile().fileName, compilerOptions, host).resolvedModule?.resolvedFileName;
    if (!resolved || !sources.has(resolved)) { diagnostic('UNRESOLVED_MODULE', `未扫描的 require 模块 ${name.text}`, node); return unknown(node.getText()); }
    const compiled=config.compiledClients.find(c=>c.file===path.relative(root,resolved).split(path.sep).join('/'));
    if(compiled){if(assetInputs.get(resolved)?.sha256===compiled.sha256){diagnostic('COMPILED_CLIENT_MODEL','采用固定哈希的'+compiled.module+' facade契约（参考'+compiled.version+'）；安装版本/依赖及最终transport未证明',node);return {...knownLibrary(compiled.module,'default',ctx),compiledModel:compiled};}diagnostic('COMPILED_CLIENT_HASH_MISMATCH','编译客户端哈希不匹配，拒绝采用契约',node);}
    if (ctx.modules?.has(resolved)) { diagnostic('MODULE_CYCLE', '循环 require 已截断', node); return unknown('circular require'); }
    const next = { ...ctx, modules: new Set(ctx.modules).add(resolved) };
    const sf = program.getSourceFile(resolved), local = new Map();
    let result = {};
    // Deliberately inspect assignments without executing the target module.
    for (const statement of sf.statements) {
      if(!ts.isExpressionStatement(statement))continue;let assignment=statement.expression;while(ts.isParenthesizedExpression(assignment))assignment=assignment.expression;
      if(!ts.isBinaryExpression(assignment)||assignment.operatorToken.kind!==ts.SyntaxKind.EqualsToken)continue;
      const left = assignment.left.getText().replaceAll(/\s/g, '');
      if (left === 'module.exports') result = evaluate(assignment.right, local, next, visiting);
      else if (/^(module\.exports|exports)\.[\w$]+$/.test(left)) {
        if (isUnknown(result)) continue;
        result[left.split('.').at(-1)] = evaluate(assignment.right, local, next, visiting);
      }
    }
    return result;
  }
  const activeExports=new Set();
  function moduleExport(namespace,name,env,ctx,node) {
    if(isUnknown(name)){diagnostic('DYNAMIC_EXPORT_UNRESOLVED','模块导出名无法确定',node);return unknown('dynamic export');}
    const key=namespace.file+':'+String(name);
    if(activeExports.has(key)){diagnostic('MODULE_EXPORT_CYCLE','模块导出初始化循环，值保持未知',node);return unknown('cyclic export');}
    activeExports.add(key);
    try {
    const sf=program.getSourceFile(namespace.file);
    const moduleSymbol=checker.getSymbolAtLocation(sf) ?? sf.symbol;
    let exported=moduleSymbol && checker.getExportsOfModule(moduleSymbol).find(s=>s.name===String(name));
    if(exported?.flags & ts.SymbolFlags.Alias){try{exported=checker.getAliasedSymbol(exported);}catch{}}
    const d=exported?.valueDeclaration ?? exported?.declarations?.[0];
    if(!d)for(const statement of sf.statements){
      if(!ts.isExpressionStatement(statement))continue;let assignment=statement.expression;while(ts.isParenthesizedExpression(assignment))assignment=assignment.expression;
      if(!ts.isBinaryExpression(assignment)||assignment.operatorToken.kind!==ts.SyntaxKind.EqualsToken)continue;
      const left=assignment.left.getText().replaceAll(/\s/g,'');
      if(left==='exports.'+name||left==='module.exports.'+name)return evaluate(assignment.right,new Map(),ctx);
      if(left==='module.exports'){const value=evaluate(assignment.right,new Map(),ctx);return name==='default'?value:value&&typeof value==='object'&&Object.hasOwn(value,name)?value[name]:unknown('CommonJS export '+String(name));}
    }
    if(!d || !sources.has(d.getSourceFile().fileName)){diagnostic('MODULE_EXPORT_UNRESOLVED',`未取得模块导出 ${String(name)}`,node);return unknown(`export ${String(name)}`);}
    if(ts.isFunctionDeclaration(d))return evaluate(d,env,ctx);
    if(ts.isVariableDeclaration(d))return evaluate(d.name,env,ctx);
    if(ts.isExportAssignment(d))return evaluate(d.expression,env,ctx);
    diagnostic('MODULE_EXPORT_UNRESOLVED',`暂不支持该模块导出形态 ${String(name)}`,node);
    return unknown(`export ${String(name)}`);
    }finally{activeExports.delete(key);}
  }
  function dynamicModule(node,env,ctx,visiting) {
    const argument=node.arguments[0];
    if(!argument){diagnostic('DYNAMIC_IMPORT_UNRESOLVED','动态 import 缺少路径',node);return unknown('import');}
    return lift([evaluate(argument,env,ctx,visiting)],specifier=>{
      const resolved=typeof specifier==='string' && !dynamic(specifier) ? host.resolveModuleNames([specifier],node.getSourceFile().fileName)[0]?.resolvedFileName : null;
      if(!resolved || !sources.has(resolved)){diagnostic('DYNAMIC_IMPORT_UNRESOLVED','动态模块未解析或不在扫描范围内，不自动下载',node);return unknown(node.getText());}
      const asset=assets.find(a=>a.file===locate(node).file),relative=path.relative(root,resolved).split(path.sep).join('/');
      if(asset && !asset.imports.some(i=>i.resolvedFile===relative && i.line===locate(argument).line && i.column===locate(argument).column))asset.imports.push({kind:'dynamic-import',specifier:argument.getText(),resolvedSpecifier:specifier,...locate(argument),resolvedFile:relative,state:'computed-internal'});
      return {[TAG]:'module-promise',namespace:{[TAG]:'module',file:resolved}};
    },node);
  }
  function mergeExpressionEffects(scope,paths,node) {
    const signature=value=>JSON.stringify(clean(value && typeof value==='object' && value[TAG]!=='function'?Object.fromEntries(Object.entries(value)):value));
    for(const key of new Set(paths.flatMap(p=>[...p.env.keys()]))) {
      const before=scope.get(key);
      if(paths.every(p=>p.env.get(key)===before || signature(p.env.get(key))===signature(before)))continue;
      scope.set(key,choice(paths.map(p=>({value:p.env.get(key),conditions:p.conditions})),node));
    }
  }
  function effect(ctx,kind) {
    for(let frame=ctx.effectFrame;frame;frame=frame.parent)frame[kind]=true;
  }
  const trackChange=(target,event,node)=>rememberChange(target,event,()=>diagnostic('OBJECT_CHANGE_LIMIT','单对象改写证据超过 128 条，历史已截断，当前值仍按模型求值',node));
  function invalidateObject(target,reason,node,ctx,seen=new Set()) {
    if(target?.[TAG]==='instance'){invalidateObject(target.properties,reason,node,ctx,seen);return;}
    if(!target || typeof target!=='object' || target[TAG] || isUnknown(target) || seen.has(target))return;
    seen.add(target);
    effect(ctx,'mutated');
    if(isChoice(target)){for(const option of references([target],node))if(!isUnknown(option.value))invalidateObject(option.value[0],reason,node,ctx,seen);return;}
    for(const value of Object.values(target))invalidateObject(value,reason,node,ctx,seen);
    for(const key of Object.keys(target))Object.defineProperty(target,key,{value:unknown(`${reason}.${key}`),enumerable:true,writable:true,configurable:true});
    target[UNKNOWN]=reason;
    trackChange(target,{operation:'unknown-write',key:null,expression:node.getText(),conditions:ctx.conditions??[],...locate(node)},node);
  }
  function propertyReference(node,env,ctx,visiting) {
    return {target:evaluate(node.expression,env,ctx,visiting),key:ts.isPropertyAccessExpression(node)?node.name.text:evaluate(node.argumentExpression,env,ctx,visiting),scope:env};
  }
  function writeProperty(reference,value,node,ctx,operation='set') {
    let {target,key}=reference;
    if(target?.[TAG]==='function'){
      if(typeof key==='string'&&['bind','call','apply'].includes(key)){target.functionMembers??={};if(operation==='delete')delete target.functionMembers[key];else target.functionMembers[key]=value;effect(ctx,'mutated');return;}
      target.functionMembersUnknown=true;diagnostic('FUNCTION_MEMBER_UNMODELED','函数属性动态或未支持改写，call/apply/bind不再假设原生',node);return;
    }
    if(target?.[TAG]==='instance')target=target.properties;
    if(!target || typeof target!=='object' || target[TAG] || isUnknown(target)&&!target[CHANGES]) {
      if(config.modelRequestHooks&&target?.[CLIENT_STATE])target[CLIENT_STATE].gaps.push('unsupported client/defaults write');
      diagnostic('UNRESOLVED_ASSIGNMENT','无法确定属性改写对象',node);return;
    }
    effect(ctx,'mutated');
    if(isChoice(target) || isChoice(key) || isUnknown(key) || !['string','number'].includes(typeof key)) {
      invalidateObject(target,'dynamic property mutation',node,ctx);
      if(isChoice(target))for(const value of reference.scope?.values()??[])invalidateObject(value,'ambiguous mutation alias',node,ctx);
      diagnostic('DYNAMIC_PROPERTY_MUTATION','属性目标或键不确定，可能覆盖/删除的字段保持未知',node);return;
    }
    const name=String(key),previous=Object.hasOwn(target,name)?clean(target[name]):undefined;
    if(Array.isArray(target)&&name==='length') {
      if(operation!=='delete'&&Number.isInteger(value)&&value>=0&&value<=config.maxCandidates)target.length=value;
      else {
        diagnostic('ARRAY_WRITE_UNMODELED','数组 length 删除、动态值或长度超限，保留未知数组',node);
        invalidateObject(target,'array length mutation',node,ctx);if(!target.length)target.push(unknown('array length mutation'));
        return;
      }
    } else if(Array.isArray(target)&&/^(0|[1-9]\d*)$/.test(name)&&Number(name)>=config.maxCandidates&&Number(name)<4294967295) {
      diagnostic('ARRAY_WRITE_UNMODELED','数组索引写入超出 maxCandidates，保留未知数组',node);
      invalidateObject(target,'array index mutation',node,ctx);if(!target.length)target.push(unknown('array index mutation'));return;
    }
    else if(operation==='delete')delete target[name];
    else Object.defineProperty(target,name,{value,enumerable:true,writable:true,configurable:true});
    trackChange(target,{operation,key:name,previous,...(operation==='delete'?{}:{value:clean(value)}),expression:node.getText(),conditions:ctx.conditions??[],...locate(node)},node);
  }
  function ownValue(object,key,node){
    if(object!=null&&Object.hasOwn(object,key))return object[key];
    if(object&&typeof object==='object'&&!object[TAG]&&!hasUnknown(object)&&!['constructor','toString','valueOf','hasOwnProperty','isPrototypeOf','propertyIsEnumerable','toLocaleString','__proto__'].includes(String(key)))return undefined;
    return unknown(node.getText());
  }
  function functionMember(object,key,node){
    const fn=object?.[TAG]==='function'?object:object?.[TAG]==='intrinsic'&&object.method==='bound-instance'?object.fn:null;
    if(!fn||!['call','apply','bind'].includes(key))return null;
    if(fn.functionMembersUnknown)return unknown('function member overwritten');
    if(Object.hasOwn(fn.functionMembers??{},key)){const member=fn.functionMembers[key],direct=ts.isCallExpression(node.parent)&&node.parent.expression===node;return direct&&member?.[TAG]==='function'&&!ts.isArrowFunction(member.node)?{[TAG]:'intrinsic',method:'bound-object',receiver:fn,fn:member}:member;}
    return {[TAG]:'intrinsic',method:'function-'+key,receiver:fn};
  }
  function memberValue(object,key,node){
    const member=ownValue(object,key,node),direct=ts.isCallExpression(node.parent)&&node.parent.expression===node;
    if(direct&&member?.[TAG]==='function'&&!ts.isArrowFunction(member.node))return {[TAG]:'intrinsic',method:'bound-object',receiver:object,fn:member};
    if(direct&&(isUnknown(member)||member==null))return {[TAG]:'intrinsic',method:'unknown-member',receiver:object};
    return member;
  }
  function evaluate(node, env, ctx, visiting = new Set()) {
    if (!node || !tick(node)) return unknown('missing');
    if(ts.isAwaitExpression(node))return lift([evaluate(node.expression,env,ctx,visiting)],value=>value?.[TAG]==='module-promise'?value.namespace:value,node);
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) return evaluate(node.expression, env, ctx, visiting);
    if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return ts.isNumericLiteral(node) ? Number(node.text) : node.text;
    if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if(ts.isDeleteExpression(node)) {
      if(ts.isPropertyAccessExpression(node.expression) || ts.isElementAccessExpression(node.expression)){writeProperty(propertyReference(node.expression,env,ctx,visiting),undefined,node,ctx,'delete');return true;}
      diagnostic('UNRESOLVED_ASSIGNMENT','delete 目标不受支持',node);return unknown(node.getText());
    }
    if (ts.isIdentifier(node) && node.text === 'undefined' && !symbol(node)?.valueDeclaration) return undefined;
    if(node.kind===ts.SyntaxKind.ThisKeyword)return ctx.thisValue??unknown('this');
    if(ts.isClassExpression(node)||ts.isClassDeclaration(node))return {[TAG]:'class',node,env};
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) return { [TAG]: 'function', node, env,...(ts.isArrowFunction(node)?{lexicalThis:ctx.thisValue??unknown('lexical this')}: {}) };
    if((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && [ts.SyntaxKind.PlusPlusToken,ts.SyntaxKind.MinusMinusToken].includes(node.operator)) {
      if(ts.isPropertyAccessExpression(node.operand) || ts.isElementAccessExpression(node.operand))writeProperty(propertyReference(node.operand,env,ctx,visiting),unknown(node.getText()),node,ctx);
      else if(ts.isIdentifier(node.operand))env.set(symbol(node.operand),unknown(node.getText()));
      diagnostic('UNRESOLVED_ASSIGNMENT','自增/自减尚未建模，改写值保持未知',node);return unknown(node.getText());
    }
    if (ts.isPrefixUnaryExpression(node)) {
      const value = evaluate(node.operand,env,ctx,visiting);
      return lift([value],v => isUnknown(v) ? unknown(node.getText()) : node.operator === ts.SyntaxKind.ExclamationToken ? !v : node.operator === ts.SyntaxKind.MinusToken ? -v : node.operator === ts.SyntaxKind.PlusToken ? +v : unknown(node.getText()),node);
    }
    if (ts.isTemplateExpression(node)) {
      let value = node.head.text;
      for (const span of node.templateSpans) value = lift([value,evaluate(span.expression,env,ctx,visiting)],(a,b) => text(a)+text(b)+span.literal.text,node);
      return value;
    }
    if(ts.isBinaryExpression(node) && node.operatorToken.kind===ts.SyntaxKind.CommaToken){evaluate(node.left,env,ctx,visiting);return evaluate(node.right,env,ctx,visiting);}
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const reference=ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)?propertyReference(node.left,env,ctx,visiting):null;
      const value = evaluate(node.right,env,ctx,visiting);
      if (ts.isIdentifier(node.left)) env.set(symbol(node.left),value);
      else if(reference)writeProperty(reference,value,node,ctx);
      return value;
    }
    if(ts.isBinaryExpression(node) && node.operatorToken.kind>=ts.SyntaxKind.FirstCompoundAssignment && node.operatorToken.kind<=ts.SyntaxKind.LastCompoundAssignment) {
      if(ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)) {
        const reference=propertyReference(node.left,env,ctx,visiting);
        const previous=!isUnknown(reference.key) && reference.target!=null?reference.target[reference.key]:unknown(node.left.getText());
        const right=evaluate(node.right,env,ctx,visiting);
        const value=node.operatorToken.kind===ts.SyntaxKind.PlusEqualsToken?lift([previous,right],(a,b)=>typeof a==='number'&&typeof b==='number'?a+b:text(a)+text(b),node):unknown(node.getText());
        if(node.operatorToken.kind!==ts.SyntaxKind.PlusEqualsToken)diagnostic('UNRESOLVED_ASSIGNMENT','复合赋值操作未建模，值保持未知',node);
        writeProperty(reference,value,node,ctx);return value;
      }
      evaluate(node.right,env,ctx,visiting);
      diagnostic('UNRESOLVED_ASSIGNMENT','复合变量赋值未建模',node);if(ts.isIdentifier(node.left))env.set(symbol(node.left),unknown(node.getText()));return unknown(node.getText());
    }
    if(ts.isBinaryExpression(node)&&[ts.SyntaxKind.BarToken,ts.SyntaxKind.AmpersandToken].includes(node.operatorToken.kind))return lift([evaluate(node.left,env,ctx,visiting),evaluate(node.right,env,ctx,visiting)],(a,b)=>['number','boolean'].includes(typeof a)&&['number','boolean'].includes(typeof b)?node.operatorToken.kind===ts.SyntaxKind.BarToken?a|b:a&b:unknown(node.getText()),node);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const a = evaluate(node.left, env, ctx, visiting), b = evaluate(node.right, env, ctx, visiting);
      return lift([a,b],(a,b) => typeof a === 'number' && typeof b === 'number' ? a+b : text(a)+text(b),node);
    }
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsEqualsEqualsToken,ts.SyntaxKind.EqualsEqualsToken,ts.SyntaxKind.ExclamationEqualsEqualsToken,ts.SyntaxKind.ExclamationEqualsToken,ts.SyntaxKind.LessThanToken,ts.SyntaxKind.LessThanEqualsToken,ts.SyntaxKind.GreaterThanToken,ts.SyntaxKind.GreaterThanEqualsToken].includes(node.operatorToken.kind)) {
      return lift([evaluate(node.left,env,ctx,visiting),evaluate(node.right,env,ctx,visiting)],(a,b) => {
        if (isUnknown(a) || isUnknown(b)) return unknown(node.getText());
        switch(node.operatorToken.kind) {
          case ts.SyntaxKind.EqualsEqualsEqualsToken: return a===b;
          case ts.SyntaxKind.EqualsEqualsToken: return a==b;
          case ts.SyntaxKind.ExclamationEqualsEqualsToken: return a!==b;
          case ts.SyntaxKind.ExclamationEqualsToken: return a!=b;
          case ts.SyntaxKind.LessThanToken: return a<b;
          case ts.SyntaxKind.LessThanEqualsToken: return a<=b;
          case ts.SyntaxKind.GreaterThanToken: return a>b;
          case ts.SyntaxKind.GreaterThanEqualsToken: return a>=b;
        }
      },node);
    }
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) {
      const left = evaluate(node.left, env, ctx, visiting), op = node.operatorToken.kind;
      const options = [];
      for (const option of expand(left,node.left)) {
        const base = mergeConditions(ctx.conditions ?? [],option.conditions);
        if (!base) continue;
        if (!isUnknown(option.value)) {
          const useRight = op === ts.SyntaxKind.AmpersandAmpersandToken ? Boolean(option.value) : op === ts.SyntaxKind.BarBarToken ? !option.value : option.value == null;
          options.push({value:useRight ? evaluate(node.right,env,{...ctx,conditions:base},visiting) : option.value,conditions:option.conditions});
        } else {
          effect(ctx,'branched');
          diagnostic('DYNAMIC_BRANCH','短路表达式按潜在调用分析',node);
          const take = op !== ts.SyntaxKind.BarBarToken;
          const condition = outcome => ({...branch(node.left,outcome),...(op === ts.SyntaxKind.QuestionQuestionToken ? {expression:`${node.left.getText()} == null`} : {})});
          const next = branchContext({...ctx,conditions:base},condition(take));
          const skipped=cloneEnv(env),taken=cloneEnv(env);
          options.push({value:option.value,conditions:[...option.conditions,condition(!take)]});
          if(next){const value=evaluate(node.right,taken,next,visiting);options.push({value,conditions:[...option.conditions,condition(take)]});mergeExpressionEffects(env,[{env:skipped,conditions:[condition(!take)]},{env:taken,conditions:[condition(take)]}],node);}
        }
      }
      return choice(options,node);
    }
    if (ts.isObjectLiteralExpression(node)) {
      let obj = {};
      for (const p of node.properties) {
        if (ts.isSpreadAssignment(p)) {
          const value = evaluate(p.expression, env, ctx, visiting);
          obj = liftRefs([obj,value],(base,value) => mergeObject({...base},value,p.expression.getText()),p);
        } else if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) {
          const key = ts.isComputedPropertyName(p.name) ? evaluate(p.name.expression, env, ctx, visiting) : p.name.text;
          const value = evaluate(ts.isPropertyAssignment(p) ? p.initializer : p.name,env,ctx,visiting);
          obj = liftRefs([obj,key,value],(base,key,value) => {
            const result={...base};
            if(isUnknown(key) || !['string','number'].includes(typeof key)) {
              invalidateObject(result,'dynamic object key',p,ctx);diagnostic('DYNAMIC_PROPERTY_MUTATION','对象字面量的计算键未知',p);
            } else Object.defineProperty(result,String(key),{value,enumerable:true,writable:true,configurable:true});
            return result;
          },p);
        } else if (ts.isMethodDeclaration(p)) obj = lift([obj],base => ({...base,[p.name.text]:{[TAG]:'function',node:p,env}}),p);
      }
      return obj;
    }
    if (ts.isArrayLiteralExpression(node)) return node.elements.map(n => evaluate(n, env, ctx, visiting));
    if ((ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) && builtinNames.has(node.getText())) {
      const root=ts.isPropertyAccessExpression(node) ? node.expression : node;
      if(!symbol(root)?.declarations?.length && !lexicalDeclaration(node,root.getText()))return {[TAG]:'intrinsic',method:node.getText()};
    }
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      const original = checker.getSymbolAtLocation(node), s = symbol(node);
      if (env.has(s)) return env.get(s);
      const imported = clientImport(original,ctx);
      if (imported) return config.modelRequestHooks?attachBinding(imported,node):imported;
      if (ts.isIdentifier(node) && node.text === 'fetch' && !s) return { [TAG]: 'client', kind: 'fetch' };
      if (ts.isIdentifier(node) && node.text === '$fetch' && !s) return {[TAG]:'client',kind:'ofetch'};
      // lib.dom's global fetch is a declaration, whereas project-local fetch is not.
      if (ts.isIdentifier(node) && node.text === 'fetch' && s?.declarations?.every(d => program.isSourceFileDefaultLibrary(d.getSourceFile()))) return { [TAG]: 'client', kind: 'fetch' };
      if (ts.isPropertyAccessExpression(node)) {
        const object = evaluate(node.expression,env,ctx,visiting);
        if(isUnknown(object)&&(node.expression.kind===ts.SyntaxKind.ThisKeyword||symbol(node)?.declarations?.some(ts.isPropertyDeclaration))){const declared=config.clients.find(c=>c.name===node.getText());return declared?{[TAG]:'client',kind:declared.kind??'axios'}:unknown(node.getText());}
        if (object != null && !isUnknown(object)) return liftRefs([object],value => {
          if(Array.isArray(value)&&node.name.text!=='length'&&Object.hasOwn(value,node.name.text))return memberValue(value,node.name.text,node);
          if(Array.isArray(value)&&hasUnknown(value)&&node.name.text==='length')return unknown('array length mutation');
          if(config.modelRequestHooks){const interceptor=interceptorProperty(value,node.name.text);if(interceptor)return interceptor;if(value?.[TAG]==='intrinsic'&&value.method.startsWith('axios-'))return unknown(node.getText());}
          if(value?.[TAG]==='module')return moduleExport(value,node.name.text,env,ctx,node);
          if(value?.[TAG]==='module-promise' && node.name.text==='then')return {[TAG]:'intrinsic',method:'module-then',namespace:value.namespace};
          const functionProperty=functionMember(value,node.name.text,node);if(functionProperty)return functionProperty;
          if(value?.[TAG]==='instance'){const key=node.name.text;if(Object.hasOwn(value.properties,key))return value.properties[key];if(value.methods[key])return {[TAG]:'intrinsic',method:'bound-instance',receiver:value,fn:value.methods[key]};return unknown(node.getText());}
          if(typeof value==='string'&&['indexOf','includes','startsWith','endsWith','split','toLowerCase','toUpperCase','slice'].includes(node.name.text))return {[TAG]:'intrinsic',method:'string-'+node.name.text,receiver:value};
          if(Array.isArray(value)&&['push','pop','shift','unshift','slice'].includes(node.name.text))return {[TAG]:'intrinsic',method:'array-'+node.name.text,receiver:value};
          if(value?.[TAG]==='form')return {[TAG]:'intrinsic',method:'form-'+node.name.text,receiver:value};
          if (value?.[TAG] === 'client') return {...value,member:node.name.text};
          if ((Array.isArray(value) && ['map','forEach','reduce','join','concat'].includes(node.name.text)) || typeof value==='string' && node.name.text==='concat') return {[TAG]:'intrinsic',method:node.name.text,receiver:value};
          return memberValue(value,node.name.text,node);
        },node);
      }
      const d = s?.valueDeclaration ?? s?.declarations?.[0];
      if (d && sources.has(d.getSourceFile().fileName) && !visiting.has(d)) {
        const next = new Set(visiting).add(d);
        if (ts.isVariableDeclaration(d) || ts.isPropertyDeclaration(d) || ts.isPropertyAssignment(d) || ts.isParameter(d)) {
          if(ts.isVariableDeclaration(d) && mutableWrites.has(s) && !(d.parent.flags & ts.NodeFlags.Const)){diagnostic('CAPTURED_STATE_UNRESOLVED','捕获的可变变量存在写入，当前上下文未绑定其实际值',node);return unknown(d.name.getText());}
          if (d.initializer) return attachBinding(evaluate(d.initializer, env, ctx, next),d.name);
        } else if (ts.isBindingElement(d)) {
          let declaration = d.parent;
          while (declaration && !ts.isVariableDeclaration(declaration) && !ts.isParameter(declaration)) declaration = declaration.parent;
          if (declaration?.initializer) {
            const bound = new Map(env);
            bind(declaration.name, evaluate(declaration.initializer, env, ctx, next), bound, ctx);
            if (bound.has(s)) return bound.get(s);
          }
        } else if(ts.isClassDeclaration(d)||ts.isClassExpression(d))return {[TAG]:'class',node:d,env};
        else if (ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d)) {const fn={ [TAG]: 'function', node: d, env };env.set(s,fn);return fn;}
        else if (ts.isExportAssignment(d)) return evaluate(d.expression, env, ctx, next);
      }
      if(ts.isIdentifier(node)&&config.angularServices.includes(node.text)&&!(s?.declarations?.some(d=>sources.has(d.getSourceFile().fileName))))return angularService(node.text,env,ctx,node);
      const configured = config.clients.find(c => c.name === node.getText());
      if (configured) return { [TAG]: 'client', kind: configured.kind ?? 'axios' };
      if (ts.isPropertyAccessExpression(node)) {
        if (node.name.text === 'fetch' && ts.isIdentifier(node.expression) && ['globalThis', 'window', 'self'].includes(node.expression.text) && !symbol(node.expression)?.valueDeclaration && !lexicalDeclaration(node,node.expression.text)) return { [TAG]: 'client', kind: 'fetch' };
        const object = evaluate(node.expression, env, ctx, visiting);
        return liftRefs([object],object => {
          if(Array.isArray(object)&&node.name.text!=='length'&&Object.hasOwn(object,node.name.text))return memberValue(object,node.name.text,node);
          if(Array.isArray(object)&&hasUnknown(object)&&node.name.text==='length')return unknown('array length mutation');
          if(config.modelRequestHooks){const interceptor=interceptorProperty(object,node.name.text);if(interceptor)return interceptor;if(object?.[TAG]==='intrinsic'&&object.method.startsWith('axios-'))return unknown(node.getText());}
          if(object?.[TAG]==='module')return moduleExport(object,node.name.text,env,ctx,node);
          if(object?.[TAG]==='module-promise' && node.name.text==='then')return {[TAG]:'intrinsic',method:'module-then',namespace:object.namespace};
          const functionProperty=functionMember(object,node.name.text,node);if(functionProperty)return functionProperty;
          if(object?.[TAG]==='instance'){const key=node.name.text;if(Object.hasOwn(object.properties,key))return object.properties[key];if(object.methods[key])return {[TAG]:'intrinsic',method:'bound-instance',receiver:object,fn:object.methods[key]};return unknown(node.getText());}
          if(typeof object==='string'&&['indexOf','includes','startsWith','endsWith','split','toLowerCase','toUpperCase','slice'].includes(node.name.text))return {[TAG]:'intrinsic',method:'string-'+node.name.text,receiver:object};
          if(Array.isArray(object)&&['push','pop','shift','unshift','slice'].includes(node.name.text))return {[TAG]:'intrinsic',method:'array-'+node.name.text,receiver:object};
          if(object?.[TAG]==='form')return {[TAG]:'intrinsic',method:'form-'+node.name.text,receiver:object};
          if (object?.[TAG] === 'client') return {...object,member:node.name.text};
          if ((Array.isArray(object) && ['map','forEach','reduce','join','concat'].includes(node.name.text)) || typeof object==='string' && node.name.text==='concat') return {[TAG]:'intrinsic',method:node.name.text,receiver:object};
          return memberValue(object,node.name.text,node);
        },node);
      }
      return unknown(node.getText());
    }
    if (ts.isElementAccessExpression(node)) {
      const value = evaluate(node.expression, env, ctx, visiting), key = evaluate(node.argumentExpression, env, ctx, visiting);
      return liftRefs([value,key],(v,k) => {
        if(Array.isArray(v)&&hasUnknown(v)&&k==='length')return unknown('array length mutation');
        if(config.modelRequestHooks) {
          const interceptor=interceptorProperty(v,k);if(interceptor)return interceptor;
          if(v?.[TAG]==='intrinsic'&&v.method.startsWith('axios-')){if(v.state&&isUnknown(k))v.state.gaps.push('dynamic interceptor property');return unknown(node.getText());}
        }
        const functionProperty=functionMember(v,k,node);if(functionProperty)return functionProperty;
        return v?.[TAG]==='module'?moduleExport(v,k,env,ctx,node):!isUnknown(v)&&v!=null&&!isUnknown(k)?ownValue(v,k,node):unknown(node.getText());
      },node);
    }
    if (ts.isNewExpression(node)) {
      const name = node.expression.getText();
      const local = symbol(node.expression)?.declarations?.length || ts.isPropertyAccessExpression(node.expression) && (symbol(node.expression.expression)?.declarations?.length || env.has(symbol(node.expression.expression)) || lexicalDeclaration(node,node.expression.expression.getText()));
      if(!local&&['URLSearchParams','FormData','globalThis.URLSearchParams','globalThis.FormData'].includes(name)){
        const args=(node.arguments??[]).map(a=>evaluate(a,env,ctx,visiting));
        return lift(args,(...values)=>{const form=newForm(name.endsWith('FormData')?'multipart':'urlencoded',values);if(form.gap)diagnostic('FORM_UNRESOLVED',form.gap,node);return form;},node);
      }
      if (!local && ['URL','Request','globalThis.URL','globalThis.Request'].includes(name)) {
        const args = (node.arguments ?? []).map(a => evaluate(a,env,ctx,visiting));
        return lift(args,(...values) => {
          if (name.endsWith('URL')) {
            if (values.some(v => isUnknown(v))) return unknown(node.getText());
            try { return new URL(values[0],values[1]).href; } catch { return unknown(node.getText()); }
          }
          const previous = values[0]?.[TAG] === 'request' ? values[0] : null;
          return {[TAG]:'request',url:previous?.url ?? values[0],config:mergeObject({...previous?.config},values[1] ?? {},'request options')};
        },node);
      }
      const type=evaluate(node.expression,env,ctx,visiting);
      if(type?.[TAG]==='class'){
       const cls=type.node;if(cls.heritageClauses?.length||ts.getDecorators(cls)?.length){diagnostic('CLASS_MODEL_GAP','继承/装饰器类未建模',node);return unknown(node.getText());}
       const instance={[TAG]:'instance',properties:{},methods:{}};
       for(const member of cls.members){if(member.modifiers?.some(m=>m.kind===ts.SyntaxKind.StaticKeyword))continue;if(ts.isMethodDeclaration(member)&&member.name&&!ts.isComputedPropertyName(member.name))instance.methods[member.name.text]={[TAG]:'function',node:member,env:type.env};else if(ts.isPropertyDeclaration(member)&&member.name&&!ts.isComputedPropertyName(member.name))instance.properties[member.name.text]=member.initializer?evaluate(member.initializer,env,{...ctx,thisValue:instance}):undefined;else if(ts.isGetAccessor(member)||ts.isSetAccessor(member))diagnostic('CLASS_MODEL_GAP','类访问器未执行，属性未知',member);}
       const constructor=cls.members.find(ts.isConstructorDeclaration);if(constructor)invoke({[TAG]:'function',node:constructor,env:type.env},(node.arguments??[]).map(a=>evaluate(a,env,ctx,visiting)),{...ctx,thisValue:instance},node);
       return instance;
      }
      return unknown(node.getText());
    }
    if (ts.isCallExpression(node)) {
      if(node.expression.kind===ts.SyntaxKind.ImportKeyword)return dynamicModule(node,env,ctx,visiting);
      if (ts.isIdentifier(node.expression) && node.expression.text === 'require' && !symbol(node.expression)?.declarations?.some(d => sources.has(d.getSourceFile().fileName))) return requireModule(node, env, ctx, visiting);
      const target = evaluate(node.expression, env, ctx, visiting);
      if(target?.[TAG]==='intrinsic' && target.method==='Object.assign') {
        const args=node.arguments.map(a=>evaluate(a,env,ctx,visiting));
        if(ts.isObjectLiteralExpression(node.arguments[0]??{})&&args.some(isChoice)) {
          return choice(references(args,node).map(option=>{
            if(isUnknown(option.value))return option;
            const [base,...values]=option.value;if(!base||typeof base!=='object'||base[TAG]||isUnknown(base))return {value:unknown('Object.assign target'),conditions:option.conditions};
            const result={...base},conditions=mergeConditions(ctx.conditions??[],option.conditions);if(!conditions)return {value:unknown('contradictory assign'),conditions:option.conditions};
            for(const value of values){if(hasUnknown(value)){invalidateObject(result,'unknown Object.assign source',node,{...ctx,conditions});diagnostic('UNMODELED_ASSIGN','Object.assign 来源含未知覆盖',node);}if(value!=null)for(const [key,item]of Object.entries(value))if(key!==UNKNOWN)writeProperty({target:result,key},item,node,{...ctx,conditions});}
            return {value:result,conditions:option.conditions};
          }),node);
        }
        if(!args[0] || typeof args[0]!=='object' || isUnknown(args[0]) || args.some(isChoice)){invalidateObject(args[0],'dynamic Object.assign',node,ctx);diagnostic('UNMODELED_ASSIGN','动态 Object.assign 不能精确更新',node);return unknown(node.getText());}
        for(const source of args.slice(1)) {
          if(hasUnknown(source)){invalidateObject(args[0],'unknown Object.assign source',node,ctx);diagnostic('UNMODELED_ASSIGN','Object.assign 来源含未知覆盖',node);}
          if(source!=null)for(const [key,value] of Object.entries(source))if(key!==UNKNOWN)writeProperty({target:args[0],key},value,node,ctx);
        }
        return args[0];
      }
      let args = [];
      for (const argument of node.arguments) {
        const value = evaluate(ts.isSpreadElement(argument) ? argument.expression : argument,env,ctx,visiting);
        args = liftRefs([args,value],(previous,value) => {
          if(!Array.isArray(previous))return unknown('argument candidate budget');
          if (!ts.isSpreadElement(argument)) return [...previous,value];
          if (Array.isArray(value)) return [...previous,...value];
          diagnostic('DYNAMIC_SPREAD','实参展开不是静态数组，后续实参位置未知',argument);
          return [...previous,unknown('spread arguments')];
        },argument);
      }
      const options = [];
      for (const option of references([target,args],node)) {
        const conditions = mergeConditions(ctx.conditions ?? [],option.conditions);
        if (!conditions) continue;
        options.push({value:isUnknown(option.value) ? option.value : applyCall(option.value[0],option.value[1],{...ctx,conditions},node),conditions:option.conditions});
      }
      return choice(options,node);
    }
    if (ts.isConditionalExpression(node)) {
      const condition = evaluate(node.condition, env, ctx, visiting);
      const options = [],paths=[];
      for (const option of expand(condition,node.condition)) {
        const base = mergeConditions(ctx.conditions ?? [],option.conditions);
        if (!base) continue;
        const known = !isUnknown(option.value);
        if (!known) {effect(ctx,'branched');diagnostic('DYNAMIC_BRANCH','三元表达式保留两个候选',node);}
        for (const outcome of known ? [Boolean(option.value)] : [true,false]) {
          const conditions = known ? option.conditions : [...option.conditions,branch(node.condition,outcome)];
          const next = mergeConditions(base,conditions);
          if (next) {
            const scope=cloneEnv(env);
            options.push({value:evaluate(outcome ? node.whenTrue : node.whenFalse,scope,{...ctx,conditions:next},visiting),conditions});
            paths.push({env:scope,conditions});
          }
        }
      }
      if(paths.length)mergeExpressionEffects(env,paths,node);
      return choice(options,node);
    }
    return unknown(node.getText());
  }
  function applyCall(target,args,ctx,node) {
    if(!Array.isArray(args)) {
      diagnostic('ARGUMENT_CANDIDATES_UNRESOLVED','实参候选超限或未知，调用不完整',node);
      if(target?.[TAG]==='client') {
        const result=requestCall(target,[unknown('arguments[0]'),unknown('arguments[1]'),unknown('arguments[2]')],mergeConfig);
        if(!Object.hasOwn(result,'value'))record(node,target,result.method,result.url,{...result.data,[UNKNOWN]:'arguments unresolved'},ctx);
      }
      return unknown('arguments unresolved');
    }
    if (target?.[TAG] === 'client') {
      const results=[];
      for(const option of expand(args,node)) {
        const conditions=mergeConditions(ctx.conditions??[],option.conditions);if(!conditions)continue;
        if(isUnknown(option.value)){results.push({value:option.value,conditions});continue;}
        const result=requestCall(target,option.value,mergeConfig);
        if(result.gap)diagnostic('REQUEST_ADAPTER_GAP',result.gap,node);
        if(Object.hasOwn(result,'value'))results.push({value:result.value,conditions});
        else {record(node,target,result.method,result.url,result.data,{...ctx,conditions});results.push({value:unknown('response'),conditions});}
      }
      return choice(results,node);
    }
    if (target?.[TAG] === 'function') return invoke(target,args,{...ctx,thisValue:unknown('plain function this')},node);
    if (target?.[TAG] === 'intrinsic') {
      if(target.method==='unknown-member'){diagnostic('UNKNOWN_CALL_EFFECTS','未知方法可能改写接收对象，后续值保持未知',node);invalidateObject(target.receiver,'unknown member call effects',node,ctx);return applyCall(unknown('member call'),args,ctx,node);}
      if(['bound-instance','bound-object'].includes(target.method)){
       const direct=ts.isPropertyAccessExpression(node.expression)||ts.isElementAccessExpression(node.expression);
       if(!direct)diagnostic('THIS_BINDING_UNMODELED','提取出的实例方法未保留this',node);
       return invoke(target.fn,args,{...ctx,thisValue:direct?target.receiver:unknown('unbound method this')},node);
      }
      if(target.method.startsWith('string-')){
       if(args.some(v=>v!==null&&!['string','number','boolean','undefined'].includes(typeof v))||target.receiver.length>65536)return unknown(node.getText());
       const value=String.prototype[target.method.slice(7)].apply(target.receiver,args);
       if(Array.isArray(value)&&value.length>config.maxCandidates){diagnostic('CANDIDATE_LIMIT','字符串split超过静态数组预算',node);return unknown(node.getText());}return value;
      }
      if(target.method.startsWith('form-')) {
        const result=formOperation(target.receiver,target.method.slice(5),args);
        if(result.gap)diagnostic('FORM_UNRESOLVED',result.gap,node);
        if(result.changed!==undefined)trackChange(target.receiver,{operation:target.method==='form-delete'?'delete':'set',key:result.changed,expression:node.getText(),conditions:ctx.conditions??[],...locate(node)},node);
        if(result.value?.[TAG]==='serialized')result.value.input=cloneEnv(new Map([['form',result.value.input]])).get('form');
        return result.value;
      }
      if(target.method==='function-bind') {
        const fn=target.receiver,boundArgs=[...(fn.boundArgs??[]),...args.slice(1)];
        if(boundArgs.length>config.maxCandidates){diagnostic('BOUND_ARGUMENT_LIMIT','bind预填参数超过maxCandidates，绑定目标保持未知',node);return unknown('bind argument limit');}
        return {...fn,functionMembers:undefined,functionMembersUnknown:false,boundArgs,boundThis:Object.hasOwn(fn,'boundThis')?fn.boundThis:args[0]??unknown('bind global this')};
      }
      if(['function-call','function-apply'].includes(target.method)) {
        const forwarded=target.method==='function-call'?args.slice(1):args[1]==null?[]:args[1];
        if(!Array.isArray(forwarded)||hasUnknown(forwarded)){diagnostic('DYNAMIC_APPLY_ARGUMENTS','apply requires a finite known argument array',node);return unknown(node.getText());}
        return invoke(target.receiver,forwarded,{...ctx,thisValue:args[0]??unknown('call global this')},node);
      }
      if(target.method.startsWith('array-')) {
        const method=target.method.slice(6),array=target.receiver;
        if(hasUnknown(array)){diagnostic('ARRAY_OPERATION_UNMODELED','数组结构已未知，不能继续沿用元素',node);return unknown('array state');}
        if(method==='slice') {
          if(args.length>2||args.some(v=>v!==undefined&&!(typeof v==='number'&&Number.isFinite(v)))){diagnostic('ARRAY_OPERATION_UNMODELED','slice索引不是有限数字',node);return unknown('array slice');}
          return array.slice(...args);
        }
        if(['push','unshift'].includes(method)&&array.length+args.length>config.maxCandidates){invalidateObject(array,'array mutation budget',node,ctx);array[UNKNOWN]='array mutation budget';diagnostic('ARRAY_OPERATION_UNMODELED','数组新增超限，后续索引和长度未知',node);return unknown('array mutation budget');}
        effect(ctx,'mutated');const previous=clean(array),value=Array.prototype[method].apply(array,['push','unshift'].includes(method)?args:[]);
        trackChange(array,{operation:method,key:null,previous,expression:node.getText(),conditions:ctx.conditions??[],...locate(node)},node);return value;
      }
      if(target.method==='reduce') {
        if(hasUnknown(target.receiver)||target.receiver.length>config.maxCandidates||args[0]?.[TAG]!=='function'||!target.receiver.length&&args.length<2){diagnostic('REDUCE_UNMODELED','reduce requires a finite array/callback and valid initial value',node);return unknown(node.getText());}
        let accumulator=args.length>1?args[1]:target.receiver[0];
        for(let i=args.length>1?0:1;i<target.receiver.length;i++)accumulator=invoke(args[0],[accumulator,target.receiver[i],i,target.receiver],{...ctx,thisValue:unknown('reduce callback this')},node);
        return accumulator;
      }
      if(target.method.startsWith('axios-response-'))return unknown('response interceptor registration; not evaluated as request hook');
      if(target.method.startsWith('axios-request-'))return controlHook(target,args,ctx,node);
      if(target.method==='module-then'){if(args[0]?.[TAG]==='function')return invoke(args[0],[target.namespace],ctx,node);diagnostic('ASYNC_CALLBACK_UNRESOLVED','动态模块 then 回调不可解析',node);return unknown(node.getText());}
      if(builtinNames.has(target.method))return staticOperation(target.method,args,node.getText(),()=>diagnostic('STATIC_DECODE_UNRESOLVED','静态编码操作失败或超过限制',node));
      if(target.method==='join')return Array.prototype.map.call(target.receiver,text).join(args[0]===undefined ? ',' : text(args[0]));
      if(target.method==='concat')return Array.isArray(target.receiver) ? target.receiver.concat(...args) : target.receiver+args.map(text).join('');
      const callback = args[0];
      if (callback?.[TAG] !== 'function') return unknown('array callback');
      const results = [];
      for (const [index,value] of target.receiver.entries()) {
        if (index >= config.maxCandidates) { diagnostic('CANDIDATE_LIMIT','静态数组回调超过候选上限',node); return unknown('array limit'); }
        results.push(invoke(callback,[value,index,target.receiver],{...ctx,thisValue:args[1]??unknown('array callback this')},node));
      }
      return target.method === 'map' ? results : undefined;
    }
    for (const arg of args) if (arg?.[TAG] === 'function') invoke(arg,[],{...ctx,functionInventory:true,thisValue:unknown('unknown callback this')},node);
    if(config.modelRequestHooks)for(const arg of args)if(arg?.[CLIENT_STATE])arg[CLIENT_STATE].gaps.push('client passed to unknown setup call');
    const mutableArgs=args.filter(arg=>arg && typeof arg==='object'&&(!arg[TAG]||arg[TAG]==='instance')&&!isUnknown(arg));
    if(mutableArgs.length) {
      diagnostic('UNKNOWN_CALL_EFFECTS','未知调用可能修改传入对象，后续值保守保持未知',node);
      for(const arg of mutableArgs)invalidateObject(arg,'unknown call effects',node,ctx);
    }
    const name = node.expression.getText();
    if (!name.startsWith('console.')&&!['require','console'].includes(name)) diagnostic('UNRESOLVED_CALL',`无法追踪调用 ${name}`,node);
    return unknown(node.getText());
  }
  function invoke(fn, args, ctx, call) {
    if(Object.hasOwn(fn,'boundThis')){args=[...fn.boundArgs,...args];ctx={...ctx,thisValue:fn.boundThis};}

    if (ctx.chain.length >= config.maxDepth) { diagnostic('MAX_DEPTH', '达到调用深度上限', call); return unknown('maxDepth'); }
    if (ctx.active.has(fn.node)&&(ts.isFunctionDeclaration(fn.node)||(ctx.closures??[]).some(c=>c.node===fn.node&&c.env===fn.env))) { diagnostic('RECURSION', '递归调用已截断', call); return unknown('recursive'); }
    if (!analyzedFunctions.has(fn.node)) analyzedFunctions.set(fn.node,new Set());
    analyzedFunctions.get(fn.node).add(ctx.entry);
    const env = new Map(fn.env);
    fn.node.parameters.forEach((p, i) => {
      const value = p.dotDotDotToken ? args.slice(i) : args[i] !== undefined ? args[i] : p.initializer ? evaluate(p.initializer, env, ctx) : unknown(p.name.getText());
      bind(p.name, value, env, ctx);
    });
    const frame={parent:ctx.effectFrame,branched:false,mutated:false};
    const next = { ...ctx,...(ts.isArrowFunction(fn.node)&&fn.lexicalThis!==undefined?{thisValue:fn.lexicalThis}:{}),effectFrame:frame, active: new Set(ctx.active).add(fn.node),closures:[...(ctx.closures??[]),{node:fn.node,env:fn.env}], chain: [...ctx.chain, { symbol: fn.node.name?.getText() ?? call.expression?.getText() ?? call.getText(), ...locate(call) }] };
    const result=fn.node.body && ts.isBlock(fn.node.body) ? run(fn.node.body, env, next) : evaluate(fn.node.body, env, next);
    if(frame.branched && frame.mutated) {
      diagnostic('CONDITIONAL_CALL_EFFECTS','函数内条件改写尚未精确合并到调用方，对象副作用保持未知',call);
      const seen=new Set();for(const value of [...args,...fn.env.values(),ctx.thisValue])invalidateObject(value,'conditional call effects',call,ctx,seen);
    }
    return result;
  }
  function run(node, env, ctx) {
    const empty = (continuations = []) => ({continuations,returns:[],breaks:[],continues:[]});
    const combine = results => ({continuations:results.flatMap(r=>r.continuations),returns:results.flatMap(r=>r.returns),breaks:results.flatMap(r=>r.breaks),continues:results.flatMap(r=>r.continues)});
    const sequence = (nodes,states) => {
      const result = empty(states);
      for (const n of nodes) {
        if (!result.continuations.length || exhausted) break;
        const next = combine(result.continuations.map(state=>visit(n,state)));
        result.continuations = next.continuations;
        for (const key of ['returns','breaks','continues']) result[key].push(...next[key]);
        if (result.continuations.length > config.maxCandidates) {
          diagnostic('CANDIDATE_LIMIT','控制流路径超过候选上限，结果不完整',n);
          result.continuations = result.continuations.slice(0,config.maxCandidates);
          result.returns.push({value:unknown('path limit'),conditions:[]});
        }
      }
      return result;
    };
    const loop = (n,state) => {
      if (ts.isForOfStatement(n)) {
        const values = evaluate(n.expression,state.env,state.ctx);
        if (Array.isArray(values)) {
          const result = empty([state]), exits = [];
          for (const [index,value] of values.entries()) {
            if (index >= config.maxCandidates) { diagnostic('CANDIDATE_LIMIT','静态 for-of 超过候选上限',n); break; }
            const next = combine(result.continuations.map(previous => {
              const current = {...previous,env:cloneEnv(previous.env)};
              const declaration = ts.isVariableDeclarationList(n.initializer) ? n.initializer.declarations[0] : null;
              if (declaration) bind(declaration.name,value,current.env,current.ctx);
              else if (ts.isIdentifier(n.initializer)) current.env.set(symbol(n.initializer),value);
              return visit(n.statement,current);
            }));
            exits.push(...next.breaks);
            result.returns.push(...next.returns);
            result.continuations = [...next.continuations,...next.continues];
            if (!result.continuations.length) break;
          }
          result.continuations.push(...exits);
          return result;
        }
      }
      if (ts.isForStatement(n) && n.initializer) visit(n.initializer,state);
      const expression = n.expression ?? n.condition;
      const condition = expression && !ts.isForOfStatement(n) && !ts.isForInStatement(n) ? evaluate(expression,state.env,state.ctx) : unknown('loop');
      if (condition === false && !ts.isDoStatement(n)) return empty([state]);
      diagnostic('APPROXIMATE_LOOP','非静态循环按零次或一次潜在执行分析，不保证循环后变量精度',n);
      const current = {...state,env:cloneEnv(state.env),ctx:branchContext(state.ctx,branch(expression ?? n,true)) ?? state.ctx};
      if ((ts.isForOfStatement(n) || ts.isForInStatement(n)) && ts.isVariableDeclarationList(n.initializer)) bind(n.initializer.declarations[0].name,unknown('loop item'),current.env,current.ctx);
      const body = visit(n.statement,current);
      const after = [...body.continuations,...body.continues,...body.breaks];
      for (const continuation of after) for (const [key,value] of continuation.env) {
        if (state.env.has(key) && state.env.get(key) !== value) continuation.env.set(key,unknown(`loop.${key?.name ?? 'value'}`));
      }
      return {...body,continuations:[...(ts.isDoStatement(n) ? [] : [state]),...after],breaks:[],continues:[]};
    };
    const visit = (n,state) => {
      if (!tick(n) || ts.isFunctionLike(n)) return empty([state]);
      if (ts.isBlock(n) || ts.isSourceFile(n)) return sequence(n.statements,[state]);
      if (ts.isReturnStatement(n)) return {...empty(),returns:[{value:n.expression ? evaluate(n.expression,state.env,state.ctx) : undefined,conditions:state.ctx.conditions ?? []}]};
      if (ts.isBreakStatement(n)) return {...empty(),breaks:[state]};
      if (ts.isContinueStatement(n)) return {...empty(),continues:[state]};
      if (ts.isVariableDeclaration(n)) {
        bind(n.name,n.initializer ? evaluate(n.initializer,state.env,state.ctx) : undefined,state.env,state.ctx);
        return empty([state]);
      }
      if (ts.isIfStatement(n)) {
        const value = evaluate(n.expression,state.env,state.ctx), results = [];
        for (const option of expand(value,n.expression)) {
          const known = !isUnknown(option.value) && !isChoice(option.value);
          const base = mergeConditions(state.ctx.conditions ?? [],option.conditions);
          if (!base) continue;
          if (!known) {effect(state.ctx,'branched');diagnostic('DYNAMIC_BRANCH','动态条件按独立候选路径分析',n);}
          for (const outcome of known ? [Boolean(option.value)] : [true,false]) {
            const next = known ? {...state.ctx,conditions:base} : branchContext({...state.ctx,conditions:base},branch(n.expression,outcome));
            if (!next) continue;
            const current = {env:cloneEnv(state.env),ctx:next};
            results.push(outcome ? visit(n.thenStatement,current) : n.elseStatement ? visit(n.elseStatement,current) : empty([current]));
          }
        }
        return combine(results);
      }
      if (ts.isForOfStatement(n) || ts.isForInStatement(n) || ts.isForStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n)) return loop(n,state);
      if (ts.isExpressionStatement(n)) { evaluate(n.expression,state.env,state.ctx); return empty([state]); }
      if (ts.isCallExpression(n) || ts.isBinaryExpression(n)) { evaluate(n,state.env,state.ctx); return empty([state]); }
      if (ts.isThrowStatement(n)) { if (n.expression) evaluate(n.expression,state.env,state.ctx); return empty(); }
      if (ts.isTryStatement(n) || ts.isSwitchStatement(n)) diagnostic('APPROXIMATE_CONTROL_FLOW','try/switch 尚未进行精确路径建模',n);
      const children = [];
      ts.forEachChild(n,child => {children.push(child);});
      return sequence(children,[state]);
    };
    const result = visit(node,{env,ctx});
    if (result.continuations.length) result.returns.push(...result.continuations.map(state=>({value:undefined,conditions:state.ctx.conditions ?? []})));
    return result.returns.length ? choice(result.returns,node) : unknown('return');
  }
  const entryMatch = config.entries.length ? picomatch(config.entries) : () => true;
  const entryFiles=[...sources.keys()].filter(file=>entryMatch(path.relative(root,file).split(path.sep).join('/')));
  const priorityMatch=config.entryPriority.length?picomatch(config.entryPriority):()=>false;
  const priorityFiles=new Set(entryFiles.filter(file=>priorityMatch(path.relative(root,file).split(path.sep).join('/'))));
  entryFiles.sort((a,b)=>Number(priorityFiles.has(b))-Number(priorityFiles.has(a)));
  const entryCount=entryFiles.length;
  const roots=entryFiles.map(file=>path.relative(root,file).split(path.sep).join('/'));
  const visited=new Set(roots);
  const pendingAssets=()=>config.includeUnlinked && config.entries.length ? [...reachableAssets(assets,roots)].filter(([relative])=>!visited.has(relative) && sources.has(path.resolve(root,relative))) : [];
  function scanFile(file,ctx) {
    const sf=program.getSourceFile(file);
    run(sf,new Map(),ctx);
    const visit=n=>{
      if(exhausted)return;
      if(ts.isFunctionLike(n) && n.body && !analyzedFunctions.get(n)?.has(ctx.entry))invoke({node:n,env:new Map()},[],{...ctx,functionInventory:true},{expression:n.name??n,getSourceFile:()=>sf,getStart:()=>n.getStart()});
      ts.forEachChild(n,visit);
    };visit(sf);
  }
  function scanPartition(file,ctx,remainingTasks) {
    const remaining=config.maxSteps-steps;
    const partition={
      file:ctx.entry,phase:ctx.discovery==='asset-local'?'asset-local':'entry',state:'finished',steps:0,
      ...(ctx.priority?{priority:true}:{}),
      limit:Math.min(config.maxStepsPerFile??config.maxSteps,Math.max(1,Math.floor(remaining/remainingTasks),ctx.priority?Math.floor(config.maxSteps*.5/priorityFiles.size):0),remaining),
    };
    partitions.push(partition);
    if(!remaining) {
      partition.state='skipped';partition.reason='global-budget';
      if(!exhausted)diagnostic('BUDGET_EXCEEDED',`达到 maxSteps=${config.maxSteps}，后续分区未扫描`,program.getSourceFile(file));
      exhausted=true;
      return;
    }
    currentPartition=partition;
    try {
      // Calls into dependencies are charged to this entry, not the physical callee file.
      scanFile(file,ctx);
    } catch(error) {
      if(error!==budgetStop)throw error;
      partition.state='budget-exceeded';
    } finally {
      currentPartition=null;
    }
  }
  for(const [index,file] of entryFiles.entries())scanPartition(file,{entry:roots[index],priority:priorityFiles.has(file),chain:[],active:new Set()},entryCount-index+pendingAssets().length);
  if(config.includeUnlinked && config.entries.length) {
    while(true) {
      const pending=pendingAssets();
      if(!pending.length)break;
      for(const [relative,parents] of pending) {
        visited.add(relative);
        scanPartition(path.resolve(root,relative),{entry:relative,chain:[],active:new Set(),discovery:'asset-local',referencedBy:[...parents]},1+pendingAssets().length);
      }
      if(exhausted)break;
    }
    const finalReferences=reachableAssets(assets,roots);
    for(const endpoint of assetCandidateMap.values())for(const usage of endpoint.usages)usage.referencedBy=[...(finalReferences.get(usage.callChain.at(-1).file)??[])];
    if(assetCandidateMap.size)diagnostic('UNLINKED_ASSET_CANDIDATES','已保留资产级候选；其参数和业务入口调用关系尚未连接');
  }
  if (!entryCount) diagnostic('NO_ENTRIES', '没有匹配的入口文件');
  let sdkVersion=null;try{const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));sdkVersion=pkg.dependencies?.['aliyun-sdk']??pkg.devDependencies?.['aliyun-sdk']??null;}catch{}
  const sdk=candidatesSdk();
  if(sdk.length)diagnostic('SDK_HTTP_UNMODELED','SDK配置/操作仅为独立候选，HTTP协议尚未恢复');
  function candidatesSdk(){return sdkCandidates(program,[...sources.keys()],file=>path.relative(root,file).split(path.sep).join('/'),sdkVersion);}
  return { schemaVersion: 1,sdkCandidates:sdk, assets, assetCandidates:[...assetCandidateMap.values()].sort((a,b)=>`${a.url} ${a.method}`.localeCompare(`${b.url} ${b.method}`)), mode: config.entries.length ? 'entries' : 'inventory', stats: { partitions, unlinkedScan:!config.includeUnlinked?'disabled':!entryCount?'no-entries':!config.entries.length?'inventory-mode':partitions.some(p=>p.state!=='finished')?'incomplete':'completed', files: sources.size, entries: entryCount, steps, complete: diagnostics.length === 0 },
    endpoints: [...endpoints.values()].sort((a, b) => `${a.url} ${a.method}`.localeCompare(`${b.url} ${b.method}`)), diagnostics };
}

export function markdown(report) {
  const escape = v => String(v).replaceAll('|', '\\|').replaceAll('\n', ' ');
  const hookRows=report.endpoints.flatMap(e=>e.usages.filter(u=>u.afterRequestHooks).flatMap(u=>{const h=u.afterRequestHooks;return h.variants.length?h.variants.map(v=>`| ${escape(v.method)} | ${escape(v.address.host??'未知')} | ${escape(v.url)} | ${h.state}/${v.resolution} |`):[`| — | 未知 | ${escape(e.url)} | ${h.state}: ${escape(h.gaps.join('; '))} |`];}));
  const hookMarkdown=hookRows.length?'\n\n## 请求 hook 后候选\n\n独立阶段；仍在 Axios transport/transformRequest 之前，不代表实际网络载荷。\n\n| 方法 | Host | URL | 状态 |\n| --- | --- | --- | --- |\n'+hookRows.join('\n'):'';
  return `# 前端接口提取\n\n模式：${report.mode}；文件：${report.stats.files}；接口：${report.endpoints.length}；诊断：${report.diagnostics.length}。\n\n静态潜在调用结果，不代表运行时覆盖率。参数及每条调用链见 JSON。条件之间的 AND/OR 关系以 JSON 中每条 usage 为准。\n\n| 方法 | Host（调用处） | URL | 解析状态 | 条件 | 调用位置 |\n| --- | --- | --- | --- | --- | --- |\n` + report.endpoints.map(e => {
    const conditions = [...new Set(e.usages.flatMap(u=>(u.conditions ?? []).map(c=>`${c.expression} = ${c.outcome}`)))].join('; ') || '—';
    return `| ${escape(e.method)} | ${escape(e.address?.host ?? "未知")} | ${escape(e.url)} | ${e.resolution} | ${escape(conditions)} | ${escape(e.usages.map(u => { const p = u.callChain.at(-1); return `${p.file}:${p.line}`; }).join(', '))} |`;
  }).join('\n') + hookMarkdown + '\n\n## 文件求值预算\n\nfinished 仅表示本分区未被步数预算中断，不能证明语义或运行时覆盖完整。\n\n| 文件 | 阶段 | 状态 | 步数/配额 | 原因 |\n| --- | --- | --- | --- | --- |\n' + (report.stats.partitions??[]).map(p=>`| ${escape(p.file)} | ${p.phase} | ${p.state} | ${p.steps}/${p.limit} | ${p.reason??'—'} |`).join('\n') + `\n\n## 未连接业务入口的资产级候选\n\n这些结果不计入入口接口表；字段和调用关系可能不完整。补漏状态：${report.stats.unlinkedScan ?? '未记录'}。\n\n` + (report.assetCandidates??[]).map(e=>`- ${escape(e.method)} ${escape(e.url)}（${escape(e.usages.map(u=>{const p=u.callChain.at(-1);return p.file+':'+p.line;}).join(', '))}）`).join('\n') + '\n\n## 诊断\n\n' + report.diagnostics.map(d => `- ${d.code}: ${escape(d.message)}${d.file ? ` (${d.file}:${d.line})` : ''}`).join('\n') + '\n';
}
