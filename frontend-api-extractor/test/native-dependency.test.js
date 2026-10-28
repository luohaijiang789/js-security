import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {validateNativeSpec,nativePackageFiles} from '../tools/native-dependency.mjs';
import {taskProfile} from '../src/repository-task.js';
// Frozen Python tarfile USTAR fixtures; no npm download or compiler execution.
const archives=JSON.parse(await fs.readFile(new URL('./native-archives.json',import.meta.url)));
const spec=bytes=>({name:'@esbuild/linux-x64',version:'0.16.17',integrity:'sha512-'+createHash('sha512').update(bytes).digest('base64')});
test('native package SRI and strict archive extraction use independent frozen tar fixtures',()=>{
 const bytes=Buffer.from(archives.valid,'base64'),pin=spec(bytes),files=nativePackageFiles(bytes,pin);
 assert.equal(files.size,2);assert.equal(files.get('bin/esbuild').toString(),'test compiler bytes');
 assert.throws(()=>nativePackageFiles(Buffer.concat([bytes,Buffer.from('x')]),pin),/完整性/);
 for(const kind of ['metadata','traversal','unexpected','duplicate','link','checksum']){const data=Buffer.from(archives[kind],'base64');assert.throws(()=>nativePackageFiles(data,spec(data)),undefined,kind);}
});
test('native pins reject arbitrary packages, floating versions, invalid integrity and duplicate profiles',()=>{
 const pin=spec(Buffer.from('x'));
 for(const change of [{name:'evil'},{version:'^0.16.17'},{integrity:'sha512-no'},{command:'install'}])assert.throws(()=>validateNativeSpec({...pin,...change}));
 assert.throws(()=>taskProfile({nativeDependencies:[pin,pin]}));
 assert.throws(()=>taskProfile({packageManager:'pnpm',packageManagerVersion:'9.15.4',nativeDependencies:[pin]}));
});
