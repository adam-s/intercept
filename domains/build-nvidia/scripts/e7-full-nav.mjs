import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';

const win = new Window({
  url: 'https://newassets.hcaptcha.com/captcha/v1/c6e277da86802178b920b24f7bd79dd5d0c81e0d/static/hcaptcha.html#frame=challenge&id=0gtest&host=build.nvidia.com&sentry=true&reportapi=https%3A%2F%2Faccounts.hcaptcha.com&recaptchacompat=true&custom=false&hl=en&tplinks=on&andint=off&pstissuer=https%3A%2F%2Fpst-issuer.hcaptcha.com&sitekey=0c6a1e45-75d7-43cc-b836-a0c9d886b8ee&theme=dark&size=invisible&origin=https%3A%2F%2Fbuild.nvidia.com',
});
win.document.documentElement.setAttribute('data-id', 'hcaptcha-frame-c6e277da86802178b920b24f7bd79dd5d0c81e0d');
win.WebAssembly = WebAssembly;

// Add ALL the missing Chrome navigator properties to happy-dom's navigator prototype
// Has them as ENUMERABLE OWN properties on the navigator object itself
win.eval(`
const chromeNavExtras = {
  // empty objects (Chrome reports them as objects with 0 keys)
  bluetooth: {}, clipboard: {}, connection: { effectiveType: '4g', downlink: 10, rtt: 50, saveData: false },
  credentials: {}, devicePosture: {}, geolocation: {}, gpu: {}, hid: {}, ink: {}, keyboard: {},
  locks: {}, login: {}, managed: {}, mediaCapabilities: {}, mediaDevices: {}, mediaSession: {},
  permissions: {}, presentation: {}, scheduling: {}, serial: {}, serviceWorker: {},
  storage: {}, storageBuckets: {}, usb: {}, userActivation: {}, virtualKeyboard: {},
  wakeLock: {}, webkitTemporaryStorage: {}, webkitPersistentStorage: {}, windowControlsOverlay: {},
  xr: {}, protectedAudience: {},
  // primitives
  appCodeName: 'Mozilla', appName: 'Netscape',
  appVersion: '5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
  product: 'Gecko', productSub: '20030107', vendor: 'Google Inc.', vendorSub: '',
  platform: 'MacIntel', language: 'en-US', languages: ['en-US'],
  onLine: true, doNotTrack: null, hardwareConcurrency: 12, deviceMemory: 8,
  maxTouchPoints: 0, cookieEnabled: true, webdriver: false, pdfViewerEnabled: false,
  deprecatedRunAdAuctionEnforcesKAnonymity: false,
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
  // functions (return reasonable values)
  getBattery: () => Promise.resolve({ level: 1, charging: true, addEventListener(){}, removeEventListener(){} }),
  getGamepads: () => [],
  getInstalledRelatedApps: () => Promise.resolve([]),
  getUserMedia: () => Promise.resolve({}),
  vibrate: () => true,
  sendBeacon: () => true,
  registerProtocolHandler: () => {},
  unregisterProtocolHandler: () => {},
  requestMIDIAccess: () => Promise.resolve({}),
  requestMediaKeySystemAccess: () => Promise.resolve({}),
  javaEnabled: () => false,
  webkitGetUserMedia: () => {},
  // Ad auction APIs
  joinAdInterestGroup: () => Promise.resolve(),
  leaveAdInterestGroup: () => Promise.resolve(),
  runAdAuction: () => Promise.resolve(null),
  updateAdInterestGroups: () => {},
  createAuctionNonce: () => '',
  canLoadAdAuctionFencedFrame: () => false,
  adAuctionComponents: () => [],
  clearOriginJoinedAdInterestGroups: () => Promise.resolve(),
  deprecatedReplaceInURN: () => Promise.resolve(),
  deprecatedURNToURL: () => Promise.resolve(null),
  getInterestGroupAdAuctionData: () => Promise.resolve({}),
  clearAppBadge: () => Promise.resolve(),
  setAppBadge: () => Promise.resolve(),
  // userAgentData
  userAgentData: {
    brands: [{brand:'Not:A-Brand',version:'99'},{brand:'Google Chrome',version:'145'},{brand:'Chromium',version:'145'}],
    mobile: false, platform: 'macOS',
    getHighEntropyValues: () => Promise.resolve({architecture:'arm',bitness:'64',brands:[],fullVersionList:[],mobile:false,model:'',platform:'macOS',platformVersion:'14.6.0',uaFullVersion:'145.0.0.0',wow64:false}),
    toJSON: function() { return { brands: this.brands, mobile: this.mobile, platform: this.platform }; },
  },
  plugins: { length: 0 },
  mimeTypes: { length: 0 },
};
// Set as own enumerable properties on navigator
for (const k in chromeNavExtras) {
  try { Object.defineProperty(navigator, k, { value: chromeNavExtras[k], writable: true, enumerable: true, configurable: true }); } catch (e) {}
}
console.log('navigator total enumerable own:', Object.keys(navigator).length);
`);

win.eval(readFileSync('/tmp/hsw.js', 'utf8'));
await win.hsw('IiI=.eyJzIjowLCJmIjowLCJjIjowfQ==.');
const jwt = readFileSync('/tmp/match-jwt.txt', 'utf8');
const opts = JSON.parse(readFileSync('/tmp/match-opts.json', 'utf8'));
const proof = await win.hsw(jwt, opts);
console.log(`proof: ${proof?.length} (target: 19848)`);
await win.close();
