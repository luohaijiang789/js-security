// Runs the pinned upstream analyzer only. Target files are parsed as data, never required/evaluated.
const fs=require('node:fs'),path=require('node:path');
const engineRoot=process.argv[2];process.argv.splice(2,1);
const {parser}=require(path.join(engineRoot,'jshound/js/babel.js'));
for(const file of process.argv.slice(2)){
 let ast=null,last;
 const source=fs.readFileSync(file,'utf8');
 for(const options of [{sourceType:'unambiguous',plugins:['jsx','typescript'],errorRecovery:true},{sourceType:'unambiguous',plugins:[],errorRecovery:true},{sourceType:'script',plugins:[],errorRecovery:true}])try{ast=parser.parse(source,options);break;}catch(error){last=error;}
 let configSeed=false,sdkSeed=false;
 const visit=node=>{
  if(!node||typeof node!=='object'||typeof node.type!=='string')return;
  if(node.type==='ObjectExpression'){
   const props=new Map((node.properties??[]).filter(p=>p.type==='ObjectProperty'&&!p.computed).map(p=>[p.key.name??p.key.value,p.value]));
   const method=props.get('method')??props.get('type');if(props.has('url')&&method?.type==='StringLiteral'&&['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].includes(method.value.toUpperCase()))configSeed=true;
  }
  if(node.type==='ImportDeclaration'&&node.source?.value==='aliyun-sdk'||node.type==='CallExpression'&&node.callee?.name==='require'&&node.arguments?.[0]?.value==='aliyun-sdk')sdkSeed=true;
  for(const [key,value]of Object.entries(node)){if(['loc','extra','comments','errors'].includes(key))continue;if(Array.isArray(value))for(const item of value)visit(item);else visit(value);}
 };
 if(ast)visit(ast);
 if(configSeed)process.stderr.write('ADAPTER_CONFIG_SEED '+JSON.stringify({file})+'\n');
 if(sdkSeed)process.stderr.write('ADAPTER_MODULE_SEED '+JSON.stringify({file})+'\n');
 if(!ast||ast.errors?.length)process.stderr.write('ADAPTER_PARSE_DIAGNOSTIC '+JSON.stringify({file,message:(!ast?last?.message:ast.errors[0]?.message)??'parse failed',errors:ast?.errors?.length??1})+'\n');
}
process.argv[1]=path.join(engineRoot,'jshound/js/static_ast.js');
require(process.argv[1]);
