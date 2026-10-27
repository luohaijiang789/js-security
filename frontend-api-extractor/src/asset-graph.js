// Reference paths are evidence of module linkage, not proof of runtime execution.
export function referencePath(assets,from,to) {
  if(from===to)return [];
  const adjacency=new Map(assets.map(a=>[a.file,a.imports.filter(i=>i.resolvedFile && !i.typeOnly)]));
  const queue=[{file:from,path:[]}],seen=new Set([from]);
  for(let index=0;index<queue.length;index++) {
    const current=queue[index];
    for(const edge of adjacency.get(current.file)??[]) {
      const path=[...current.path,{...edge,from:current.file}];
      if(edge.resolvedFile===to)return path;
      if(!seen.has(edge.resolvedFile)){seen.add(edge.resolvedFile);queue.push({file:edge.resolvedFile,path});}
    }
  }
  return null;
}

export function reachableAssets(assets,entries) {
  const adjacency=new Map(assets.map(a=>[a.file,a.imports.filter(i=>i.resolvedFile && !i.typeOnly)]));
  const result=new Map();
  for(const entry of entries) {
    const queue=[entry],seen=new Set([entry]);
    for(let index=0;index<queue.length;index++) {
      const file=queue[index];
      if(!result.has(file))result.set(file,new Set());
      result.get(file).add(entry);
      for(const edge of adjacency.get(file)??[])if(!seen.has(edge.resolvedFile)){seen.add(edge.resolvedFile);queue.push(edge.resolvedFile);}
    }
  }
  return result;
}
