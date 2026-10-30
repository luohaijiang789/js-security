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
    if(c.type==='Identifier'&&c.name==='importScripts')
      for(const arg of n.arguments)add(arg,'worker_import',value(arg),'candidate');
    if(c.type==='Identifier'&&c.name==='__vitePreload'&&n.arguments.some(a=>text(a)==='import.meta.url'))viteBase=true;
  },
  AssignmentExpression(p){
    const n=p.node,l=n.left;
    if(l.type==='MemberExpression'&&!l.computed){
      const receiver=text(l.object),name=l.property.name;
      if(name==='p'&&value(n.right)!==null)paths.set(receiver,value(n.right));
      if(name==='u'&&['ArrowFunctionExpression','FunctionExpression'].includes(n.right.type))
        builders.push({receiver,line:n.loc.start.line,column:n.loc.start.column,start:n.start,end:n.end});
      if(name==='src')add(n,'script_assignment',value(n.right),'candidate');
    }
  },
  Identifier(p){if(p.node.name==='__vite__mapDeps')viteTable=true;},
  NewExpression(p){if(p.node.callee.type==='Identifier'&&['Worker','SharedWorker'].includes(p.node.callee.name))add(p.node,'worker',value(p.node.arguments[0]),'candidate');}
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
