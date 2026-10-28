import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const run=promisify(execFile),hash=(bytes,kind='sha256')=>createHash(kind).update(bytes).digest(kind==='sha512'?'base64':'hex');
export function validateNativeSpec(spec){
 if(!spec||Object.keys(spec).some(k=>!['name','version','integrity'].includes(k))||!['@esbuild/linux-x64','@esbuild/linux-arm64'].includes(spec.name)||!/^\d+\.\d+\.\d+$/.test(spec.version)||!/^sha512-[A-Za-z0-9+/]{86}==$/.test(spec.integrity))throw Error('nativeDependencies只支持固定版本/SHA512的esbuild Linux平台包');
 return spec;
}
export function nativePackageFiles(tgz,spec){
 validateNativeSpec(spec);if(tgz.length>16*1024*1024||'sha512-'+hash(tgz,'sha512')!==spec.integrity)throw Error('native包完整性不匹配或超限');
 const tar=gunzipSync(tgz,{maxOutputLength:64*1024*1024}),files=new Map();let offset=0,entries=0;
 const string=(b,start,length)=>b.subarray(start,start+length).toString('utf8').split('\0')[0];
 while(offset+512<=tar.length){const header=tar.subarray(offset,offset+512);offset+=512;if(header.every(n=>n===0))break;if(++entries>32)throw Error('native包文件数量超限');
  const checksum=string(header,148,8).trim(),sizeText=string(header,124,12).trim();if(!/^[0-7]+$/.test(checksum)||! /^[0-7]+$/.test(sizeText))throw Error('native tar数字字段无效');
  let sum=0;for(let i=0;i<512;i++)sum+=i>=148&&i<156?32:header[i];if(sum!==parseInt(checksum,8))throw Error('native tar头校验失败');
  const prefix=string(header,345,155),name=(prefix?prefix+'/':'')+string(header,0,100),type=header[156],size=parseInt(sizeText,8);
  if(![0,48,53].includes(type)||!name.startsWith('package/')||name.includes('\\')||name.split('/').some(s=>s==='..')||size>32*1024*1024||offset+size>tar.length)throw Error('native tar路径/类型/大小不支持');
  const relative=name.slice(8).replace(/\/$/,'');if(type===53){if(size)throw Error('native目录大小无效');}else{if(!['package.json','bin/esbuild','README.md','LICENSE.md','LICENSE'].includes(relative)||files.has(relative))throw Error('native包含重复或非预期文件');files.set(relative,tar.subarray(offset,offset+size));}
  offset+=Math.ceil(size/512)*512;
 }
 const metadata=JSON.parse(files.get('package.json')?.toString()??'null');if(metadata?.name!==spec.name||metadata?.version!==spec.version||!files.has('bin/esbuild'))throw Error('native包名称/版本/二进制不匹配');return files;
}
export async function installNative(spec){
 validateNativeSpec(spec);const expected='@esbuild/'+process.platform+'-'+process.arch;if(spec.name!==expected)throw Error('native平台包与容器平台不匹配');
 const project=await fs.realpath(process.cwd()),modules=await fs.realpath(path.join(project,'node_modules'));if(!modules.startsWith(project+path.sep))throw Error('node_modules越过项目');const parent=await fs.realpath(path.join(modules,'esbuild/package.json'));if(!parent.startsWith(modules+path.sep))throw Error('esbuild父包越界');const pkg=JSON.parse(await fs.readFile(parent,'utf8'));if(pkg.version!==spec.version||pkg.optionalDependencies?.[spec.name]!==spec.version)throw Error('native版本不匹配esbuild已安装父包的声明');
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'frontend-native-'));let staging;
 try{
  const packed=await run('npm',['pack',spec.name+'@'+spec.version,'--ignore-scripts','--json','--strict-ssl=true','--registry=https://registry.npmjs.org','--pack-destination',tmp],{cwd:tmp,timeout:120000,maxBuffer:1024*1024});const info=JSON.parse(packed.stdout);if(info.length!==1||typeof info[0].filename!=='string'||path.basename(info[0].filename)!==info[0].filename)throw Error('npm pack输出无效');const archive=path.join(tmp,info[0].filename);if((await fs.stat(archive)).size>16*1024*1024)throw Error('native包字节超限');const tgz=await fs.readFile(archive),files=nativePackageFiles(tgz,spec);
  const scope=path.join(modules,'@esbuild');await fs.mkdir(scope,{recursive:true});if(!(await fs.realpath(scope)).startsWith(modules+path.sep))throw Error('native安装目录越界');staging=await fs.mkdtemp(path.join(scope,'.native-'));for(const [name,bytes]of files){const file=path.join(staging,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes,{mode:name==='bin/esbuild'?0o755:0o644});}
  const version=(await run(path.join(staging,'bin/esbuild'),['--version'],{timeout:10000,maxBuffer:65536})).stdout.trim();if(version!==spec.version)throw Error('native二进制版本不匹配');const target=path.join(scope,spec.name.split('/')[1]);let supplemented=true;
  try{await fs.lstat(target);const existing=await fs.realpath(path.join(target,'bin/esbuild'));if(!existing.startsWith(target+path.sep)||hash(await fs.readFile(existing))!==hash(files.get('bin/esbuild')))throw Error('现有native二进制与固定补充包不匹配');supplemented=false;}catch(e){if(e.code!=='ENOENT')throw e;await fs.rename(staging,target);staging=null;}
  return {...spec,parent:'esbuild',parentVersion:pkg.version,binarySha256:hash(files.get('bin/esbuild')),supplemented,source:'profile-pinned-supplement',registry:'https://registry.npmjs.org'};
 }finally{if(staging)await fs.rm(staging,{recursive:true,force:true});await fs.rm(tmp,{recursive:true,force:true});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))try{console.log(JSON.stringify(await installNative(JSON.parse(process.argv[2]))));}catch(e){console.error('native补充失败: '+e.message);process.exitCode=1;}
