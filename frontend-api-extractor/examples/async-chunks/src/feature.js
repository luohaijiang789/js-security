import {send} from './transport.js';
export const load=account=>send(['v2','users','lookup'].join('/'),{account});
