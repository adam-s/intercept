import { readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';

const polyfills = `
globalThis.document = globalThis.document || { createElement:()=>({setAttribute(){},appendChild(){},style:{},getContext:()=>({fillRect(){},getImageData:()=>({data:new Uint8ClampedArray(4)}),measureText:()=>({width:10,actualBoundingBoxAscent:10,actualBoundingBoxDescent:2,actualBoundingBoxLeft:0,actualBoundingBoxRight:10,fontBoundingBoxAscent:10,fontBoundingBoxDescent:2})})}), querySelector:()=>null, querySelectorAll:()=>[], createEvent:()=>({initEvent(){},preventDefault(){}}), referrer:"", location:{href:"https://newassets.hcaptcha.com/"}, documentElement:{lang:"en"}, getElementById:()=>null, body:null };
globalThis.location = globalThis.location || { href: "https://newassets.hcaptcha.com/" };
globalThis.screen = globalThis.screen || { width:1024, height:576, availWidth:1024, availHeight:576, colorDepth:24, pixelDepth:24, orientation:{type:"landscape-primary",angle:0}};
if (!('window' in globalThis)) globalThis.window = globalThis;
if (!('self' in globalThis)) globalThis.self = globalThis;
if (!('frames' in globalThis)) globalThis.frames = globalThis;
if (!('parent' in globalThis)) globalThis.parent = globalThis;
if (!('top' in globalThis)) globalThis.top = globalThis;
globalThis.outerWidth=1024; globalThis.outerHeight=576; globalThis.innerWidth=1024; globalThis.innerHeight=576; globalThis.devicePixelRatio=2;
globalThis.clientInformation = globalThis.navigator;
['Navigator','Document','Screen','Performance','SubtleCrypto','RTCRtpReceiver','RTCPeerConnection'].forEach(C => { if (!globalThis[C]) globalThis[C] = function(){}; });
globalThis.Worker = function(){throw new Error()};
globalThis.fetch = function(){throw new Error()};
globalThis.Blob = function(){};
// Polyfill OffscreenCanvas with a slightly more functional version
globalThis.OffscreenCanvas = function(w, h) {
  this.width = w; this.height = h;
  this.getContext = function(type) {
    if (type === '2d') return {
      fillRect(){}, fillText(){}, font:'', textBaseline:'',
      getImageData: ()=>({data:new Uint8ClampedArray(w*h*4)}),
      putImageData(){}, drawImage(){},
      measureText:(t)=>({width:t.length*10,actualBoundingBoxAscent:10,actualBoundingBoxDescent:2,actualBoundingBoxLeft:0,actualBoundingBoxRight:t.length*10,fontBoundingBoxAscent:10,fontBoundingBoxDescent:2}),
    };
    if (type === 'webgl' || type === 'webgl2') return null;
    return null;
  };
  this.transferToImageBitmap = () => ({});
  this.convertToBlob = () => Promise.resolve(new globalThis.Blob());
};
globalThis.ImageData = function(d,w,h){this.data=d;this.width=w;this.height=h;};
globalThis.HTMLCanvasElement = function(){};
globalThis.CanvasRenderingContext2D = function(){};
globalThis.WebGLRenderingContext = function(){};
globalThis.WebGL2RenderingContext = function(){};
globalThis.AudioContext = function(){return {state:'running',close:async()=>{}}};
globalThis.OfflineAudioContext = function(){};
globalThis.HTMLImageElement = function(){};
globalThis.Image = function(){};
`;
runInThisContext(polyfills);

const orig = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
let rngCount = 0;
globalThis.crypto.getRandomValues = (buf) => {
	rngCount++;
	return orig(buf);
};

runInThisContext(readFileSync('/tmp/hsw.js', 'utf8'));
await globalThis.hsw('IiI=.eyJzIjowLCJmIjowLCJjIjowfQ==.');
rngCount = 0;
const jwt = readFileSync('/tmp/match-jwt.txt', 'utf8');
const opts = JSON.parse(readFileSync('/tmp/match-opts.json', 'utf8'));
const proof = await globalThis.hsw(jwt, opts);
console.log(`with OffscreenCanvas: proof=${proof.length}, rng=${rngCount}`);
