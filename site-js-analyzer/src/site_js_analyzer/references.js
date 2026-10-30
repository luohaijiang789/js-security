// Parse reference syntax with the locked engine's Babel and reuse its discovery core.
const fs=require('fs'), path=require('path');
const root=process.argv[2];
const {parser,traverse}=require(path.join(root,'jshound/js/babel.js'));
const {analyse}=require(path.join(root,'jshound/js/chunkmap.js'));
const {specifiers}=require(path.join(root,'jshound/js/imports.js'));
const source=fs.readFileSync(0,'utf8');
let ast=null, error='';
for(const opts of [
  {sourceType:'unambiguous',plugins:['jsx','typescript','importAttributes'],errorRecovery:true},
  {sourceType:'script',plugins:[],errorRecovery:true}
]) { try {ast=parser.parse(source,opts);break;} catch(e){error=e.message;} }
if(!ast){ process.stdout.write(JSON.stringify({parsed:false,error,refs:[]}));process.exit(0); }
const refs=[], paths=new Map(), builders=[], literals=new Set();
let viteBase=false, viteTable=false;
const text=node=>node?source.slice(node.start,node.end):null;
const value=node=>node?.type==='StringLiteral'?node.value:
  node?.type==='TemplateLiteral'&&!node.expressions.length?node.quasis[0].value.cooked:null;
const globalMember=(node,name,scope)=>
  node?.type==='Identifier'&&node.name===name&&!scope.getBinding(name)||
  node?.type==='MemberExpression'&&!node.computed&&node.property.name===name&&
  ['self','globalThis'].includes(node.object?.name)&&!scope.getBinding(node.object.name);
const importMeta=node=>node?.type==='MemberExpression'&&!node.computed&&node.property.name==='url'&&
  node.object?.type==='MetaProperty'&&node.object.meta.name==='import'&&node.object.property.name==='meta';
function workerTarget(node,scope){
  if(value(node)!==null)return {target:value(node),url_basis:'execution_base'};
  if(node?.type==='NewExpression'&&globalMember(node.callee,'URL',scope)&&node.arguments.length===2&&importMeta(node.arguments[1]))
    return {target:value(node.arguments[0]),url_basis:'module_url'};
  return {target:null,url_basis:'unknown'};
}
function workerMode(node,shared){
  if(!node||shared&&value(node)!==null)return 'classic'; // SharedWorker's legacy name string.
  if(node.type!=='ObjectExpression')return null;
  let mode='classic';
  for(const p of node.properties){
    if(p.type!=='ObjectProperty'||p.computed)return null;
    if((p.key.name||p.key.value)==='type')mode=value(p.value);
  }
  return ['classic','module'].includes(mode)?mode:null;
}
function scriptAssignment(p){
  const n=p.node,l=n.left;
  if(l.type!=='MemberExpression'||l.computed||l.property.name!=='src')return;
  const binding=l.object.type==='Identifier'&&p.scope.getBinding(l.object.name);
  let proven=false;
  if(binding&&binding.kind==='const'&&binding.constant&&binding.path.isVariableDeclarator()){
    const init=binding.path.node.init;
    const documentCall=init?.type==='CallExpression'&&init.callee.type==='MemberExpression'&&!init.callee.computed&&
      init.callee.object.name==='document'&&!binding.path.scope.getBinding('document')&&init.callee.property.name==='createElement'&&
      init.arguments.length===1&&value(init.arguments[0])==='script';
    const declaration=binding.path.parentPath, assignment=p.parentPath;
    const refs=binding.referencePaths;
    const attached=refs.filter(r=>r.parentPath.isCallExpression()&&r.parentPath.node.arguments.length===1&&r.parentPath.node.arguments[0]===r.node);
    if(documentCall&&refs.length===2&&attached.length===1&&assignment.isExpressionStatement()&&
       declaration.isVariableDeclaration()&&declaration.node.declarations.length===1){
      const call=attached[0].parentPath, c=call.node.callee, mount=call.parentPath;
      const receiver=c.type==='MemberExpression'&&!c.computed&&c.object;
      const docRoot=receiver?.type==='MemberExpression'&&!receiver.computed&&receiver.object.name==='document'&&
        !call.scope.getBinding('document')&&['head','body','documentElement'].includes(receiver.property.name);
      proven=n.operator==='='&&!!docRoot&&['appendChild','append'].includes(c.property.name)&&mount.isExpressionStatement()&&
        declaration.parentPath===assignment.parentPath&&assignment.parentPath===mount.parentPath&&
        assignment.key===declaration.key+1&&mount.key===assignment.key+1;
    }
  }
  add(n,'script_assignment',value(n.right),proven&&value(n.right)!==null?'structured':'candidate',
      {binding_evidence:proven?'const_script_src_append':'unverified_src_assignment'});
}
function add(node,kind,target,confidence='certain',extra={}) {
  refs.push({kind,target,confidence,line:node.loc?.start.line,column:node.loc?.start.column,
    start:node.start,end:node.end,...extra});
  if(target!==null) literals.add(target);
}
traverse.default(ast,{
  ImportDeclaration(p){add(p.node.source,'module_import',p.node.source.value);},
  ExportNamedDeclaration(p){if(p.node.source)add(p.node.source,'module_export',p.node.source.value);},
  ExportAllDeclaration(p){add(p.node.source,'module_export',p.node.source.value);},
  CallExpression(p){
    const n=p.node,c=n.callee;
    if(c.type==='Import')add(n,'dynamic_import',value(n.arguments[0]),value(n.arguments[0])===null?'unknown':'certain');
    if((c.type==='Identifier'&&c.name==='importScripts')||(c.type==='MemberExpression'&&!c.computed&&c.property.name==='importScripts'))
      for(const arg of n.arguments)add(arg,'worker_import',value(arg),'candidate',
        {global_binding:!!globalMember(c,'importScripts',p.scope)});
    if(c.type==='Identifier'&&c.name==='__vitePreload'&&n.arguments.some(a=>text(a)==='import.meta.url'))viteBase=true;
  },
  AssignmentExpression(p){
    const n=p.node,l=n.left;
    if(l.type==='MemberExpression'&&!l.computed){
      const receiver=text(l.object),name=l.property.name;
      if(name==='p'&&value(n.right)!==null)paths.set(receiver,value(n.right));
      if(name==='u'&&['ArrowFunctionExpression','FunctionExpression'].includes(n.right.type))
        builders.push({receiver,line:n.loc.start.line,column:n.loc.start.column,start:n.start,end:n.end});
      if(name==='src')scriptAssignment(p);
    }
  },
  Identifier(p){if(p.node.name==='__vite__mapDeps')viteTable=true;},
  NewExpression(p){
    const n=p.node,c=n.callee;
    const name=c.type==='Identifier'?c.name:c.type==='MemberExpression'&&!c.computed?c.property.name:null;
    if(!['Worker','SharedWorker'].includes(name))return;
    const target=workerTarget(n.arguments[0],p.scope), mode=workerMode(n.arguments[1],name==='SharedWorker');
    const verified=globalMember(c,name,p.scope)&&mode!==null&&target.target!==null;
    add(n,'worker',target.target,verified?'structured':'candidate',
      {worker_type:name==='Worker'?'dedicated_worker':'shared_worker',worker_mode:mode,...target,
       binding_evidence:globalMember(c,name,p.scope)?'unshadowed_global':'unverified_constructor'});
  }
});
let map;
try {map=analyse(source);} catch(e){map={error:e.message};}
const publicPaths=[...new Set(builders.filter(b=>paths.has(b.receiver)).map(b=>paths.get(b.receiver)))];
for(const target of map.chunks||[]){
  if(literals.has(target))continue;
  const builder=builders[0];
  const webpack=!!builder||(map.stats?.builders||0)>0;
  const structured=webpack||(viteTable&&viteBase);
  refs.push({kind:webpack?'webpack_chunk':viteTable&&viteBase?'vite_dependency':'chunk_candidate',
    target,confidence:structured?'structured':'candidate',
    line:builder?.line??null,column:builder?.column??null,start:builder?.start??null,end:builder?.end??null,
    base_kind:webpack?'public_path':viteTable&&viteBase?'module':'unknown',
    public_path:publicPaths.length===1?publicPaths[0]:map.publicPath||null});
}
for(const target of map.speculative||[])
  if(!literals.has(target)&&!refs.some(r=>r.target===target))refs.push({kind:'chunk_candidate',target,confidence:'candidate',line:null,column:null,start:null,end:null});
process.stdout.write(JSON.stringify({parsed:true,errors:ast.errors.map(e=>e.message),refs,
  upstream_specifiers:specifiers(source).specifiers,chunk_stats:map.stats||{},chunk_error:map.error||null}));
