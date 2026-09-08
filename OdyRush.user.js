// ==UserScript==
// @name         OdyRush - Grand Cinema Sunshine
// @namespace    https://github.com/wjin999/OdyRush
// @version      0.6.0
// @description  按池袋 IMAX 12 号厅布局自动分析并选择连座，支持中央区域/全场和高级座位开关。
// @author       OdyRush
// @match        https://transaction.ticket-cinemasunshine.com/*
// @match        https://login.member.cinemasunshine.co.jp/*
// @match        https://www.cinemasunshine.co.jp/theater/gdcs/*
// @match        https://portal.cinemasunshine.smart-spoke.com/*
// @run-at       document-start
// @noframes
// @grant        GM_getValue
// @grant        GM_openInTab
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_getTab
// @grant        GM_saveTab
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
    api.start().catch((error) => console.error("OdyRush:", error));
  }
})(function odyRushFactory() {
  "use strict";

  const VERSION = "0.6.0";
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
  const MAX_SEATS = 6;
  const AUTO_SUCCESS_KEY = "odyrush.auto-success.v2";
  const AUTO_SUCCESS_TTL_MILLISECONDS = 15 * 60 * 1000;
  const MANAGED_TAB_TTL = 6 * 60 * 60 * 1000;
  const LAUNCH_KEY = "odyrush.launch.";
  const IMAX_ROWS = "A B C D E F G H J K M N O P Q R".split(" ");
  // A viewing preference, not measured viewing angles. Source and rationale: README.
  const ROW_PENALTIES = {
    A: 60, B: 54, C: 48, D: 42, E: 36, F: 30, G: 16, H: 10,
    J: 5, K: 2, M: 0, N: 4, O: 8, P: 13, Q: 18, R: 24,
  };
  const ALWAYS_EXCLUDED_SEAT_CLASSES = [
    "seat-hc", "seat-comfort", "seat-ottoman",
    "seat-parent-and-child-pair-left", "seat-parent-and-child-pair-right",
  ];
  let managedTab = null;
  let activePanel = null;

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

  function seatClass(seat) {
    if (seat.seatClass) return seat.seatClass;
    if (["G", "N"].includes(seat.row) && seat.number >= 11 && seat.number <= 22) return "premium";
    if (seat.row === "R" && seat.number >= 11 && seat.number <= 20) return "grand";
    return "standard";
  }

  function isCentralSeat(seat) {
    if (!IMAX_ROWS.slice(6).includes(seat.row)) return false;
    const last = ["G", "N"].includes(seat.row) ? 22 : seat.row === "R" ? 20 : 30;
    return seat.number >= 11 && seat.number <= last;
  }

  function isTheater12Map(seats) {
    const labels = new Set(seats.map((seat) => seat.label));
    const rows = new Set(seats.map((seat) => seat.row));
    return IMAX_ROWS.every((row) => rows.has(row)) && rows.size === IMAX_ROWS.length &&
      ["G11", "G22", "H1", "H11", "H30", "H40", "J11", "J30", "N11", "N22", "R11", "R20"]
        .every((label) => labels.has(label)) &&
      seats.every((seat) => Number.isFinite(seat.x) && Number.isFinite(seat.y)) &&
      new Set(seats.map((seat) => seat.x)).size > 10 &&
      new Set(seats.map((seat) => seat.y)).size >= IMAX_ROWS.length;
  }

  function findBestSeats(seats, count, options = {}) {
    if (!Number.isInteger(count) || count < 1 || count > MAX_SEATS) {
      throw new Error(`人数必须是 1 到 ${MAX_SEATS} 的整数。`);
    }
    const area = options.area === "all" ? "all" : "central";
    const allowPremium = options.allowPremium === true;
    const geometry = seats.filter((seat) => Number.isFinite(seat.x) && Number.isFinite(seat.y) &&
      IMAX_ROWS.includes(seat.row) && Number.isInteger(seat.number));
    if (!geometry.length) return null;
    // H is a full standard row in this fixed layout. Premium rows have different numbering.
    const reference = geometry.filter((seat) => seat.row === "H");
    const centerLeft = reference.find((seat) => seat.number === 11);
    const centerRight = reference.find((seat) => seat.number === 30);
    const minX = Math.min(...geometry.map((seat) => seat.x));
    const maxX = Math.max(...geometry.map((seat) => seat.x));
    const centerX = centerLeft && centerRight ? (centerLeft.x + centerRight.x) / 2 : (minX + maxX) / 2;
    const halfWidth = Math.max(1, centerX - minX, maxX - centerX);
    const rows = new Map();
    for (const seat of geometry) {
      if (!rows.has(seat.row)) rows.set(seat.row, []);
      rows.get(seat.row).push(seat);
    }
    const candidates = [];
    for (const [row, rowSeats] of rows) {
      rowSeats.sort((a, b) => a.x - b.x);
      // Premium seats are wider than the standard side blocks in the SAME row.
      const gapFor = new Map();
      for (const seat of rowSeats) {
        const key = `${seatClass(seat)}:${isCentralSeat(seat)}`;
        if (!gapFor.has(key)) gapFor.set(key, typicalSeatGap(rowSeats.filter((other) =>
          seatClass(other) === seatClass(seat) && isCentralSeat(other) === isCentralSeat(seat))));
      }
      for (let start = 0; start <= rowSeats.length - count; start += 1) {
        const group = rowSeats.slice(start, start + count);
        if (group.some((seat) => !seat.available || seat.selected || seat.special ||
          (!allowPremium && seatClass(seat) !== "standard") ||
          (area === "central" && !isCentralSeat(seat)))) continue;
        // Do not combine different ticket classes or bridge either main aisle.
        if (group.some((seat) => seatClass(seat) !== seatClass(group[0]) ||
          isCentralSeat(seat) !== isCentralSeat(group[0]))) continue;
        const normalGap = gapFor.get(`${seatClass(group[0])}:${isCentralSeat(group[0])}`);
        if (!arePhysicallyContinuous(group, normalGap)) continue;
        const offsets = group.map((seat) => Math.abs(seat.x - centerX) / halfWidth);
        const averageOffset = offsets.reduce((sum, value) => sum + value, 0) / count;
        const worstOffset = Math.max(...offsets);
        const penalty = ROW_PENALTIES[row] + 68 * averageOffset + 12 * worstOffset;
        candidates.push({seats: group, labels: group.map((seat) => seat.label), row,
          score: Math.round(clamp(100 - penalty, 0, 100) * 10) / 10,
          penalty, seatClass: seatClass(group[0])});
      }
    }
    candidates.sort((a, b) => a.penalty - b.penalty ||
      IMAX_ROWS.indexOf(a.row) - IMAX_ROWS.indexOf(b.row) || a.seats[0].number - b.seats[0].number);
    return candidates[0] || null;
  }

  function numericStyle(element, property) {
    // One coordinate system, including CSS transforms and different seat widths.
    const rectangle = element.getBoundingClientRect();
    return property === "left" ? rectangle.left + rectangle.width / 2 : rectangle.top + rectangle.height / 2;
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
        seatClass: wrapper.classList.contains("seat-grand-class") ? "grand" :
          wrapper.classList.contains("seat-premium-class") ? "premium" :
          seatClass(parsed),
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

  function performanceIdFromLocation(locationLike) {
    const hash = String(locationLike.hash || "");
    const queries = [hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "", locationLike.search || ""];
    for (const query of queries) {
      const params = new URLSearchParams(query);
      const id = params.get("performanceId") || params.get("eventId");
      if (id) return id.trim();
    }
    // The site's older entry links use /transaction/<numeric performance id>.
    // Ignore opaque transaction UUIDs; they differ across tabs for the same performance.
    const entry = String(locationLike.pathname || "").match(/\/transaction\/(\d{6,})(?:\/|$)/);
    if (entry) return entry[1];
    return "";
  }

  function currentPerformanceId() {
    const fromUrl = performanceIdFromLocation(window.location);
    if (fromUrl) {
      try { window.sessionStorage.setItem("odyrush.performance.v2", JSON.stringify({id: fromUrl, path: window.location.pathname})); } catch { /* optional */ }
      return fromUrl;
    }
    if (isSeatRoute(window.location.hash) || isTicketRoute(window.location)) {
      try {
        const stored = JSON.parse(window.sessionStorage.getItem("odyrush.performance.v2") || "null");
        if (stored?.path === window.location.pathname) return stored.id || "";
      } catch { /* optional */ }
    }
    return "";
  }

  function isSeatRoute(hash) {
    return /^#\/purchase\/seat(?:[/?]|$)/i.test(String(hash || ""));
  }

  function isTicketRoute(locationLike) {
    return /^#\/purchase\/ticket(?:[/?]|$)/i.test(String(locationLike.hash || "")) ||
      /\/purchase\/ticket(?:\/|$)/i.test(String(locationLike.pathname || ""));
  }

  function isTicketDestination(rawHref, baseHref) {
    try {
      const url = new URL(rawHref, baseHref);
      return url.protocol === "https:" && (url.hostname === TARGET_HOST || url.hostname === MEMBER_LOGIN_HOST);
    } catch { return false; }
  }

  function isTargetSeatPage() {
    const page = document.querySelector("app-purchase-seat");
    if (!page || !isSeatRoute(window.location.hash)) return false;
    const id = currentPerformanceId();
    if (id && !id.startsWith(TARGET_PERFORMANCE_PREFIX)) return false;
    if (TARGET_VENUE_PATTERN.test(page.textContent)) return true;
    return isTargetTransaction();
  }

  function isTargetTransaction() {
    const id = currentPerformanceId();
    if (id) return id.startsWith(TARGET_PERFORMANCE_PREFIX);
    return managedTab !== null && isRecent(managedTab.createdAt, MANAGED_TAB_TTL);
  }

  function isRecent(timestamp, ttl) {
    const age = Date.now() - Number(timestamp);
    return Number.isFinite(age) && age >= 0 && age < ttl;
  }

  function completionKey(performanceId) {
    return `${AUTO_SUCCESS_KEY}.${encodeURIComponent(performanceId)}`;
  }

  function recentlyCompletedThisPerformance(performanceId) {
    if (!performanceId) return false;
    try {
      return isRecent(window.localStorage.getItem(completionKey(performanceId)), AUTO_SUCCESS_TTL_MILLISECONDS);
    } catch { return false; }
  }

  function rememberAutomaticSuccess(performanceId) {
    if (!performanceId) return;
    try { window.localStorage.setItem(completionKey(performanceId), String(Date.now())); } catch { /* optional */ }
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
    const count = Number(saved?.count);
    return {
      count: Number.isInteger(count) && count >= 1 && count <= MAX_SEATS ? count : 2,
      area: saved?.area === "all" ? "all" : "central",
      allowPremium: saved?.allowPremium === true,
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
    activePanel?.dispose();
    existingPanel?.remove();

    ensurePageStyles();

    const host = document.createElement("div");
    host.id = PANEL_ID;
    host.dataset.mode = mode;
    const shadow = host.attachShadow({ mode: "open" });
    const settings = loadSettings();
    const seatMode = mode === "seat";
    const state = { running: false, canStop: false, runToken: 0, disposed: false, controller: null };

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
        .actions { display: grid; grid-template-columns: 1fr; gap: 8px; margin-top: 14px; }
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
          <label for="area">选座区域</label>
          <select id="area">
            <option value="central">中央区域（蓝框 G–R 排）</option>
            <option value="all">全场（包含前排和两侧）</option>
          </select>
        </div>
        <div class="field">
          <label for="premium">高级座位</label>
          <select id="premium">
            <option value="false">关闭：仅普通座位</option>
            <option value="true">允许 Premium / Grand（需加价）</option>
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
                <button id="auto" type="button">自动分析并选座</button>
                <button id="stop" class="stop" type="button" disabled>停止</button>
              </div>`
            : ""
        }
        <div id="status" class="status" role="status" aria-live="polite">${
          seatMode
            ? "正在等待 IMAX 12 号厅座位表加载。"
            : "预设面板已启动；人数和偏好会自动保存。"
        }</div>
        <div class="note">${
          seatMode
            ? "优先 M 排附近中轴座位；选座后自动勾选利用规约并进入票种页。"
            : "Ctrl+点击购票链接会由脚本托管；仅自动关闭托管的后台失败页。"
        }</div>
      </section>
    `;

    document.body.appendChild(host);

    const countInput = shadow.getElementById("count");
    const areaSelect = shadow.getElementById("area");
    const premiumSelect = shadow.getElementById("premium");
    const autoSelectInput = shadow.getElementById("auto-select");
    const autoCloseInput = shadow.getElementById("auto-close");
    const autoButton = shadow.getElementById("auto");
    const stopButton = shadow.getElementById("stop");
    const statusBox = shadow.getElementById("status");
    areaSelect.value = settings.area;
    premiumSelect.value = String(settings.allowPremium);
    autoSelectInput.value = String(settings.autoSelect);
    autoCloseInput.value = String(settings.autoCloseFailures);

    function readOptions() {
      const count = Number(countInput.value);
      if (!Number.isInteger(count) || count < 1 || count > MAX_SEATS) {
        throw new Error(`人数必须是 1 到 ${MAX_SEATS} 的整数。`);
      }
      const options = {
        count,
        area: areaSelect.value,
        allowPremium: premiumSelect.value === "true",
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
      areaSelect.disabled = state.running;
      premiumSelect.disabled = state.running;
      autoSelectInput.disabled = state.running;
      autoCloseInput.disabled = state.running;
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

      const recommendation = findBestSeats(seats, options.count, options);
      if (!recommendation) {
        const availableCount = seats.filter((seat) => seat.available).length;
        throw new Error(
          `识别到 ${availableCount} 个可点击空座，但在允许区域内没有 ${options.count} 个同排、连续且不过道的座位。`,
        );
      }

      return { seats, recommendation };
    }

    function dispose() {
      state.disposed = true;
      state.runToken += 1;
      state.controller?.abort();
      clearRecommendation();
    }
    activePanel = { host, dispose };

    async function waitForSeatMap(runToken) {
      let previous = "";
      let stableSince = Date.now();
      setStatus("等待 IMAX 12 号厅座位表加载完成…");
      await waitFor(() => {
        if (!isTargetSeatPage()) throw new Error("座位页已变化，已停止。");
        const issue = blockingPageIssue();
        if (issue) throw new Error(issue);
        const seats = readSeatMap();
        const signature = JSON.stringify(seats.map(({label, x, y, available, selected, seatClass}) =>
          [label, x, y, available, selected, seatClass]));
        if (signature !== previous) { previous = signature; stableSince = Date.now(); }
        return isTheater12Map(seats) && Date.now() - stableSince >= 500;
      }, 30000, runToken, state).catch((error) => {
        if (error.message === "等待页面状态更新超时。") {
          throw new Error("座位表未加载完成或不符合池袋 IMAX 12 号厅布局，请检查页面后重试。");
        }
        throw error;
      });
    }

    async function autoSelectAndContinue(runToken) {
      let succeeded = false;

      try {
        await waitForSeatMap(runToken);
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

        const nextButton = await waitFor(() => {
          const button = document.querySelector(
          'app-purchase-seat form button[type="submit"]',
          );
          return button && !button.disabled ? button : null;
        }, 3000, runToken, state);
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
            isTicketRoute(window.location) ||
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
      }

      return succeeded;
    }

    async function runSelection(automatic = false) {
      if (state.running || state.disposed) return;
      const performanceId = currentPerformanceId();
      if (automatic && !performanceId) {
        setStatus("无法确认场次编号，未自动执行；确认场次后可点击按钮选座。", "error");
        return;
      }
      if (!window.navigator.locks?.request) {
        setStatus("浏览器不支持多标签执行锁，请使用支持 Web Locks 的 Chrome。", "error");
        return;
      }
      state.running = true;
      state.canStop = true;
      state.runToken += 1;
      const runToken = state.runToken;
      state.controller = new AbortController();
      renderBusyState();
      setStatus("等待同场次标签完成；若对方失败，本页将接替选座…");
      try {
        // Queue instead of ifAvailable: a failed tab releases the lock to the next waiter.
        // Unknown identities require an explicit click and never write a shared completion record.
        await window.navigator.locks.request(
          `odyrush-seat-selection:${performanceId || "manual-unknown"}`,
          { signal: state.controller.signal },
          async () => {
            if (state.disposed || runToken !== state.runToken) return;
            if (currentPerformanceId() !== performanceId || !isTargetSeatPage()) {
              throw new Error("场次或页面已变化，请重新执行。");
            }
            if (performanceId && recentlyCompletedThisPerformance(performanceId)) {
              setStatus("已有标签完成本场次选座，15 分钟内不重复执行。请前往该标签继续购票。", "success");
              return;
            }
            const completed = await autoSelectAndContinue(runToken);
            if (completed) {
              rememberAutomaticSuccess(performanceId);
              document.title = `✅ 已进入下一步 | ${document.title}`;
            }
          },
        );
      } catch (error) {
        if (!state.disposed) setStatus(error.name === "AbortError" ? "已取消等待。" : error.message, "error");
      } finally {
        state.running = false;
        state.canStop = false;
        state.controller = null;
        renderBusyState();
      }
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
    areaSelect.addEventListener("change", saveChangedOptions);
    premiumSelect.addEventListener("change", saveChangedOptions);
    autoSelectInput.addEventListener("change", saveChangedOptions);
    autoCloseInput.addEventListener("change", saveChangedOptions);
    autoButton?.addEventListener("click", () => runSelection(false));
    stopButton?.addEventListener("click", () => {
      if (!state.running || !state.canStop) {
        return;
      }
      state.runToken += 1;
      state.controller?.abort();
      state.canStop = false;
      renderBusyState();
      setStatus("正在停止…");
    });

    renderBusyState();
    if (seatMode && settings.autoSelect) {
      setStatus("已识别座位页，正在启动后台自动选座…");
      window.queueMicrotask(() => runSelection(true));
    }
  }

  async function readTabData() {
    if (typeof GM_getTab !== "function") return {};
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => resolve({}), 1500);
      GM_getTab((tab) => { window.clearTimeout(timer); resolve(tab || {}); });
    });
  }

  async function initializeManagedTab() {
    const tab = await readTabData();
    if (tab.odyrush && isRecent(tab.odyrush.createdAt, MANAGED_TAB_TTL)) managedTab = tab.odyrush;
    const launch = window.location.hash.match(/^#odyrush-open=([a-f0-9-]+)$/i);
    if (!isTargetSchedulePage() || !launch || typeof GM_getValue !== "function" || typeof GM_saveTab !== "function") return false;
    const key = LAUNCH_KEY + launch[1];
    const record = GM_getValue(key, null);
    if (!record || !isRecent(record.createdAt, 60000) || !isTicketDestination(record.href, window.location.href)) return false;
    tab.odyrush = {createdAt: Date.now(), token: launch[1]};
    await new Promise((resolve) => GM_saveTab(tab, resolve));
    if (typeof GM_deleteValue === "function") GM_deleteValue(key);
    // A same-site bridge records tab provenance; the actual ticket/auth URL is untouched.
    window.location.replace(record.href);
    return true;
  }

  let controlledOpenerInstalled = false;
  function installControlledBackgroundOpener() {
    if (controlledOpenerInstalled || typeof GM_openInTab !== "function") return;
    controlledOpenerInstalled = true;
    document.addEventListener("click", (event) => {
      if (!isTargetSchedulePage() || !event.ctrlKey || event.button !== 0 || !(event.target instanceof Element)) return;
      const anchor = event.target.closest("a[href]");
      if (!anchor || !isTicketDestination(anchor.href, window.location.href)) return;
      if (typeof GM_getTab !== "function" || typeof GM_saveTab !== "function" || typeof GM_setValue !== "function") return;
      const token = window.crypto.randomUUID();
      const key = LAUNCH_KEY + token;
      try {
        GM_setValue(key, {href: anchor.href, createdAt: Date.now()});
        GM_openInTab(`https://www.cinemasunshine.co.jp/theater/gdcs/#odyrush-open=${token}`, {active: false, setParent: true});
        event.preventDefault();
        event.stopImmediatePropagation();
        window.setTimeout(() => { if (typeof GM_deleteValue === "function") GM_deleteValue(key); }, 60000);
      } catch (error) { console.error("OdyRush: 托管打开失败，保留浏览器默认点击行为。", error); }
    }, true);
  }

  function detectKnownFailure(locationLike, pageText = "") {
    if (locationLike.hostname === TARGET_HOST) {
      const hash = String(locationLike.hash || "").toLowerCase();
      if (/^#\/error(?:[/?]|$)/.test(hash)) {
        return { code: "error", label: "购票错误" };
      }
      if (/^#\/congestion(?:[/?]|$)/.test(hash)) {
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

  function shouldCloseFailure({failure, autoCloseFailures, visibilityState, managed, performanceId}) {
    return Boolean(failure && autoCloseFailures && visibilityState === "hidden" &&
      managed && isRecent(managed.createdAt, MANAGED_TAB_TTL) &&
      (!performanceId || performanceId.startsWith(TARGET_PERFORMANCE_PREFIX)));
  }

  function handleKnownFailurePage() {
    const failure = detectKnownFailure(window.location, document.body?.innerText || "");
    if (!failure) return false;
    const title = `❌ ${failure.label}`;
    if (document.title !== title) document.title = title;
    if (shouldCloseFailure({failure, autoCloseFailures: loadSettings().autoCloseFailures,
      visibilityState: document.visibilityState, managed: managedTab, performanceId: currentPerformanceId()})) window.close();
    return true;
  }

  async function start() {
    if (window.location.hostname !== TARGET_HOST && window.location.hostname !== MEMBER_LOGIN_HOST &&
      !TARGET_SCHEDULE_HOSTS.has(window.location.hostname)) return;
    if (await initializeManagedTab()) return;
    if (!document.body) await new Promise((resolve) => document.addEventListener("DOMContentLoaded", resolve, {once: true}));
    installControlledBackgroundOpener();
    let scheduled = false;
    let panelContext = "";
    const refresh = () => {
      if (scheduled) return;
      scheduled = true;
      window.queueMicrotask(() => {
        scheduled = false;
        const failure = handleKnownFailurePage();
        const mode = failure ? "" : isTargetSchedulePage() ? "settings" :
          isTargetSeatPage() ? "seat" : isTargetTransaction() && window.location.hostname === TARGET_HOST &&
          !isTicketRoute(window.location) ? "settings" : "";
        const context = `${mode}:${currentPerformanceId()}`;
        if (activePanel && (context !== panelContext || !activePanel.host.isConnected)) {
          activePanel.dispose();
          activePanel.host.remove();
          activePanel = null;
        }
        panelContext = context;
        if (mode) mountPanel(mode);
      });
    };
    const observer = new MutationObserver(refresh);
    observer.observe(document.documentElement, {childList: true, subtree: true});
    window.addEventListener("hashchange", refresh);
    window.addEventListener("popstate", refresh);
    if (window.onurlchange === null) window.addEventListener("urlchange", refresh);
    document.addEventListener("visibilitychange", handleKnownFailurePage);
    window.addEventListener("pagehide", () => { activePanel?.dispose(); observer.disconnect(); });
    window.addEventListener("pageshow", (event) => {
      if (event.persisted) {
        activePanel?.host.remove();
        activePanel = null;
        observer.observe(document.documentElement, {childList: true, subtree: true});
        refresh();
      }
    });
    refresh();
  }


  return {
    MAX_SEATS,
    IMAX_ROWS,
    ROW_PENALTIES,
    seatClass,
    isCentralSeat,
    isTheater12Map,
    performanceIdFromLocation,
    isTicketRoute,
    shouldCloseFailure,
    completionKey,
    arePhysicallyContinuous,
    findBestSeats,
    hasExcludedSeatClass,
    detectKnownFailure,
    isTargetScheduleLocation,
    isSeatRoute,
    isTicketDestination,
    normalizedSettings,
    parseSeatLabel,
    typicalSeatGap,
    start,
  };
});
