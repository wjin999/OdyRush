"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  detectKnownFailure, findBestSeats, hasExcludedSeatClass, isTargetScheduleLocation,
  isSeatRoute, isTicketRoute, isTicketDestination, normalizedSettings, parseSeatLabel,
  typicalSeatGap, isCentralSeat, isTheater12Map, performanceIdFromLocation,
  shouldCloseFailure, completionKey,
} = require("../OdyRush.user.js");
const { makeTheater12 } = require("./support/theater12.cjs");

test("normal and full-width seat labels", () => {
  assert.deepEqual(parseSeatLabel(" j-０９ "), {row:"J", number:9, label:"J9"});
  assert.equal(parseSeatLabel("SCREEN"), null);
});

test("recognizes schedule and supported seat/ticket routes", () => {
  assert.equal(isTargetScheduleLocation("www.cinemasunshine.co.jp", "/theater/gdcs/"), true);
  assert.equal(isTargetScheduleLocation("www.cinemasunshine.co.jp", "/theater/other/"), false);
  assert.equal(isSeatRoute("#/purchase/seat?performanceId=020123"), true);
  assert.equal(isSeatRoute("#/error"), false);
  assert.equal(isTicketRoute({hash:"#/purchase/ticket"}), true);
  assert.equal(isTicketRoute({pathname:"/purchase/ticket"}), true);
  assert.equal(isTicketRoute({hash:"#/purchase/ticket-other"}), false);
});

test("ticket takeover only accepts HTTPS ticket/auth hosts", () => {
  const base = "https://www.cinemasunshine.co.jp/theater/gdcs/";
  assert.equal(isTicketDestination("https://transaction.ticket-cinemasunshine.com/projects/x", base), true);
  assert.equal(isTicketDestination("https://login.member.cinemasunshine.co.jp/auth?redirect_uri=x", base), true);
  assert.equal(isTicketDestination("http://transaction.ticket-cinemasunshine.com/", base), false);
  assert.equal(isTicketDestination("/theater/other/", base), false);
});

test("settings migrate to central area with premium seats disabled", () => {
  assert.deepEqual(normalizedSettings({count:3, preference:"center"}), {
    count:3, area:"central", allowPremium:false, autoSelect:true, autoCloseFailures:true,
  });
  assert.deepEqual(normalizedSettings({count:0, area:"all", allowPremium:true, autoSelect:false, autoCloseFailures:false}), {
    count:2, area:"all", allowPremium:true, autoSelect:false, autoCloseFailures:false,
  });
});

test("screenshot profile recognizes missing I/L rows and rejects incomplete/other maps", () => {
  const seats = makeTheater12();
  assert.equal(isTheater12Map(seats), true);
  assert.equal(isTheater12Map(seats.filter(s => s.label !== "G22")), false);
  assert.equal(isTheater12Map(seats.filter(s => s.row !== "R")), false);
  assert.equal(isTheater12Map(seats.map(s => ({...s, x:0, y:0}))), false);
  assert.equal(isTheater12Map([...seats, {...seats[0], row:"L", label:"L1"}]), false);
});

test("central region follows blue outline including differently numbered premium rows", () => {
  for (const [row, number, expected] of [
    ["F",20,false], ["G",10,false], ["G",11,true], ["G",22,true], ["G",31,false],
    ["M",11,true], ["M",30,true], ["M",31,false], ["N",22,true], ["N",23,false],
    ["R",20,true], ["R",21,false],
  ]) assert.equal(isCentralSeat({row, number}), expected, `${row}${number}`);
});

test("default viewing ranking chooses the middle of M row for two", () => {
  assert.deepEqual(findBestSeats(makeTheater12(), 2).labels, ["M20", "M21"]);
});

test("ranks by physical centers, not seat numbers in premium rows", () => {
  const seats = makeTheater12().map(s => ({...s, available:s.row === "N"}));
  assert.equal(findBestSeats(seats, 2), null);
  assert.deepEqual(findBestSeats(seats, 2, {allowPremium:true}).labels, ["N16", "N17"]);
});

test("premium allowance is eligibility, not a price-based preference", () => {
  assert.deepEqual(findBestSeats(makeTheater12(), 2, {allowPremium:true}).labels, ["M20", "M21"]);
  const seats = makeTheater12().map(s => ({...s, available:["G", "N", "R"].includes(s.row)}));
  assert.equal(findBestSeats(seats, 2), null);
  assert.equal(findBestSeats(seats, 2, {allowPremium:true}).row, "N");
});

test("full hall includes front/side seats; central never silently expands", () => {
  for (const labels of [["F20", "F21"], ["M9", "M10"]]) {
    const seats = makeTheater12().map(s => ({...s, available:labels.includes(s.label)}));
    assert.equal(findBestSeats(seats, 2), null);
    assert.deepEqual(findBestSeats(seats, 2, {area:"all"}).labels, labels);
  }
});

test("sold and already selected seats break a continuous group", () => {
  for (const selected of [false, true]) {
    const seats = makeTheater12().map(s => ({...s, available:["M19","M20","M21"].includes(s.label),
      selected:selected && s.label === "M20"}));
    if (!selected) seats.find(s => s.label === "M20").available = false;
    assert.equal(findBestSeats(seats, 3), null);
  }
});

test("never bridges either main aisle, including full hall mode", () => {
  for (const labels of [["M10", "M11"], ["M30", "M31"]]) {
    const seats = makeTheater12().map(s => ({...s, available:labels.includes(s.label)}));
    assert.equal(findBestSeats(seats, 2, {area:"all"}), null);
  }
  assert.equal(typicalSeatGap([0,44,96,140].map(x => ({x}))), 44);
});

test("special seats stay excluded with premium enabled; classes cannot mix", () => {
  assert.equal(hasExcludedSeatClass(["seat-grand-class"]), false);
  assert.equal(hasExcludedSeatClass(["seat-hc"]), true);
  assert.equal(hasExcludedSeatClass(["seat-comfort"]), true);
  const seats = makeTheater12().map(s => ({...s, available:["M20","M21"].includes(s.label)}));
  seats.find(s => s.label === "M20").special = true;
  assert.equal(findBestSeats(seats, 2, {allowPremium:true}), null);
  seats.find(s => s.label === "M20").special = false;
  seats.find(s => s.label === "M20").seatClass = "premium";
  assert.equal(findBestSeats(seats, 2, {allowPremium:true}), null);
});

test("group sizes 1–6 remain consecutive and within requested bounds", () => {
  for (let count=1; count<=6; count++) {
    const result = findBestSeats(makeTheater12(), count);
    assert.equal(result.row, "M");
    assert.equal(result.seats.length, count);
    assert.ok(result.seats.every((s,i,a) => !i || s.number === a[i-1].number+1));
  }
  for (const count of [0,7,1.5,NaN]) assert.throws(() => findBestSeats([],count), /1 到 6/);
});

test("performance IDs support hash, query, and numeric legacy entry URLs", () => {
  assert.equal(performanceIdFromLocation({hash:"#/purchase/seat?performanceId=020123"}), "020123");
  assert.equal(performanceIdFromLocation({search:"?eventId=020456"}), "020456");
  assert.equal(performanceIdFromLocation({hash:"#/purchase/seat?performanceId=020222", search:"?performanceId=020111"}), "020222");
  assert.equal(performanceIdFromLocation({pathname:"/projects/x/transaction/020999"}), "020999");
  assert.equal(performanceIdFromLocation({pathname:"/transaction/opaque-uuid"}), "");
  assert.notEqual(completionKey("020123"), completionKey("020456"));
});

test("only exact known failures are recognized", () => {
  const hostname = "transaction.ticket-cinemasunshine.com";
  assert.equal(detectKnownFailure({hostname,hash:"#/error"}).code, "error");
  assert.equal(detectKnownFailure({hostname,hash:"#/congestion?x=1"}).code, "congestion");
  assert.equal(detectKnownFailure({hostname,hash:"#/error-recovery"}), null);
  assert.equal(detectKnownFailure({hostname,hash:"#/purchase/seat"}), null);
  assert.equal(detectKnownFailure({hostname:"login.member.cinemasunshine.co.jp"}, "お使いのブラウザのcookieが制限されています。").code, "cookie");
});

test("closing requires managed provenance, hidden state, current marker, target theater and enabled setting", () => {
  const good = {failure:{code:"error"}, autoCloseFailures:true, visibilityState:"hidden", managed:{createdAt:Date.now()}, performanceId:"020123"};
  assert.equal(shouldCloseFailure(good), true);
  for (const override of [{managed:null}, {visibilityState:"visible"}, {autoCloseFailures:false}, {performanceId:"999123"},
    {failure:null}, {managed:{createdAt:0}}, {managed:{createdAt:Date.now()+100000}}]) {
    assert.equal(shouldCloseFailure({...good,...override}), false);
  }
});
