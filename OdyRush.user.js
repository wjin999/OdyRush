// ==UserScript==
// @name         OdyRush - Grand Cinema Sunshine
// @namespace    https://github.com/wjin999/OdyRush
// @version      0.5.1
// @description  为 Grand Cinema Sunshine 池袋分析并自动选择最佳连续座位。
// @author       OdyRush
// @match        https://transaction.ticket-cinemasunshine.com/*
// @match        https://login.member.cinemasunshine.co.jp/*
// @match        https://www.cinemasunshine.co.jp/theater/gdcs/*
// @match        https://portal.cinemasunshine.smart-spoke.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_openInTab
// @grant        GM_setValue
// @grant        window.close
// @grant        window.onurlchange
// ==/UserScript==

(function createOdyRush(factory) {
  "use strict";

  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  if (typeof window !== "undefined" && typeof document !== "undefined") {
    api.start();
  }
})(function odyRushFactory() {
  "use strict";

  const VERSION = "0.5.1";
  const TARGET_HOST = "transaction.ticket-cinemasunshine.com";
  const MEMBER_LOGIN_HOST = "login.member.cinemasunshine.co.jp";
  const TARGET_SCHEDULE_HOSTS = new Set([
    "www.cinemasunshine.co.jp",
    "portal.cinemasunshine.smart-spoke.com",
  ]);
  const TARGET_PORTAL_PATH = "/theater/gdcs";
  const TARGET_PERFORMANCE_PREFIX = "020";
  const TARGET_VENUE_PATTERN = /グランドシネマサンシャイン\s*池袋/;
  const PANEL_ID = "odyrush-panel-host";
  const RECOMMENDED_ATTRIBUTE = "data-odyrush-recommended";
  const STORAGE_KEY = "odyrush.settings.v1";
  const TARGET_SESSION_KEY = "odyrush.target.gdcs";
  const TARGET_INTENT_KEY = "odyrush.target-intent.gdcs.v1";
  const TARGET_INTENT_TTL_MILLISECONDS = 6 * 60 * 60 * 1000;
  const MAX_SEATS = 6;
  const AUTO_SUCCESS_KEY = "odyrush.auto-success.v1";
  const AUTO_SUCCESS_TTL_MILLISECONDS = 15 * 60 * 1000;

  const ALWAYS_EXCLUDED_SEAT_CLASSES = [
    "seat-hc",
    "seat-comfort",
    "seat-ottoman",
    "seat-parent-and-child-pair-left",
    "seat-parent-and-child-pair-right",
  ];
  const FRONT_EXCLUSION_RATIO = 0.36;

  const PREFERENCES = {
    balanced: {
      targetRow: 0.66,
      horizontalWeight: 0.62,
      verticalWeight: 0.38,
      centerBlockFirst: true,
    },
    center: {
      targetRow: 0.66,
      horizontalWeight: 0.86,
      verticalWeight: 0.14,
      centerBlockFirst: true,
    },
    back: { targetRow: 0.84, horizontalWeight: 0.45, verticalWeight: 0.55 },
    front: {
      targetRow: FRONT_EXCLUSION_RATIO,
      horizontalWeight: 0.45,
      verticalWeight: 0.55,
    },
  };

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function median(values) {
    if (values.length === 0) {
      return 0;
    }

    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];
  }

  function parseSeatLabel(rawLabel) {
    const normalized = String(rawLabel || "")
      .normalize("NFKC")
      .replace(/\s+/g, "")
      .replace(/[‐‑‒–—―ー−]/g, "-");
    const match = normalized.match(/^([a-z]+)-?0*(\d+)$/i);

    if (!match) {
      return null;
    }

    return {
      row: match[1].toUpperCase(),
      number: Number(match[2]),
      label: `${match[1].toUpperCase()}${Number(match[2])}`,
    };
  }

  function typicalSeatGap(rowSeats) {
    const gaps = [];
    for (let index = 1; index < rowSeats.length; index += 1) {
      const gap = Math.abs(rowSeats[index].x - rowSeats[index - 1].x);
      if (gap > 0) {
        gaps.push(gap);
      }
    }

    if (gaps.length === 0) {
      return 0;
    }

    gaps.sort((left, right) => left - right);
    const normalGapCount = Math.max(1, Math.ceil(gaps.length * 0.6));
    return median(gaps.slice(0, normalGapCount));
  }

  function arePhysicallyContinuous(candidate, normalGap) {
    for (let index = 1; index < candidate.length; index += 1) {
      const previous = candidate[index - 1];
      const current = candidate[index];
      const numberGap = Math.abs(current.number - previous.number);
      const positionGap = Math.abs(current.x - previous.x);

      if (numberGap !== 1) {
        return false;
      }

      if (normalGap > 0 && positionGap > normalGap * 1.15) {
        return false;
      }
    }

    return true;
  }

  function hasExcludedSeatClass(classNames) {
    const classNameSet = new Set(classNames || []);
    return ALWAYS_EXCLUDED_SEAT_CLASSES.some((className) =>
      classNameSet.has(className),
    );
  }

  function splitIntoSeatBlocks(rowSeats, normalGap) {
    const blocks = [];
    let currentBlock = [];

    for (const seat of rowSeats) {
      const previous = currentBlock[currentBlock.length - 1];
      if (
        previous &&
        !arePhysicallyContinuous([previous, seat], normalGap)
      ) {
        blocks.push(currentBlock);
        currentBlock = [];
      }
      currentBlock.push(seat);
    }

    if (currentBlock.length > 0) {
      blocks.push(currentBlock);
    }

    return blocks;
  }

  function findBestSeats(seats, count, preferenceName = "balanced") {
    if (!Number.isInteger(count) || count < 1 || count > MAX_SEATS) {
      throw new Error(`人数必须是 1 到 ${MAX_SEATS} 的整数。`);
    }

    const preference = PREFERENCES[preferenceName] || PREFERENCES.balanced;
    const selectableSeatTypes = seats.filter(
      (seat) =>
        !seat.special &&
        Number.isFinite(seat.x) &&
        Number.isFinite(seat.y) &&
        typeof seat.row === "string" &&
        Number.isFinite(seat.number),
    );

    if (selectableSeatTypes.length === 0) {
      return null;
    }

    const rows = new Map();
    for (const seat of selectableSeatTypes) {
      if (!rows.has(seat.row)) {
        rows.set(seat.row, []);
      }
      rows.get(seat.row).push(seat);
    }

    const rowMetrics = [...rows.entries()]
      .map(([row, rowSeats]) => ({
        row,
        y: rowSeats.reduce((sum, seat) => sum + seat.y, 0) / rowSeats.length,
      }))
      .sort((left, right) => left.y - right.y);
    const minimumY = rowMetrics[0].y;
    const maximumY = rowMetrics[rowMetrics.length - 1].y;
    const rowPosition = new Map(
      rowMetrics.map((metric) => [
        metric.row,
        maximumY === minimumY ? 0.5 : (metric.y - minimumY) / (maximumY - minimumY),
      ]),
    );

    const xValues = selectableSeatTypes.map((seat) => seat.x);
    const minimumX = Math.min(...xValues);
    const maximumX = Math.max(...xValues);
    const roomCenterX = (minimumX + maximumX) / 2;
    const halfRoomWidth = Math.max(1, (maximumX - minimumX) / 2);
    const candidates = [];

    for (const [row, unsortedRowSeats] of rows.entries()) {
      const rowSeats = [...unsortedRowSeats].sort((left, right) => left.x - right.x);
      const normalGap = typicalSeatGap(rowSeats);
      const normalizedRow = rowPosition.get(row);

      if (normalizedRow < FRONT_EXCLUSION_RATIO) {
        continue;
      }

      const seatBlocks = splitIntoSeatBlocks(rowSeats, normalGap);
      for (const seatBlock of seatBlocks) {
        const blockMinimumX = seatBlock[0].x;
        const blockMaximumX = seatBlock[seatBlock.length - 1].x;
        const centerBlockDistance = clamp(
          roomCenterX < blockMinimumX
            ? (blockMinimumX - roomCenterX) / halfRoomWidth
            : roomCenterX > blockMaximumX
              ? (roomCenterX - blockMaximumX) / halfRoomWidth
              : 0,
          0,
          1,
        );

        for (let start = 0; start <= seatBlock.length - count; start += 1) {
          const candidate = seatBlock.slice(start, start + count);
          if (candidate.some((seat) => !seat.available || seat.selected)) {
            continue;
          }
          if (!arePhysicallyContinuous(candidate, normalGap)) {
            continue;
          }

          const candidateCenterX =
            candidate.reduce((sum, seat) => sum + seat.x, 0) / candidate.length;
          const horizontalDistance = clamp(
            Math.abs(candidateCenterX - roomCenterX) / halfRoomWidth,
            0,
            1,
          );
          const maximumVerticalDistance = Math.max(
            preference.targetRow,
            1 - preference.targetRow,
          );
          const verticalDistance = clamp(
            Math.abs(normalizedRow - preference.targetRow) / maximumVerticalDistance,
            0,
            1,
          );
          const score =
            100 -
            100 *
              (horizontalDistance * preference.horizontalWeight +
                verticalDistance * preference.verticalWeight);

          candidates.push({
            seats: candidate,
            labels: candidate.map((seat) => seat.label),
            row,
            rowPosition: normalizedRow,
            centerBlockDistance,
            horizontalDistance,
            verticalDistance,
            score: Math.round(score * 10) / 10,
          });
        }
      }
    }

    candidates.sort(
      (left, right) =>
        (preference.centerBlockFirst
          ? left.centerBlockDistance - right.centerBlockDistance
          : 0) ||
        right.score - left.score ||
        left.centerBlockDistance - right.centerBlockDistance ||
        left.horizontalDistance - right.horizontalDistance ||
        left.verticalDistance - right.verticalDistance ||
        left.row.localeCompare(right.row) ||
        left.seats[0].number - right.seats[0].number,
    );

    return candidates[0] || null;
  }

  function numericStyle(element, property) {
    const inlineValue = Number.parseFloat(element.style[property]);
    if (Number.isFinite(inlineValue)) {
      return inlineValue;
    }

    const computedValue = Number.parseFloat(window.getComputedStyle(element)[property]);
    if (Number.isFinite(computedValue)) {
      return computedValue;
    }

    const rectangle = element.getBoundingClientRect();
    return property === "left" ? rectangle.left : rectangle.top;
  }

  function readSeatMap() {
    const anchors = document.querySelectorAll(
      "app-purchase-seat app-screen .screen-inner .seat > a",
    );
    const seats = [];

    for (const anchor of anchors) {
      const wrapper = anchor.closest(".seat");
      const parsed = parseSeatLabel(anchor.textContent);
      if (!wrapper || !parsed) {
        continue;
      }

      const special = hasExcludedSeatClass(wrapper.classList);
      const selected = anchor.classList.contains("active");
      const disabled =
        anchor.classList.contains("disabled") ||
        wrapper.classList.contains("space") ||
        anchor.getAttribute("aria-disabled") === "true";

      seats.push({
        ...parsed,
        x: numericStyle(wrapper, "left"),
        y: numericStyle(wrapper, "top"),
        available: !special && !selected && !disabled,
        selected,
        special,
        anchor,
        wrapper,
      });
    }

    return seats;
  }

  function clearRecommendation() {
    document
      .querySelectorAll(`[${RECOMMENDED_ATTRIBUTE}]`)
      .forEach((element) => element.removeAttribute(RECOMMENDED_ATTRIBUTE));
  }

  function ensurePageStyles() {
    if (document.getElementById("odyrush-page-styles")) {
      return;
    }

    const style = document.createElement("style");
    style.id = "odyrush-page-styles";
    style.textContent = `
      app-purchase-seat app-screen .seat > a[${RECOMMENDED_ATTRIBUTE}="true"] {
        outline: 4px solid #ffca28 !important;
        outline-offset: 3px !important;
        border-radius: 4px;
        filter: drop-shadow(0 0 5px rgba(255, 202, 40, 0.95));
      }
    `;
    document.head.appendChild(style);
  }

  function highlightRecommendation(recommendation) {
    clearRecommendation();
    for (const seat of recommendation.seats) {
      seat.anchor.setAttribute(RECOMMENDED_ATTRIBUTE, "true");
    }
    recommendation.seats[0]?.wrapper.scrollIntoView({ block: "center", inline: "center" });
  }

  function isVisible(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }
    const style = window.getComputedStyle(element);
    const rectangle = element.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      rectangle.width > 0 &&
      rectangle.height > 0
    );
  }

  function blockingPageIssue() {
    const captcha = document.querySelector(
      'iframe[src*="recaptcha"], iframe[src*="captcha"], .g-recaptcha, [class*="captcha"]',
    );
    if (captcha && isVisible(captcha)) {
      return "页面出现验证码，已停止。";
    }

    const visibleModal = [...document.querySelectorAll("app-modal")].find(isVisible);
    if (visibleModal) {
      const modalText = visibleModal.textContent.replace(/\s+/g, " ").trim();
      return modalText ? `页面出现提示：${modalText}` : "页面出现异常提示，已停止。";
    }

    return null;
  }

  function waitFor(predicate, timeoutMilliseconds, runToken, state) {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();

      function check() {
        if (state && runToken !== state.runToken) {
          reject(new Error("ODYRUSH_STOPPED"));
          return;
        }

        try {
          const result = predicate();
          if (result) {
            resolve(result);
            return;
          }
        } catch (error) {
          reject(error);
          return;
        }

        if (Date.now() - startedAt >= timeoutMilliseconds) {
          reject(new Error("等待页面状态更新超时。"));
          return;
        }

        window.setTimeout(check, 40);
      }

      check();
    });
  }

  function currentPerformanceId() {
    const parameters = new URLSearchParams(window.location.search);
    const queryId = parameters.get("performanceId") || parameters.get("eventId");
    if (queryId) {
      return queryId;
    }

    const pathParts = window.location.pathname.split("/").filter(Boolean);
    const transactionIndex = pathParts.lastIndexOf("transaction");
    return transactionIndex >= 0 ? pathParts[transactionIndex + 1] || "" : "";
  }

  function rememberTargetTheater() {
    const performanceId = currentPerformanceId();
    if (!performanceId) {
      return;
    }

    try {
      if (performanceId.startsWith(TARGET_PERFORMANCE_PREFIX)) {
        window.sessionStorage.setItem(TARGET_SESSION_KEY, "1");
      } else {
        window.sessionStorage.removeItem(TARGET_SESSION_KEY);
      }
    } catch {
      // The visible venue name remains the fallback when storage is unavailable.
    }
  }

  function isSeatRoute(hash) {
    return /^#\/purchase\/seat(?:[/?]|$)/i.test(String(hash || ""));
  }

  function isTicketDestination(rawHref, baseHref) {
    try {
      const url = new URL(rawHref, baseHref);
      return url.hostname === TARGET_HOST || url.hostname === MEMBER_LOGIN_HOST;
    } catch {
      return false;
    }
  }

  function rememberTargetIntent() {
    try {
      if (typeof GM_setValue === "function") {
        GM_setValue(TARGET_INTENT_KEY, Date.now());
      }
    } catch {
      // The performance id and visible venue name remain fallbacks.
    }
  }

  function hasRecentTargetIntent() {
    try {
      if (typeof GM_getValue !== "function") {
        return false;
      }
      const markedAt = Number(GM_getValue(TARGET_INTENT_KEY, 0));
      return Date.now() - markedAt < TARGET_INTENT_TTL_MILLISECONDS;
    } catch {
      return false;
    }
  }

  function isTargetSeatPage() {
    const seatPage = document.querySelector("app-purchase-seat");
    if (!seatPage) {
      return false;
    }

    if (TARGET_VENUE_PATTERN.test(seatPage.textContent)) {
      return true;
    }

    try {
      return window.sessionStorage.getItem(TARGET_SESSION_KEY) === "1";
    } catch {
      return false;
    }
  }

  function isTargetTransaction() {
    if (currentPerformanceId().startsWith(TARGET_PERFORMANCE_PREFIX)) {
      return true;
    }

    if (isSeatRoute(window.location.hash) && hasRecentTargetIntent()) {
      return true;
    }

    try {
      return window.sessionStorage.getItem(TARGET_SESSION_KEY) === "1";
    } catch {
      return false;
    }
  }

  function isTargetScheduleLocation(hostname, pathname) {
    return (
      TARGET_SCHEDULE_HOSTS.has(hostname) &&
      pathname.toLowerCase().includes(TARGET_PORTAL_PATH)
    );
  }

  function isTargetSchedulePage() {
    return isTargetScheduleLocation(
      window.location.hostname,
      window.location.pathname,
    );
  }

  function normalizedSettings(saved) {
    const defaults = {
      count: 2,
      preference: "balanced",
      autoSelect: true,
      autoCloseFailures: true,
    };
    const count = Number(saved?.count);
    const preference = PREFERENCES[saved?.preference]
      ? saved.preference
      : defaults.preference;
    return {
      count: Number.isInteger(count) && count >= 1 && count <= MAX_SEATS ? count : 2,
      preference,
      autoSelect: saved?.autoSelect !== false,
      autoCloseFailures: saved?.autoCloseFailures !== false,
    };
  }

  function loadSettings() {
    try {
      if (typeof GM_getValue === "function") {
        const sharedSettings = GM_getValue(STORAGE_KEY, null);
        if (sharedSettings) {
          return normalizedSettings(sharedSettings);
        }
      }
    } catch {
      // Fall back to the current site's local storage.
    }

    try {
      const localSettings = JSON.parse(
        window.localStorage.getItem(STORAGE_KEY) || "null",
      );
      return normalizedSettings(localSettings);
    } catch {
      return normalizedSettings(null);
    }
  }

  function saveSettings(settings) {
    try {
      if (typeof GM_setValue === "function") {
        GM_setValue(STORAGE_KEY, settings);
      }
    } catch {
      // The local copy below still preserves settings for the current site.
    }

    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Settings persistence is optional.
    }
  }

  function mountPanel(mode = "seat") {
    const existingPanel = document.getElementById(PANEL_ID);
    if (existingPanel?.dataset.mode === mode) {
      return;
    }
    if (existingPanel) {
      existingPanel.remove();
    }

    ensurePageStyles();

    const host = document.createElement("div");
    host.id = PANEL_ID;
    host.dataset.mode = mode;
    const shadow = host.attachShadow({ mode: "open" });
    const settings = loadSettings();
    const seatMode = mode === "seat";
    const state = { running: false, canStop: false, runToken: 0 };

    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .panel {
          position: fixed;
          z-index: 2147483647;
          top: 18px;
          right: 18px;
          width: 300px;
          box-sizing: border-box;
          padding: 16px;
          border: 1px solid rgba(255, 255, 255, 0.18);
          border-radius: 14px;
          color: #f7f7f8;
          background: rgba(27, 29, 33, 0.96);
          box-shadow: 0 14px 40px rgba(0, 0, 0, 0.35);
          font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        .title { margin: 0 0 12px; font-size: 19px; font-weight: 750; }
        .target { margin: -8px 0 14px; color: #aeb5c0; font-size: 12px; }
        .field { display: grid; grid-template-columns: 64px 1fr; align-items: center; gap: 10px; margin: 10px 0; }
        label { color: #d9dce1; }
        input, select, button { box-sizing: border-box; font: inherit; }
        input, select {
          width: 100%;
          min-height: 36px;
          padding: 6px 9px;
          border: 1px solid #555d69;
          border-radius: 8px;
          color: #fff;
          background: #343840;
        }
        .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 14px; }
        button {
          min-height: 38px;
          border: 0;
          border-radius: 8px;
          color: #fff;
          background: #087fca;
          cursor: pointer;
          font-weight: 700;
        }
        button.secondary { background: #4b525d; }
        button.stop { grid-column: 1 / -1; color: #ffd8dc; background: #71343b; }
        button:disabled, input:disabled, select:disabled { cursor: not-allowed; opacity: 0.48; }
        .status {
          min-height: 40px;
          margin-top: 12px;
          padding: 10px;
          border-radius: 8px;
          color: #d9dce1;
          background: #24272c;
          overflow-wrap: anywhere;
        }
        .status[data-tone="success"] { color: #baf4ce; background: #183a28; }
        .status[data-tone="error"] { color: #ffd1d6; background: #4a2328; }
        .note { margin-top: 9px; color: #999fa9; font-size: 11px; }
        @media (max-width: 767px) {
          .panel { top: 8px; right: 8px; width: min(300px, calc(100vw - 16px)); }
        }
      </style>
      <section class="panel" aria-label="OdyRush 控制面板">
        <h2 class="title">OdyRush <small>v${VERSION}</small></h2>
        <p class="target">Grand Cinema Sunshine 池袋</p>
        <div class="field">
          <label for="count">人数</label>
          <input id="count" type="number" min="1" max="${MAX_SEATS}" step="1" value="${settings.count}">
        </div>
        <div class="field">
          <label for="preference">偏好</label>
          <select id="preference">
            <option value="balanced">默认（中央区域优先）</option>
            <option value="center">严格居中</option>
            <option value="back">靠后</option>
            <option value="front">相对靠前（仍避开前区）</option>
          </select>
        </div>
        <div class="field">
          <label for="auto-select">自动选座</label>
          <select id="auto-select">
            <option value="true">进入后自动执行</option>
            <option value="false">仅手动执行</option>
          </select>
        </div>
        <div class="field">
          <label for="auto-close">失败标签</label>
          <select id="auto-close">
            <option value="true">后台自动关闭</option>
            <option value="false">保留标签</option>
          </select>
        </div>
        ${
          seatMode
            ? `<div class="actions">
                <button id="analyze" class="secondary" type="button">分析座位</button>
                <button id="auto" type="button">自动选座并进入下一步</button>
                <button id="stop" class="stop" type="button" disabled>停止</button>
              </div>`
            : ""
        }
        <div id="status" class="status" role="status" aria-live="polite">${
          seatMode
            ? "已识别座位页，可以开始分析。"
            : "预设面板已启动；人数和偏好会自动保存。"
        }</div>
        <div class="note">${
          seatMode
            ? "前区不选；Grand/Premium Class 可选。自动模式会勾选利用规约。"
            : "Ctrl+点击购票链接会由脚本托管；只自动关闭明确的失败页。"
        }</div>
      </section>
    `;

    document.body.appendChild(host);

    const countInput = shadow.getElementById("count");
    const preferenceSelect = shadow.getElementById("preference");
    const autoSelectInput = shadow.getElementById("auto-select");
    const autoCloseInput = shadow.getElementById("auto-close");
    const analyzeButton = shadow.getElementById("analyze");
    const autoButton = shadow.getElementById("auto");
    const stopButton = shadow.getElementById("stop");
    const statusBox = shadow.getElementById("status");
    preferenceSelect.value = settings.preference;
    autoSelectInput.value = String(settings.autoSelect);
    autoCloseInput.value = String(settings.autoCloseFailures);

    function readOptions() {
      const count = Number(countInput.value);
      if (!Number.isInteger(count) || count < 1 || count > MAX_SEATS) {
        throw new Error(`人数必须是 1 到 ${MAX_SEATS} 的整数。`);
      }
      const preference = PREFERENCES[preferenceSelect.value]
        ? preferenceSelect.value
        : "balanced";
      const options = {
        count,
        preference,
        autoSelect: autoSelectInput.value === "true",
        autoCloseFailures: autoCloseInput.value === "true",
      };
      saveSettings(options);
      return options;
    }

    function setStatus(message, tone = "info") {
      statusBox.textContent = message;
      statusBox.dataset.tone = tone;
    }

    function renderBusyState() {
      countInput.disabled = state.running;
      preferenceSelect.disabled = state.running;
      autoSelectInput.disabled = state.running;
      autoCloseInput.disabled = state.running;
      if (analyzeButton) {
        analyzeButton.disabled = state.running;
      }
      if (autoButton) {
        autoButton.disabled = state.running;
      }
      if (stopButton) {
        stopButton.disabled = !state.running || !state.canStop;
      }
    }

    function recommendationFor(options) {
      const seats = readSeatMap();
      if (seats.length === 0) {
        throw new Error("尚未识别到座位表，请等页面加载完成后重试。若一直如此，请提供页面 HTML。");
      }

      const recommendation = findBestSeats(seats, options.count, options.preference);
      if (!recommendation) {
        const availableCount = seats.filter((seat) => seat.available).length;
        throw new Error(
          `识别到 ${availableCount} 个可点击空座，但在允许区域内没有 ${options.count} 个同排、连续且不过道的座位。`,
        );
      }

      return { seats, recommendation };
    }

    function analyze() {
      try {
        const options = readOptions();
        const { recommendation } = recommendationFor(options);
        highlightRecommendation(recommendation);
        setStatus(
          `推荐 ${recommendation.labels.join("、")}，综合评分 ${recommendation.score}。`,
          "success",
        );
      } catch (error) {
        clearRecommendation();
        setStatus(error.message, "error");
      }
    }

    async function autoSelectAndContinue() {
      if (state.running) {
        return false;
      }

      let succeeded = false;
      state.running = true;
      state.canStop = true;
      state.runToken += 1;
      const runToken = state.runToken;
      renderBusyState();

      try {
        const options = readOptions();
        const initialSeats = readSeatMap();
        const initiallySelected = initialSeats.filter((seat) => seat.selected);
        if (initiallySelected.length > 0) {
          throw new Error(
            `页面已有选中座位（${initiallySelected.map((seat) => seat.label).join("、")}），请先手动取消，避免误选。`,
          );
        }

        const { recommendation } = recommendationFor(options);
        highlightRecommendation(recommendation);
        setStatus(`正在选择 ${recommendation.labels.join("、")}…`);

        for (const targetSeat of recommendation.seats) {
          if (runToken !== state.runToken) {
            throw new Error("ODYRUSH_STOPPED");
          }

          const issue = blockingPageIssue();
          if (issue) {
            throw new Error(issue);
          }

          const currentSeat = readSeatMap().find((seat) => seat.label === targetSeat.label);
          if (!currentSeat || !currentSeat.available) {
            throw new Error(`${targetSeat.label} 已不可选，操作已停止。`);
          }

          currentSeat.anchor.click();
          await waitFor(
            () => readSeatMap().find((seat) => seat.label === targetSeat.label)?.selected,
            1800,
            runToken,
            state,
          );
        }

        const selectedSeats = readSeatMap().filter((seat) => seat.selected);
        const selectedLabels = new Set(selectedSeats.map((seat) => seat.label));
        if (
          selectedSeats.length !== options.count ||
          recommendation.labels.some((label) => !selectedLabels.has(label))
        ) {
          throw new Error("页面显示的选中座位与推荐结果不一致，已停止。");
        }

        const issue = blockingPageIssue();
        if (issue) {
          throw new Error(issue);
        }

        setStatus(`已选中 ${recommendation.labels.join("、")}，正在勾选利用规约…`);
        const termsCheckbox = document.querySelector(
          'app-purchase-seat form input#terms[type="checkbox"]',
        );
        if (!termsCheckbox) {
          throw new Error("无法识别“利用规约に同意する”复选框，已停止。");
        }
        if (!termsCheckbox.checked) {
          termsCheckbox.click();
        }
        await waitFor(() => termsCheckbox.checked, 1000, runToken, state);

        const nextButton = document.querySelector(
          'app-purchase-seat form button[type="submit"]',
        );
        if (
          !nextButton ||
          nextButton.disabled ||
          !/次へ/.test(nextButton.textContent || "")
        ) {
          throw new Error("无法识别可用的“次へ”按钮，已停止。");
        }

        if (runToken !== state.runToken) {
          throw new Error("ODYRUSH_STOPPED");
        }

        state.canStop = false;
        renderBusyState();
        setStatus("座位与利用规约已确认，正在进入下一步…");
        nextButton.click();

        await waitFor(
          () =>
            window.location.pathname.includes("/purchase/ticket") ||
            [...document.querySelectorAll("h1")].some((heading) =>
              /券種選択/.test(heading.textContent || ""),
            ) ||
            blockingPageIssue(),
          10000,
          runToken,
          null,
        );

        const finalIssue = blockingPageIssue();
        if (finalIssue) {
          throw new Error(finalIssue);
        }

        setStatus(
          `已锁定并进入下一步：${recommendation.labels.join("、")}。请人工选择票种并完成后续流程。`,
          "success",
        );
        succeeded = true;
      } catch (error) {
        if (error.message === "ODYRUSH_STOPPED") {
          setStatus("已停止；已选座位保持原状，请人工检查或取消。", "error");
        } else {
          setStatus(error.message || "发生未知错误，已停止。", "error");
        }
      } finally {
        state.running = false;
        state.canStop = false;
        renderBusyState();
      }

      return succeeded;
    }

    function recentlyCompletedThisPerformance(performanceId) {
      try {
        const record = JSON.parse(
          window.localStorage.getItem(AUTO_SUCCESS_KEY) || "null",
        );
        return (
          record?.performanceId === performanceId &&
          Date.now() - Number(record.completedAt) < AUTO_SUCCESS_TTL_MILLISECONDS
        );
      } catch {
        return false;
      }
    }

    function rememberAutomaticSuccess(performanceId) {
      try {
        window.localStorage.setItem(
          AUTO_SUCCESS_KEY,
          JSON.stringify({ performanceId, completedAt: Date.now() }),
        );
      } catch {
        // The cross-tab lock still prevents simultaneous selection.
      }
    }

    async function automaticallySelectOnce() {
      const performanceId = currentPerformanceId() || "grand-cinema-sunshine";
      if (recentlyCompletedThisPerformance(performanceId)) {
        setStatus("已有标签页完成过本场次自动选座，本页保留且不会重复执行。", "success");
        return;
      }

      if (!window.navigator.locks?.request) {
        setStatus("浏览器不支持多标签执行锁，请手动点击自动选座按钮。", "error");
        return;
      }

      await window.navigator.locks.request(
        "odyrush-seat-selection",
        { ifAvailable: true },
        async (lock) => {
          if (!lock) {
            setStatus("另一个标签页正在自动选座，本页保持不操作。", "success");
            return;
          }
          if (recentlyCompletedThisPerformance(performanceId)) {
            setStatus("另一个标签页已经完成本场次选座，本页不会重复执行。", "success");
            return;
          }

          document.title = `🎟️ 自动选座中 | ${document.title}`;
          const completed = await autoSelectAndContinue();
          if (completed) {
            rememberAutomaticSuccess(performanceId);
            document.title = `✅ 已进入下一步 | ${document.title}`;
          }
        },
      );
    }

    function saveChangedOptions() {
      try {
        const options = readOptions();
        if (!seatMode) {
          setStatus(`已预设 ${options.count} 人；进入座位页后会自动读取。`, "success");
        }
      } catch (error) {
        setStatus(error.message, "error");
      }
    }

    countInput.addEventListener("change", saveChangedOptions);
    preferenceSelect.addEventListener("change", saveChangedOptions);
    autoSelectInput.addEventListener("change", saveChangedOptions);
    autoCloseInput.addEventListener("change", saveChangedOptions);
    analyzeButton?.addEventListener("click", analyze);
    autoButton?.addEventListener("click", autoSelectAndContinue);
    stopButton?.addEventListener("click", () => {
      if (!state.running || !state.canStop) {
        return;
      }
      state.runToken += 1;
      state.canStop = false;
      renderBusyState();
      setStatus("正在停止…");
    });

    renderBusyState();
    if (seatMode && settings.autoSelect) {
      setStatus("已识别座位页，正在启动后台自动选座…");
      window.queueMicrotask(automaticallySelectOnce);
    }
  }

  let controlledOpenerInstalled = false;
  function installControlledBackgroundOpener() {
    if (controlledOpenerInstalled || typeof GM_openInTab !== "function") {
      return;
    }
    controlledOpenerInstalled = true;

    document.addEventListener(
      "click",
      (event) => {
        if (!event.ctrlKey || event.button !== 0) {
          return;
        }
        if (!(event.target instanceof Element)) {
          return;
        }

        const anchor = event.target.closest("a[href]");
        if (!anchor || !isTicketDestination(anchor.href, window.location.href)) {
          return;
        }

        event.preventDefault();
        event.stopImmediatePropagation();
        rememberTargetIntent();
        GM_openInTab(anchor.href, { active: false, setParent: true });
      },
      true,
    );
  }

  function detectKnownFailure(locationLike, pageText = "") {
    if (locationLike.hostname === TARGET_HOST) {
      const hash = String(locationLike.hash || "").toLowerCase();
      if (hash.startsWith("#/error")) {
        return { code: "error", label: "购票错误" };
      }
      if (hash.startsWith("#/congestion")) {
        return { code: "congestion", label: "访问拥堵" };
      }
    }

    if (
      locationLike.hostname === MEMBER_LOGIN_HOST &&
      /cookie.{0,12}(?:制限|限制)/i.test(pageText)
    ) {
      return { code: "cookie", label: "Cookie 受限" };
    }

    return null;
  }

  let tabCloseScheduled = false;
  function requestCurrentTabClose() {
    if (tabCloseScheduled) {
      return;
    }
    tabCloseScheduled = true;
    window.close();
    window.setTimeout(() => window.close(), 1000);
  }

  function handleKnownFailurePage() {
    const failure = detectKnownFailure(
      window.location,
      document.body?.innerText || "",
    );
    if (!failure) {
      return false;
    }

    document.title = `❌ ${failure.label}`;
    if (loadSettings().autoCloseFailures) {
      requestCurrentTabClose();
    }
    return true;
  }

  function start() {
    if (
      window.location.hostname !== TARGET_HOST &&
      window.location.hostname !== MEMBER_LOGIN_HOST &&
      !TARGET_SCHEDULE_HOSTS.has(window.location.hostname)
    ) {
      return;
    }

    window.addEventListener("hashchange", handleKnownFailurePage);
    if (window.onurlchange === null) {
      window.addEventListener("urlchange", handleKnownFailurePage);
    }
    if (handleKnownFailurePage()) {
      return;
    }

    if (isTargetSchedulePage()) {
      installControlledBackgroundOpener();
    }

    if (window.location.hostname === MEMBER_LOGIN_HOST) {
      const loginObserver = new MutationObserver(() => {
        if (handleKnownFailurePage()) {
          loginObserver.disconnect();
        }
      });
      loginObserver.observe(document.documentElement, { childList: true, subtree: true });
      return;
    }

    if (window.location.hostname === TARGET_HOST) {
      rememberTargetTheater();
    }

    let mountScheduled = false;
    let observer;
    const tryMount = () => {
      if (mountScheduled) {
        return;
      }
      mountScheduled = true;
      window.queueMicrotask(() => {
        mountScheduled = false;
        if (TARGET_SCHEDULE_HOSTS.has(window.location.hostname)) {
          if (isTargetSchedulePage()) {
            rememberTargetIntent();
            mountPanel("settings");
            observer?.disconnect();
          }
          return;
        }

        rememberTargetTheater();
        if (isTargetSeatPage()) {
          mountPanel("seat");
          observer?.disconnect();
        } else if (isTargetTransaction()) {
          mountPanel("settings");
        }
      });
    };

    tryMount();
    observer = new MutationObserver(tryMount);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  return {
    MAX_SEATS,
    PREFERENCES,
    arePhysicallyContinuous,
    findBestSeats,
    hasExcludedSeatClass,
    detectKnownFailure,
    isTargetScheduleLocation,
    isSeatRoute,
    isTicketDestination,
    normalizedSettings,
    parseSeatLabel,
    splitIntoSeatBlocks,
    typicalSeatGap,
    start,
  };
});
