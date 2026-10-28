import {build} from 'esbuild';await build({entryPoints:['src/entry.js'],outdir:'dist',bundle:true,splitting:true,format:'esm',sourcemap:true,minify:true});
