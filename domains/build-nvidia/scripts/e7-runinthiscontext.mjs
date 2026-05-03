import { readFileSync } from 'node:fs';

// Use vm.runInThisContext to avoid creating a new realm — types stay the same
const polyfills = `
globalThis.document = globalThis.document || { createElement:()=>({setAttribute(){},appendChild(){},style:{}}), querySelector:()=>null, querySelectorAll:()=>[], createEvent:()=>({initEvent(){},preventDefault(){}}), referrer:"", location:{href:"https://newassets.hcaptcha.com/"}, documentElement:{lang:"en"}, getElementById:()=>null, body:null };
globalThis.location = globalThis.location || { href: "https://newassets.hcaptcha.com/" };
globalThis.screen = globalThis.screen || { width:1024, height:576, availWidth:1024, availHeight:576, colorDepth:24, pixelDepth:24, orientation:{type:"landscape-primary",angle:0}};
if (!('window' in globalThis)) globalThis.window = globalThis;
if (!('self' in globalThis)) globalThis.self = globalThis;
if (!('frames' in globalThis)) globalThis.frames = globalThis;
if (!('parent' in globalThis)) globalThis.parent = globalThis;
if (!('top' in globalThis)) globalThis.top = globalThis;
globalThis.outerWidth=globalThis.outerWidth||1024;
globalThis.outerHeight=globalThis.outerHeight||576;
globalThis.innerWidth=globalThis.innerWidth||1024;
globalThis.innerHeight=globalThis.innerHeight||576;
globalThis.devicePixelRatio=globalThis.devicePixelRatio||2;
if (!globalThis.clientInformation) globalThis.clientInformation = globalThis.navigator;
['Navigator','Document','Screen','Performance','SubtleCrypto','RTCRtpReceiver','RTCPeerConnection'].forEach(C => { if (!globalThis[C]) globalThis[C] = function(){}; });
globalThis.Worker = globalThis.Worker || function(){throw new Error()};
globalThis.fetch = globalThis.fetch || function(){throw new Error()};
globalThis.Blob = globalThis.Blob || function(){};
`;

import { runInThisContext } from 'node:vm';

runInThisContext(polyfills);

// Count RNG
const orig = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
let rngCount = 0;
globalThis.crypto.getRandomValues = (buf) => {
	rngCount++;
	return orig(buf);
};

// Load hsw.js into THIS realm
runInThisContext(readFileSync('/tmp/hsw.js', 'utf8'));
console.log('hsw type:', typeof globalThis.hsw);

await globalThis.hsw('IiI=.eyJzIjowLCJmIjowLCJjIjowfQ==.');
rngCount = 0;
const jwt = readFileSync('/tmp/match-jwt.txt', 'utf8');
const opts = JSON.parse(readFileSync('/tmp/match-opts.json', 'utf8'));
const proof = await globalThis.hsw(jwt, opts);
console.log(`proof: ${proof.length}, rng calls: ${rngCount}`);
