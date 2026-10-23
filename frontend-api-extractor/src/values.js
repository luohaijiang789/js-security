const CHOICES = Symbol('candidate values');
export const TAG = Symbol('abstract value type');
export const UNKNOWN = '__unknown';
export const unknown = expression => ({ [UNKNOWN]: expression || 'unknown' });
export const hasUnknown = v => v && typeof v === 'object' && Object.hasOwn(v, UNKNOWN);
export const isUnknown = v => hasUnknown(v) && Object.keys(v).length === 1;
export const isChoice = v => Boolean(v?.[CHOICES]);
export const text = v => isUnknown(v) ? `{${v[UNKNOWN]}}` : ['string','number','boolean'].includes(typeof v) ? String(v) : '{expression}';
export const dynamic = v => hasUnknown(v) || isChoice(v) || typeof v === 'string' && /\{[^}]+\}/.test(v) || v && typeof v === 'object' && Object.values(v).some(dynamic);
export function clean(value, seen = new Set()) {
  if (['function','client','intrinsic'].includes(value?.[TAG])) return unknown(value[TAG]);
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return unknown('cyclic object');
  const next = new Set(seen).add(value);
  if (isChoice(value)) return {__candidates:value[CHOICES].map(o=>({value:clean(o.value,next),conditions:o.conditions}))};
  return Array.isArray(value) ? value.map(v=>clean(v,next)) : Object.fromEntries(Object.entries(value).map(([k,v])=>[k,clean(v,next)]));
}

export function mergeConditions(...groups) {
  const result = [];
  for (const condition of groups.flat()) {
    const previous = result.find(c => c.file === condition.file && c.line === condition.line && c.column === condition.column && c.expression === condition.expression);
    if (previous && previous.outcome !== condition.outcome) return null;
    if (!previous) result.push(condition);
  }
  return result;
}

// Copy abstract heap objects together so aliases remain aliases inside each path.
export function cloneEnv(env) {
  const seen = new Map();
  const clone = value => {
    if (!value || typeof value !== 'object' || value[TAG] === 'function' || isChoice(value)) return value;
    if (seen.has(value)) return seen.get(value);
    const result = Array.isArray(value) ? [] : {};
    if (value[TAG]) result[TAG] = value[TAG];
    seen.set(value, result);
    for (const [key, item] of Object.entries(value)) Object.defineProperty(result, key, {value:clone(item), enumerable:true, writable:true, configurable:true});
    return result;
  };
  return new Map([...env].map(([key,value]) => [key,clone(value)]));
}

export function createDomain(maxCandidates, diagnostic) {
  const overflow = node => {
    diagnostic('CANDIDATE_LIMIT', `超过 maxCandidates=${maxCandidates}，候选合并为未知`, node);
    return [{value:unknown('candidate limit'),conditions:[]}];
  };
  function choice(options, node) {
    const flat = [];
    for (const option of options) {
      for (const inner of isChoice(option.value) ? option.value[CHOICES] : [{value:option.value,conditions:[]}]) {
        const conditions = mergeConditions(option.conditions ?? [], inner.conditions);
        if (conditions && !flat.some(p => p.value === inner.value && JSON.stringify(p.conditions) === JSON.stringify(conditions))) flat.push({value:inner.value,conditions});
        if (flat.length > maxCandidates) return overflow(node)[0].value;
      }
    }
    if (!flat.length) return unknown('infeasible path');
    if (flat.length === 1 && !flat[0].conditions.length) return flat[0].value;
    return { [CHOICES]: flat };
  }
  function expand(value, node, seen = new Set()) {
    if (value && typeof value === 'object' && seen.has(value)) return [{value:unknown('cyclic object'),conditions:[]}];
    const nextSeen = value && typeof value === 'object' ? new Set(seen).add(value) : seen;
    if (isChoice(value)) {
      const result = [];
      for (const option of value[CHOICES]) for (const inner of expand(option.value,node,nextSeen)) {
        const conditions = mergeConditions(option.conditions,inner.conditions);
        if (conditions) result.push({value:inner.value,conditions});
        if (result.length > maxCandidates) return overflow(node);
      }
      return result;
    }
    if (value == null || typeof value !== 'object' || isUnknown(value) || ['function','client','intrinsic','request'].includes(value[TAG])) return [{value,conditions:[]}];
    let options = [{value:Array.isArray(value) ? [] : {},conditions:[]}];
    for (const [key,item] of Object.entries(value)) {
      const candidates = expand(item,node,nextSeen), next = [];
      for (const previous of options) for (const candidate of candidates) {
        const conditions = mergeConditions(previous.conditions,candidate.conditions);
        if (!conditions) continue;
        const object = Array.isArray(previous.value) ? [...previous.value] : {...previous.value};
        Object.defineProperty(object,key,{value:candidate.value,enumerable:true,writable:true,configurable:true});
        next.push({value:object,conditions});
        if (next.length > maxCandidates) return overflow(node);
      }
      options = next;
    }
    return options;
  }
  function lift(values, operation, node) {
    return choice(expand(values,node).map(option => ({value:isUnknown(option.value) ? option.value : operation(...option.value),conditions:option.conditions})),node);
  }
  return {choice,expand,lift};
}
