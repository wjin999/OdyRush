"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createWorld,createBrowser,flush}=require("./support/browser.cjs");
const {makeTheater12}=require("./support/theater12.cjs");
const {completionKey}=require("../OdyRush.user.js");

test("delayed seat data waits, then selects and recognizes hash-only ticket success",async()=>{
  const world=createWorld();
  const browser=createBrowser(world,{seats:[]});
  await browser.start();
  await world.clock.advance(900);
  assert.deepEqual(browser.clicked,[]);
  browser.loadSeats(makeTheater12());
  await world.clock.advance(400);
  assert.deepEqual(browser.clicked,[]);
  await world.clock.advance(300);
  assert.deepEqual(browser.clicked,["M20","M21"]);
  assert.equal(browser.terms.checked,true);
  assert.equal(browser.submitCalls,1);
  assert.ok(world.storage.has(completionKey("020123")));
  assert.ok(browser.observers.some(o=>o.connected));
});

test("same-performance waiter takes over when first tab times out loading",async()=>{
  const world=createWorld();
  const first=createBrowser(world,{seats:[]});
  const second=createBrowser(world);
  await first.start();await second.start();
  await world.clock.advance(1000);
  assert.deepEqual(second.clicked,[]);
  await world.clock.advance(30000);
  assert.deepEqual(first.clicked,[]);
  assert.match(first.status(),/未加载完成/);
  assert.deepEqual(second.clicked,["M20","M21"]);
});

test("same-performance waiter skips after first success, including manual button",async()=>{
  const world=createWorld();
  const first=createBrowser(world);const second=createBrowser(world);
  await first.start();await second.start();await world.clock.advance(1000);
  assert.equal(first.submitCalls,1);assert.equal(second.submitCalls,0);
  assert.match(second.status(),/已有标签完成/);
  second.control("auto").click();await flush();
  assert.deepEqual(second.clicked,[]);
});

test("different performances neither block nor overwrite each other's success record",async()=>{
  const world=createWorld();
  const first=createBrowser(world,{seats:[],performanceId:"020111"});
  const second=createBrowser(world,{performanceId:"020222"});
  await first.start();await second.start();await world.clock.advance(1000);
  assert.equal(second.submitCalls,1);assert.equal(first.submitCalls,0);
  first.loadSeats(makeTheater12());await world.clock.advance(1000);
  assert.ok(world.storage.has(completionKey("020111")));
  assert.ok(world.storage.has(completionKey("020222")));
});

test("stop cancels a queued tab and permits the next waiter to proceed",async()=>{
  const world=createWorld();
  const first=createBrowser(world,{seats:[]});
  const second=createBrowser(world);const third=createBrowser(world);
  await first.start();await second.start();await third.start();
  second.control("stop").click();await flush();
  first.control("stop").click();await world.clock.advance(1000);
  assert.deepEqual(second.clicked,[]);assert.equal(third.submitCalls,1);
});

test("route change cancels stale work and mounts a new performance panel",async()=>{
  const world=createWorld();const browser=createBrowser(world,{seats:[]});
  await browser.start();
  browser.navigate("#/purchase/seat?performanceId=020456");await flush();
  browser.loadSeats(makeTheater12());await world.clock.advance(1000);
  assert.equal(browser.submitCalls,1);
  assert.equal(world.storage.has(completionKey("020123")),false);
  assert.equal(world.storage.has(completionKey("020456")),true);
});

test("unknown IDs do not auto-run or share a fabricated completion identity",async()=>{
  const world=createWorld();
  const browser=createBrowser(world,{url:"https://transaction.ticket-cinemasunshine.com/projects/x#/purchase/seat"});
  await browser.start();await world.clock.advance(1000);
  assert.deepEqual(browser.clicked,[]);assert.match(browser.status(),/无法确认场次编号/);
  browser.control("auto").click();await world.clock.advance(1000);
  assert.equal(browser.submitCalls,1);
  assert.equal([...world.storage.keys()].some(k=>k.startsWith("odyrush.auto-success")),false);
});

test("non-target theater never mounts automatic selection",async()=>{
  const world=createWorld();const browser=createBrowser(world,{performanceId:"999123"});
  await browser.start();await world.clock.advance(1000);
  assert.deepEqual(browser.clicked,[]);assert.equal(browser.control("auto"),undefined);
});

test("only managed hidden target failure tabs actually request close",async()=>{
  for(const {managed,visibility,id,expected} of [
    {managed:false,visibility:"hidden",id:"020123",expected:0},
    {managed:true,visibility:"visible",id:"020123",expected:0},
    {managed:true,visibility:"hidden",id:"999123",expected:0},
    {managed:true,visibility:"hidden",id:"020123",expected:1},
  ]) {
    const world=createWorld();
    const browser=createBrowser(world,{url:`https://transaction.ticket-cinemasunshine.com/?performanceId=${id}#/error`,
      tabData:managed?{odyrush:{createdAt:world.clock.now(),token:"test"}}:{},visibility});
    await browser.start();assert.equal(browser.closeCalls,expected);
  }
});

test("managed opener uses a bridge and preserves exact destination including auth query/hash",async()=>{
  const world=createWorld();
  const schedule=createBrowser(world,{url:"https://www.cinemasunshine.co.jp/theater/gdcs/#schedule"});
  await schedule.start();
  const href="https://login.member.cinemasunshine.co.jp/auth?redirect_uri=https%3A%2F%2Ftransaction.ticket-cinemasunshine.com%2F&state=abc#existing";
  let prevented=false;
  schedule.document.dispatch("click",{target:schedule.link(href),ctrlKey:true,button:0,
    preventDefault(){prevented=true},stopImmediatePropagation(){}});
  assert.equal(prevented,true);assert.equal(schedule.opened.length,1);
  const bridge=createBrowser(world,{url:schedule.opened[0].url});
  await bridge.start();
  assert.deepEqual(bridge.redirects,[href]);
  assert.ok(bridge.tabData.odyrush.token);
  assert.equal([...world.shared.keys()].some(k=>k.startsWith("odyrush.launch.")),false);
  const login=createBrowser(world,{url:"https://login.member.cinemasunshine.co.jp/auth",tabData:bridge.tabData,
    bodyText:"お使いのブラウザのcookieが制限されています。"});
  await login.start();assert.equal(login.closeCalls,1);
});

test("premium setting controls actual clicks on the DOM",async()=>{
  const seats=makeTheater12().map(s=>({...s,available:s.row==="N"}));
  for(const allowPremium of [false,true]) {
    const world=createWorld();world.shared.set("odyrush.settings.v1",{count:2,allowPremium});
    const browser=createBrowser(world,{seats});await browser.start();await world.clock.advance(1000);
    assert.deepEqual(browser.clicked,allowPremium?["N16","N17"]:[]);
  }
});

test("partial selection failure leaves seats for manual recovery and never submits",async()=>{
  const world=createWorld();const browser=createBrowser(world,{missingTerms:true});
  await browser.start();await world.clock.advance(1000);
  assert.deepEqual(browser.clicked,["M20","M21"]);assert.equal(browser.submitCalls,0);
  assert.match(browser.status(),/复选框/);
  browser.control("auto").click();await world.clock.advance(1000);
  assert.deepEqual(browser.clicked,["M20","M21"]);assert.match(browser.status(),/已有选中座位/);
});
