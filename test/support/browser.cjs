"use strict";
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const {makeTheater12} = require("./theater12.cjs");
const source = fs.readFileSync(path.join(__dirname, "../../OdyRush.user.js"), "utf8");
const flush = async () => { for (let i=0; i<30; i++) await Promise.resolve(); };

function createWorld() {
  let now = Date.now();
  let nextTimer = 0;
  const timers = new Map();
  const storage = new Map();
  const shared = new Map();
  const lockQueues = new Map();
  const acquisitions = [];
  const clock = {
    now:() => now,
    setTimeout(fn, delay=0) {const id=++nextTimer; timers.set(id,{at:now+delay,fn}); return id;},
    clearTimeout:id => timers.delete(id),
    async advance(duration) {
      await flush();
      const end = now+duration;
      let iterations = 0;
      while (true) {
        const next = [...timers.entries()].filter(([,t]) => t.at<=end).sort((a,b) => a[1].at-b[1].at)[0];
        if (!next) break;
        if (++iterations>100000) throw new Error("Timer loop did not settle");
        now=next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
      }
      now=end; await flush();
    },
  };
  const locks = {
    request(name, options, callback) {
      return new Promise((resolve,reject) => {
        if (options.signal?.aborted) return reject(new DOMException("Aborted","AbortError"));
        if (!lockQueues.has(name)) lockQueues.set(name,[]);
        const queue=lockQueues.get(name);
        const entry={active:false, start() {
          entry.active=true;
          acquisitions.push(name);
          Promise.resolve().then(() => callback({name})).then(resolve,reject).finally(() => {
            queue.shift(); queue[0]?.start();
          });
        }};
        options.signal?.addEventListener("abort", () => {
          if (entry.active) return; // Web Locks does not abort an already granted callback.
          const index=queue.indexOf(entry);
          if(index>=0) queue.splice(index,1);
          reject(new DOMException("Aborted","AbortError"));
        }, {once:true});
        queue.push(entry);
        if(queue.length===1) entry.start();
      });
    },
  };
  return {clock,storage,shared,locks,acquisitions};
}

function createBrowser(world, options={}) {
  const observers=[];
  const elements=new Map();
  const session=new Map();
  const clicked=[];
  let seatData=options.seats ?? makeTheater12();
  let anchors=[];
  let closeCalls=0;
  let submitCalls=0;
  let tabData=options.tabData || {};
  const redirects=[];
  const opened=[];
  const storage=map => ({getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,String(v)),removeItem:k=>map.delete(k)});
  const notify=()=>observers.forEach(o=>{if(o.connected) queueMicrotask(o.fn)});
  class FakeElement {
    constructor() {
      this.dataset={}; this.style={}; this.listeners=new Map(); this.attributes=new Map();
      this.value=""; this.disabled=false; this.checked=false; this.textContent=""; this.isConnected=true;
      const classes=new Set();
      this.classList={contains:c=>classes.has(c),add:c=>classes.add(c),remove:c=>classes.delete(c),[Symbol.iterator]:()=>classes[Symbol.iterator]()};
    }
    addEventListener(name, fn) {if(!this.listeners.has(name))this.listeners.set(name,[]);this.listeners.get(name).push(fn)}
    dispatch(name, extra={}) {for(const fn of this.listeners.get(name)||[]) fn({target:this,...extra})}
    click() {if(!this.disabled){this.onClick?.();this.dispatch("click")}}
    appendChild(el) {elements.set(el.id,el); el.isConnected=true; notify()}
    remove() {elements.delete(this.id);this.isConnected=false;notify()}
    setAttribute(k,v) {this.attributes.set(k,v)}
    removeAttribute(k) {this.attributes.delete(k)}
    getAttribute(k) {return this.attributes.get(k)??null}
    getBoundingClientRect() {return this.rect||{left:0,top:0,width:20,height:20}}
    scrollIntoView() {}
    closest(selector) {return selector===".seat" ? this.wrapper : selector==="a[href]" && this.href ? this : null}
    attachShadow() {
      const controls=new Map();
      this.shadowRoot={getElementById:id=>controls.get(id)||null,
        set innerHTML(html) {
          for(const m of html.matchAll(/<(input|select|button|div)[^>]*id="([^"]+)"[^>]*>/g)) {
            const el=new FakeElement(); el.value=m[0].match(/value="([^"]*)"/)?.[1]||"";
            controls.set(m[2],el);
          }
        }};
      return this.shadowRoot;
    }
  }
  const document=new FakeElement();
  document.body=new FakeElement(); document.body.innerText=options.bodyText||"";
  document.head=new FakeElement(); document.documentElement=new FakeElement();
  document.title="Cinema"; document.visibilityState=options.visibility||"hidden";
  document.createElement=()=>new FakeElement();
  document.getElementById=id=>elements.get(id)||null;
  const page=new FakeElement(); page.textContent=options.venue??"グランドシネマサンシャイン 池袋 IMAX シアター12";
  const terms=new FakeElement(); terms.onClick=()=>{terms.checked=!terms.checked};
  const submit=new FakeElement(); submit.textContent="次へ";
  const location=new URL(options.url||`https://transaction.ticket-cinemasunshine.com/projects/x#/purchase/seat?performanceId=${options.performanceId||"020123"}`);
  location.replace=url=>{redirects.push(url);location.href=url};
  const window=new FakeElement();
  Object.assign(window,{location,document,localStorage:storage(world.storage),sessionStorage:storage(session),
    queueMicrotask,setTimeout:world.clock.setTimeout,clearTimeout:world.clock.clearTimeout,
    navigator:{locks:world.locks},getComputedStyle:()=>({display:"block",visibility:"visible"}),
    close:()=>closeCalls++,crypto:require("node:crypto").webcrypto,onurlchange:null});
  submit.onClick=()=>{
    submitCalls++;
    if(options.submitFails) return;
    location.hash="#/purchase/ticket";
    window.dispatch("hashchange");
    notify();
  };
  const seatRoute=()=>location.hash.startsWith("#/purchase/seat");
  document.querySelector=selector=>{
    if(selector==="app-purchase-seat") return seatRoute()?page:null;
    if(selector.includes("input#terms")) return options.missingTerms?null:terms;
    if(selector.includes('button[type="submit"]')) return submit;
    return null;
  };
  document.querySelectorAll=selector=>{
    if(selector==="app-purchase-seat app-screen .screen-inner .seat > a") return seatRoute()?anchors:[];
    if(selector==="app-modal") return options.modal?[Object.assign(new FakeElement(),{textContent:"Test blocking modal"})]:[];
    if(selector.startsWith("[data-odyrush-recommended")) return anchors.filter(a=>a.getAttribute("data-odyrush-recommended"));
    return [];
  };
  function loadSeats(seats) {
    seatData=seats;
    anchors=seats.map(seat=>{
      const a=new FakeElement();a.textContent=seat.label;
      const wrapper=new FakeElement();wrapper.rect={left:seat.x-5,top:seat.y-5,width:10,height:10};
      if(seat.seatClass==="premium")wrapper.classList.add("seat-premium-class");
      if(seat.seatClass==="grand")wrapper.classList.add("seat-grand-class");
      if(seat.special)wrapper.classList.add("seat-hc");
      a.wrapper=wrapper;
      if(!seat.available)a.classList.add("disabled");
      if(seat.selected)a.classList.add("active");
      a.onClick=()=>{
        clicked.push(seat.label);
        if(options.ignoreSeatClicks)return;
        if(a.classList.contains("active"))a.classList.remove("active");else a.classList.add("active");
        notify();
      };
      return a;
    });
    notify();
  }
  loadSeats(seatData);
  class MutationObserver {constructor(fn){this.fn=fn;this.connected=false;observers.push(this)}observe(){this.connected=true}disconnect(){this.connected=false}}
  class FakeDate extends Date {static now(){return world.clock.now()}}
  const context={module:{exports:{}},URL,URLSearchParams,console,Date:FakeDate,AbortController,
    MutationObserver,HTMLElement:FakeElement,Element:FakeElement,
    GM_getValue:(k,fallback)=>world.shared.get(k)??fallback,
    GM_setValue:(k,v)=>world.shared.set(k,v),GM_deleteValue:k=>world.shared.delete(k),
    GM_getTab:cb=>cb(tabData),GM_saveTab:(tab,cb)=>{tabData=tab;cb?.()},
    GM_openInTab:(url,opts)=>opened.push({url,opts})};
  vm.createContext(context);
  vm.runInContext(source,context);
  Object.assign(context,{window,document});
  return {world,window,document,context,clicked,terms,redirects,opened,observers,loadSeats,
    start:async()=>{await context.module.exports.start();await flush()},
    status:()=>elements.get("odyrush-panel-host")?.shadowRoot.getElementById("status").textContent||"",
    control:id=>elements.get("odyrush-panel-host")?.shadowRoot.getElementById(id),
    get closeCalls(){return closeCalls},get submitCalls(){return submitCalls},get tabData(){return tabData},
    navigate(hash){location.hash=hash;window.dispatch("hashchange");notify()},
    link(href){const a=new FakeElement();a.href=href;return a},
  };
}
module.exports={createWorld,createBrowser,flush};
