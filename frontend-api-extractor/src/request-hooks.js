import ts from 'typescript';
import {TAG,CLIENT_STATE,isUnknown} from './values.js';

export const newHookState=()=>({hooks:[],seen:new Set(),gaps:[],nextId:0});

export function interceptorProperty(value,name) {
  if(value?.[TAG]==='client'&&value.kind==='axios'&&value[CLIENT_STATE]&&name==='interceptors')return {[TAG]:'intrinsic',method:'axios-interceptors',state:value[CLIENT_STATE]};
  if(value?.[TAG]==='intrinsic'&&value.method==='axios-interceptors'&&name==='request')return {[TAG]:'intrinsic',method:'axios-request-manager',state:value.state};
  if(value?.[TAG]==='intrinsic'&&value.method==='axios-interceptors'&&name==='response')return {[TAG]:'intrinsic',method:'axios-response-manager'};
  if(value?.[TAG]==='intrinsic'&&value.method==='axios-request-manager'&&['use','eject','clear'].includes(name))return {[TAG]:'intrinsic',method:'axios-request-'+name,state:value.state};
  if(value?.[TAG]==='intrinsic'&&value.method==='axios-response-manager'&&['use','eject','clear'].includes(name))return {[TAG]:'intrinsic',method:'axios-response-'+name};
}

// Deliberately small grammar. Unsupported callbacks remain evidence, never execute.
export function inspectHook(fn,rejected,options,isIntrinsic,resolveSymbol,safeCapture) {
  if(fn?.[TAG]!=='function')return 'fulfillment callback unresolved';
  if(options?.synchronous!==true || isUnknown(options))return 'explicit synchronous:true required';
  if(options.runWhen!==undefined)return 'runWhen not modeled';
  if(rejected!=null)return 'rejection callback not modeled';
  const node=fn.node;
  if(node.modifiers?.some(m=>m.kind===ts.SyntaxKind.AsyncKeyword))return 'async callback';
  if(node.parameters.length!==1||!ts.isIdentifier(node.parameters[0].name))return 'single config parameter required';
  const aliases=new Set([resolveSymbol(node.parameters[0].name)]);
  const root=n=>{while(n&&(ts.isPropertyAccessExpression(n)||ts.isElementAccessExpression(n)))n=n.expression;return n&&ts.isIdentifier(n)?resolveSymbol(n):null;};
  const calls=new Set(['Object.assign','JSON.stringify','JSON.parse','encodeURIComponent','decodeURIComponent','encodeURI','decodeURI','atob','String.fromCharCode']);
  let gap;
  const visit=n=>{
    if(gap)return;
    if(ts.isIdentifier(n)&&!safeCapture(n)){gap='captured heap state not modeled';return;}
    if(n!==node&&ts.isFunctionLike(n)){gap='nested callback';return;}
    if(ts.isIfStatement(n)||ts.isConditionalExpression(n)||ts.isForStatement(n)||ts.isForOfStatement(n)||ts.isForInStatement(n)||ts.isWhileStatement(n)||ts.isDoStatement(n)||ts.isSwitchStatement(n)||ts.isTryStatement(n)||ts.isThrowStatement(n)||ts.isAwaitExpression(n)||ts.isNewExpression(n)||n.kind===ts.SyntaxKind.ThisKeyword){gap='control flow or unsupported effects';return;}
    if(ts.isBinaryExpression(n)&&[ts.SyntaxKind.AmpersandAmpersandToken,ts.SyntaxKind.BarBarToken,ts.SyntaxKind.QuestionQuestionToken].includes(n.operatorToken.kind)){gap='conditional expression';return;}
    if(ts.isVariableDeclaration(n)&&ts.isIdentifier(n.name)&&aliases.has(root(n.initializer)))aliases.add(resolveSymbol(n.name));
    if(ts.isBinaryExpression(n)&&n.operatorToken.kind>=ts.SyntaxKind.FirstAssignment&&n.operatorToken.kind<=ts.SyntaxKind.LastAssignment) {
      if(ts.isIdentifier(n.left)){gap='alias rebinding not modeled';return;}
      if(!aliases.has(root(n.left))){gap='write outside config aliases';return;}
    }
    if(ts.isDeleteExpression(n)&&!aliases.has(root(n.expression))){gap='delete outside config aliases';return;}
    if(ts.isCallExpression(n)) {
      if(!calls.has(n.expression.getText())){gap='call outside supported intrinsics';return;}
      if(!isIntrinsic(n.expression)){gap='shadowed intrinsic';return;}
      if(n.expression.getText()==='Object.assign'&&!aliases.has(root(n.arguments[0]))){gap='Object.assign target outside config aliases';return;}
    }
    ts.forEachChild(n,visit);
  };
  visit(node.body);
  return gap;
}
