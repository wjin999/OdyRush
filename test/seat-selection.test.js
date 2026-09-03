"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  detectKnownFailure,
  findBestSeats,
  hasExcludedSeatClass,
  isTargetScheduleLocation,
  isSeatRoute,
  isTicketDestination,
  normalizedSettings,
  parseSeatLabel,
  typicalSeatGap,
} = require("../OdyRush.user.js");

function makeRow(row, y, positions, options = {}) {
  return positions.map((x, index) => {
    const number = index + 1;
    return {
      row,
      number,
      label: `${row}${number}`,
      x,
      y,
      available: !options.unavailable?.includes(number),
      selected: false,
      special: options.special?.includes(number) || false,
    };
  });
}

test("parses normal and full-width seat labels", () => {
  assert.deepEqual(parseSeatLabel(" j-０９ "), {
    row: "J",
    number: 9,
    label: "J9",
  });
  assert.equal(parseSeatLabel("SCREEN"), null);
});

test("matches the current Grand Cinema Sunshine schedule URL", () => {
  const scheduleUrl = new URL(
    "https://www.cinemasunshine.co.jp/theater/gdcs/#schedule",
  );
  assert.equal(
    isTargetScheduleLocation(scheduleUrl.hostname, scheduleUrl.pathname),
    true,
  );
  assert.equal(
    isTargetScheduleLocation("www.cinemasunshine.co.jp", "/theater/other/"),
    false,
  );
});

test("recognizes background tabs that are safe to close", () => {
  assert.equal(
    detectKnownFailure({
      hostname: "transaction.ticket-cinemasunshine.com",
      hash: "#/error",
    }).code,
    "error",
  );
  assert.equal(
    detectKnownFailure({
      hostname: "transaction.ticket-cinemasunshine.com",
      hash: "#/congestion",
    }).code,
    "congestion",
  );
  assert.equal(
    detectKnownFailure(
      { hostname: "login.member.cinemasunshine.co.jp", hash: "" },
      "お使いのブラウザのcookieが制限されています。",
    ).code,
    "cookie",
  );
  assert.equal(
    detectKnownFailure({
      hostname: "transaction.ticket-cinemasunshine.com",
      hash: "#/purchase/seat",
    }),
    null,
  );
});

test("recognizes the successful seat-selection hash route", () => {
  assert.equal(isSeatRoute("#/purchase/seat"), true);
  assert.equal(isSeatRoute("#/purchase/seat?performanceId=020123"), true);
  assert.equal(isSeatRoute("#/error"), false);
  assert.equal(isSeatRoute("#/congestion"), false);
});

test("only takes over Ctrl-click destinations in the ticket flow", () => {
  const schedule = "https://www.cinemasunshine.co.jp/theater/gdcs/#schedule";
  assert.equal(
    isTicketDestination(
      "https://transaction.ticket-cinemasunshine.com/projects/example",
      schedule,
    ),
    true,
  );
  assert.equal(
    isTicketDestination(
      "https://login.member.cinemasunshine.co.jp/auth?redirect_uri=x",
      schedule,
    ),
    true,
  );
  assert.equal(isTicketDestination("/theater/other/", schedule), false);
});

test("old saved settings enable the new automation defaults", () => {
  assert.deepEqual(normalizedSettings({ count: 3, preference: "center" }), {
    count: 3,
    preference: "center",
    autoSelect: true,
    autoCloseFailures: true,
  });
});

test("balanced mode chooses a centered pair around the 66% row", () => {
  const positions = [0, 20, 40, 60, 80, 100];
  const seats = [
    ...makeRow("A", 0, positions),
    ...makeRow("J", 66, positions),
    ...makeRow("R", 100, positions),
  ];

  const result = findBestSeats(seats, 2, "balanced");
  assert.deepEqual(result.labels, ["J3", "J4"]);
  assert.equal(result.score, 100);
});

test("does not bridge an aisle even when seat numbers are consecutive", () => {
  const seats = makeRow("J", 50, [0, 20, 100, 120]);
  assert.equal(typicalSeatGap(seats), 20);

  const result = findBestSeats(seats, 2, "center");
  assert.notDeepEqual(result.labels, ["J2", "J3"]);
  assert.ok(
    JSON.stringify(result.labels) === JSON.stringify(["J1", "J2"]) ||
      JSON.stringify(result.labels) === JSON.stringify(["J3", "J4"]),
  );
});

test("detects the small aisle spacing used by Theater 12", () => {
  const seats = makeRow("H", 50, [0, 44, 96, 140]);
  assert.equal(typicalSeatGap(seats), 44);

  const result = findBestSeats(seats, 2, "center");
  assert.notDeepEqual(result.labels, ["H2", "H3"]);
});

test("unavailable seats break a continuous block", () => {
  const seats = makeRow("K", 50, [0, 20, 40, 60, 80], { unavailable: [3] });
  const result = findBestSeats(seats, 3, "balanced");
  assert.equal(result, null);
});

test("Grand Class and Premium Class are selectable by default", () => {
  assert.equal(hasExcludedSeatClass(["seat-grand-class"]), false);
  assert.equal(hasExcludedSeatClass(["seat-premium-class"]), false);
  assert.equal(hasExcludedSeatClass(["seat-hc"]), true);
  assert.equal(hasExcludedSeatClass(["seat-comfort"]), true);
});

test("other special seats are excluded by default", () => {
  const seats = makeRow("N", 70, [0, 20, 40, 60, 80], { special: [3] });
  const result = findBestSeats(seats, 1, "center");
  assert.notEqual(result.labels[0], "N3");
});

test("the front 36 percent is excluded for every preference", () => {
  const positions = [0, 20, 40, 60, 80];
  const seats = [
    ...makeRow("A", 0, positions),
    ...makeRow("F", 35, positions),
    ...makeRow("G", 40, positions),
    ...makeRow("N", 84, positions),
    ...makeRow("R", 100, positions),
  ];

  assert.equal(findBestSeats(seats, 1, "front").row, "G");
  assert.equal(findBestSeats(seats, 1, "back").row, "N");
  assert.notEqual(findBestSeats(seats, 1, "balanced").row, "A");
  assert.notEqual(findBestSeats(seats, 1, "center").row, "F");
});

test("default mode prefers a center block over side blocks", () => {
  const seats = [
    ...makeRow("A", 0, [0, 20, 40, 80, 100, 120, 160, 180, 200]),
    ...makeRow("J", 66, [0, 20, 40, 160, 180, 200]),
    ...makeRow("R", 100, [0, 20, 80, 100, 120, 180, 200]),
  ];

  const result = findBestSeats(seats, 2, "balanced");
  assert.ok(
    JSON.stringify(result.labels) === JSON.stringify(["R3", "R4"]) ||
      JSON.stringify(result.labels) === JSON.stringify(["R4", "R5"]),
  );
});

test("a side block uses the seats nearest the room center", () => {
  const positions = [0, 20, 40, 160, 180, 200];
  const seats = [
    ...makeRow("A", 0, positions),
    ...makeRow("J", 66, positions),
    ...makeRow("R", 100, positions),
  ];

  const result = findBestSeats(seats, 2, "balanced");
  assert.ok(
    JSON.stringify(result.labels) === JSON.stringify(["J2", "J3"]) ||
      JSON.stringify(result.labels) === JSON.stringify(["J4", "J5"]),
  );
});

test("selects three consecutive seats for a party of three", () => {
  const positions = [0, 20, 40, 60, 80, 100, 120];
  const seats = [
    ...makeRow("A", 0, positions),
    ...makeRow("J", 66, positions),
    ...makeRow("R", 100, positions),
  ];

  assert.deepEqual(findBestSeats(seats, 3, "balanced").labels, ["J3", "J4", "J5"]);
});

test("rejects an invalid party size", () => {
  assert.throws(() => findBestSeats([], 0), /1 到 6/);
  assert.throws(() => findBestSeats([], 7), /1 到 6/);
});
