/*
 * あみだくじ
 *
 * 参加者と結果を入力すると、ランダムな横線を持つあみだくじを生成し、
 * SVG 上で道すじをたどって結果を決めます。
 *
 * データは通信せず、この端末の localStorage にのみ保存します。
 */
(function () {
  "use strict";

  var STORAGE_KEY = "amidakuji.v1";
  var MIN_LINES = 2;
  var MAX_LINES = 20;

  // 横線の多さ（1行あたり、隣り合う縦線の間に線を引く確率）
  var DENSITY = { low: 0.22, normal: 0.36, high: 0.52 };

  // 図の寸法（px）
  var PAD_X = 16;
  var COL_GAP_MAX = 92;
  var COL_GAP_MIN = 62;
  var colGap = COL_GAP_MAX; // 実際の列幅。画面幅に合わせて描画のたびに決める
  var ROW_GAP = 26;
  var LADDER_TOP = 58;
  var BOX_H = 32;

  // 複数の道すじを同時に表示するときの色
  var TRACE_COLORS = [
    "#3f51b5", "#c0392b", "#0f8a5f", "#d4a017", "#8e44ad",
    "#0f7b8a", "#d2691e", "#5d6d7e", "#b03060", "#2e7d32",
  ];

  var state = emptyState();
  var isSharedView = false;
  var activeIndex = -1; // 直近にたどった参加者（強調表示用）
  var revealed = []; // 結果を表示済みの参加者インデックス

  /* ---------- 状態 ---------- */

  function emptyState() {
    return {
      title: "",
      pairs: [],
      density: "normal",
      rungs: [], // rungs[row][col] === 1 なら col 番目と col+1 番目の縦線を結ぶ横線
    };
  }

  function sampleState() {
    var names = ["さとう", "すずき", "たかはし", "たなか", "いとう"];
    var results = ["🍰 ケーキ", "☕ コーヒー", "🍫 チョコ", "🧃 ジュース", "🍪 クッキー"];
    var s = emptyState();
    s.title = "おやつ争奪あみだ";
    s.density = "normal";
    s.pairs = names.map(function (n, i) {
      return { name: n, result: results[i] };
    });
    s.rungs = generateRungs(s.pairs.length, s.density);
    return s;
  }

  function save() {
    if (isSharedView) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      setSaveStatus("自動保存: 保存しました");
    } catch (e) {
      setSaveStatus("自動保存: 失敗しました（保存容量を確認してください）");
    }
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return normalizeState(JSON.parse(raw));
    } catch (e) {
      return null;
    }
  }

  // 外部（保存データ・共有リンク・JSON）から来たデータを安全な形に整える
  function normalizeState(data) {
    if (!data || typeof data !== "object") return null;
    var s = emptyState();
    s.title = typeof data.title === "string" ? data.title : "";
    s.density = DENSITY[data.density] ? data.density : "normal";
    s.pairs = Array.isArray(data.pairs)
      ? data.pairs.slice(0, MAX_LINES).map(function (p) {
          return {
            name: p && typeof p.name === "string" ? p.name : "",
            result: p && typeof p.result === "string" ? p.result : "",
          };
        })
      : [];
    if (isValidRungs(data.rungs, s.pairs.length)) {
      s.rungs = data.rungs.map(function (row) {
        return row.map(function (v) {
          return v ? 1 : 0;
        });
      });
    } else if (s.pairs.length >= MIN_LINES) {
      s.rungs = generateRungs(s.pairs.length, s.density);
    }
    return s;
  }

  function isValidRungs(rungs, lineCount) {
    if (!Array.isArray(rungs) || rungs.length === 0) return false;
    if (lineCount < MIN_LINES) return false;
    for (var r = 0; r < rungs.length; r++) {
      if (!Array.isArray(rungs[r]) || rungs[r].length !== lineCount - 1) return false;
      for (var c = 0; c < rungs[r].length - 1; c++) {
        // 同じ行で横線が隣り合うと道すじが決まらないので不正扱い
        if (rungs[r][c] && rungs[r][c + 1]) return false;
      }
    }
    return true;
  }

  /* ---------- あみだの生成 ---------- */

  function generateRungs(lineCount, density) {
    if (lineCount < MIN_LINES) return [];
    var rows = Math.max(8, lineCount * 2);
    var p = DENSITY[density] || DENSITY.normal;
    var rungs = [];
    var r, c;

    for (r = 0; r < rows; r++) {
      var row = [];
      for (c = 0; c < lineCount - 1; c++) {
        // 直前の列に横線があると隣接してしまうため、そこには引かない
        row.push(!row[c - 1] && Math.random() < p ? 1 : 0);
      }
      rungs.push(row);
    }

    // どの縦線どうしも最低1本はつながるようにする（一直線に落ちる列をなくす）
    for (c = 0; c < lineCount - 1; c++) {
      var used = rungs.some(function (row) {
        return row[c] === 1;
      });
      if (used) continue;
      var order = shuffled(rungs.map(function (_, i) {
        return i;
      }));
      for (var i = 0; i < order.length; i++) {
        var row2 = rungs[order[i]];
        if (!row2[c - 1] && !row2[c + 1]) {
          row2[c] = 1;
          break;
        }
      }
    }
    return rungs;
  }

  function shuffled(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
  }

  function regenerate() {
    state.rungs = generateRungs(state.pairs.length, state.density);
    clearReveals();
  }

  /* ---------- 道すじの計算 ---------- */

  // 上から col 番目の縦線を出発し、横線があれば必ず曲がりながら下まで進む
  function trace(startCol) {
    var col = startCol;
    var points = [[x(col), LADDER_TOP]];
    for (var r = 0; r < state.rungs.length; r++) {
      var row = state.rungs[r];
      var y = rungY(r);
      if (row[col]) {
        points.push([x(col), y], [x(col + 1), y]);
        col += 1;
      } else if (col > 0 && row[col - 1]) {
        points.push([x(col), y], [x(col - 1), y]);
        col -= 1;
      }
    }
    points.push([x(col), ladderBottom()]);
    return { points: points, endCol: col };
  }

  function x(col) {
    return PAD_X + colGap / 2 + col * colGap;
  }

  // 縦線が画面内に収まるように列幅を決める（狭すぎるとラベルが読めないので下限あり）
  function updateColGap() {
    var wrap = document.getElementById("ladderWrap");
    var n = state.pairs.length;
    if (!wrap || n < 1) {
      colGap = COL_GAP_MAX;
      return;
    }
    var avail = wrap.clientWidth - PAD_X * 2;
    if (avail <= 0) avail = COL_GAP_MAX * n;
    colGap = Math.max(COL_GAP_MIN, Math.min(COL_GAP_MAX, Math.floor(avail / n)));
  }
  function rungY(row) {
    return LADDER_TOP + (row + 1) * ROW_GAP;
  }
  function ladderBottom() {
    return LADDER_TOP + (state.rungs.length + 1) * ROW_GAP;
  }

  /* ---------- 描画 ---------- */

  var SVG_NS = "http://www.w3.org/2000/svg";

  function el(name, attrs) {
    var node = document.createElementNS(SVG_NS, name);
    Object.keys(attrs || {}).forEach(function (k) {
      node.setAttribute(k, attrs[k]);
    });
    return node;
  }

  function renderAll() {
    renderPairs();
    renderLadder(-1);
    renderResults();
    syncControls();
  }

  function renderPairs() {
    var box = document.getElementById("pairsContainer");
    box.innerHTML = "";
    if (state.pairs.length === 0) {
      var p = document.createElement("p");
      p.className = "empty";
      p.textContent = "「＋ 1人ぶん追加」で参加者と結果を登録してください。";
      box.appendChild(p);
      return;
    }
    state.pairs.forEach(function (pair, i) {
      var row = document.createElement("div");
      row.className = "pair-row";

      var name = document.createElement("input");
      name.type = "text";
      name.value = pair.name;
      name.placeholder = "参加者" + (i + 1);
      name.setAttribute("aria-label", (i + 1) + "人目の参加者名");
      name.addEventListener("input", function () {
        state.pairs[i].name = name.value;
        renderLadder(-1);
        renderResults();
        save();
      });

      var result = document.createElement("input");
      result.type = "text";
      result.value = pair.result;
      result.placeholder = "結果" + (i + 1);
      result.setAttribute("aria-label", (i + 1) + "番目の結果");
      result.addEventListener("input", function () {
        state.pairs[i].result = result.value;
        renderLadder(-1);
        renderResults();
        save();
      });

      var del = document.createElement("button");
      del.type = "button";
      del.className = "icon-btn";
      del.textContent = "✕";
      del.title = "この行を削除";
      del.setAttribute("aria-label", (i + 1) + "行目を削除");
      del.addEventListener("click", function () {
        state.pairs.splice(i, 1);
        regenerate();
        renderAll();
        save();
      });

      row.appendChild(name);
      row.appendChild(result);
      row.appendChild(del);
      box.appendChild(row);
    });
  }

  function nameOf(i) {
    return state.pairs[i].name.trim() || "参加者" + (i + 1);
  }
  function resultOf(i) {
    return state.pairs[i].result.trim() || "結果" + (i + 1);
  }

  function renderLadder(animateIndex) {
    var svg = document.getElementById("ladder");
    var hint = document.getElementById("ladderHint");
    svg.innerHTML = "";
    updateColGap();

    var n = state.pairs.length;
    if (n < MIN_LINES || state.rungs.length === 0) {
      svg.setAttribute("viewBox", "0 0 320 80");
      svg.setAttribute("width", "320");
      svg.setAttribute("height", "80");
      svg.appendChild(
        el("text", { x: 160, y: 44, class: "slot-text", "font-size": 14 })
      ).textContent = "参加者を2人以上登録するとあみだが表示されます";
      hint.textContent = "参加者を2人以上登録してください。";
      return;
    }
    hint.textContent = "参加者名をタップすると、その人の道すじをたどります。";

    var w = PAD_X * 2 + n * colGap;
    var bottom = ladderBottom();
    var h = bottom + LADDER_TOP;
    svg.setAttribute("viewBox", "0 0 " + w + " " + h);
    svg.setAttribute("width", w);
    svg.setAttribute("height", h);

    // 縦線
    for (var c = 0; c < n; c++) {
      svg.appendChild(
        el("line", { class: "ladder-line", x1: x(c), y1: LADDER_TOP, x2: x(c), y2: bottom })
      );
    }
    // 横線
    state.rungs.forEach(function (row, r) {
      row.forEach(function (v, c2) {
        if (!v) return;
        svg.appendChild(
          el("line", { class: "ladder-rung", x1: x(c2), y1: rungY(r), x2: x(c2 + 1), y2: rungY(r) })
        );
      });
    });

    // 道すじ（表示済みのぶん）を先に描く。直近の1本だけ最後にアニメーションで描く
    var traceLayer = el("g", { id: "traceLayer" });
    svg.appendChild(traceLayer);
    revealed.forEach(function (i) {
      if (i !== animateIndex) drawTrace(traceLayer, i, false);
    });
    if (revealed.indexOf(animateIndex) !== -1) drawTrace(traceLayer, animateIndex, true);

    // 上（参加者）と下（結果）のラベル。結果は、道すじが到達した列だけ見えるようにする
    var openCols = revealedEndCols();
    var inner = colGap - 20; // ラベルに使える横幅
    for (var i2 = 0; i2 < n; i2++) {
      var top = makeSlot(i2, nameOf(i2), 24, true);
      svg.appendChild(top);
      fitSlotText(top, nameOf(i2), inner);

      var open = openCols.indexOf(i2) !== -1;
      var label = open ? resultOf(i2) : "？";
      var btm = makeSlot(i2, label, bottom + BOX_H / 2 + 10, false, open);
      svg.appendChild(btm);
      fitSlotText(btm, label, inner);
    }
  }

  // ラベルが枠に収まるまで、文字を少し小さくし、それでも溢れる場合だけ末尾を省略する
  function fitSlotText(g, label, maxWidth) {
    var text = g.querySelector("text");
    if (!text || !text.getComputedTextLength) return;
    var size = 13;
    while (size > 9 && text.getComputedTextLength() > maxWidth) {
      size -= 1;
      text.style.fontSize = size + "px";
    }
    var chars = Array.from(label);
    while (chars.length > 1 && text.getComputedTextLength() > maxWidth) {
      chars.pop();
      text.textContent = chars.join("") + "…";
    }
  }

  // 表示済みの参加者がたどり着いた「結果」の列
  function revealedEndCols() {
    return revealed.map(function (i) {
      return trace(i).endCol;
    });
  }

  function makeSlot(index, label, cy, isTop, isOpen) {
    var g = el("g", { class: "slot " + (isTop ? "slot-top" : "slot-bottom") });
    var bw = colGap - 12;
    g.appendChild(
      el("rect", { class: "slot-box", x: x(index) - bw / 2, y: cy - BOX_H / 2, width: bw, height: BOX_H, rx: 7 })
    );
    var text = el("text", { class: "slot-text", x: x(index), y: cy + 1 });
    text.textContent = label;
    g.appendChild(text);

    if (isTop) {
      if (index === activeIndex) g.setAttribute("class", g.getAttribute("class") + " is-active");
      var title = el("title");
      title.textContent = label;
      g.appendChild(title);
      g.addEventListener("click", function () {
        revealOne(index);
      });
    } else if (!isOpen) {
      g.setAttribute("class", g.getAttribute("class") + " is-hidden");
    }
    return g;
  }

  function drawTrace(layer, index, animate) {
    var path = trace(index);
    var d = path.points
      .map(function (pt, i) {
        return (i === 0 ? "M" : "L") + pt[0] + " " + pt[1];
      })
      .join(" ");
    var node = el("path", {
      class: "trace-path",
      d: d,
      stroke: TRACE_COLORS[index % TRACE_COLORS.length],
    });
    layer.appendChild(node);
    if (animate) {
      var len = node.getTotalLength();
      node.style.strokeDasharray = len;
      node.style.strokeDashoffset = len;
      node.getBoundingClientRect(); // 再描画を確定させてからアニメーションを開始
      node.classList.add("animating");
      node.style.strokeDashoffset = 0;
    }
    return path.endCol;
  }

  function renderResults() {
    var box = document.getElementById("resultsContainer");
    box.innerHTML = "";
    if (revealed.length === 0) return;

    var list = document.createElement("div");
    list.className = "result-list";
    revealed
      .slice()
      .sort(function (a, b) {
        return a - b;
      })
      .forEach(function (i) {
        var endCol = trace(i).endCol;
        var item = document.createElement("div");
        item.className = "result-item" + (i === activeIndex ? " is-active" : "");
        item.innerHTML =
          '<span class="result-name"></span><span class="result-arrow">→</span><span class="result-value"></span>';
        item.querySelector(".result-name").textContent = nameOf(i);
        item.querySelector(".result-value").textContent = resultOf(endCol);
        list.appendChild(item);
      });
    box.appendChild(list);
  }

  function syncControls() {
    var n = state.pairs.length;
    document.getElementById("addRowBtn").disabled = n >= MAX_LINES;
    document.getElementById("regenerateBtn").disabled = n < MIN_LINES;
    document.getElementById("revealAllBtn").disabled = n < MIN_LINES;
    document.getElementById("hideAllBtn").disabled = revealed.length === 0;
    document.getElementById("shuffleResultsBtn").disabled = n < MIN_LINES;
    document.getElementById("densitySelect").value = state.density;
    document.getElementById("lotteryTitle").value = state.title;
  }

  /* ---------- 操作 ---------- */

  function addRow() {
    if (state.pairs.length >= MAX_LINES) return;
    state.pairs.push({ name: "", result: "" });
    regenerate();
    renderAll();
    save();
  }

  function clearReveals() {
    revealed = [];
    activeIndex = -1;
  }

  function revealOne(index) {
    activeIndex = index;
    if (revealed.indexOf(index) === -1) revealed.push(index);
    renderLadder(index);
    renderResults();
    syncControls();
  }

  function revealAll() {
    revealed = state.pairs.map(function (_, i) {
      return i;
    });
    activeIndex = -1;
    renderLadder(-1);
    renderResults();
    syncControls();
  }

  function hideAll() {
    clearReveals();
    renderLadder(-1);
    renderResults();
    syncControls();
  }

  function shuffleResults() {
    var values = shuffled(
      state.pairs.map(function (p) {
        return p.result;
      })
    );
    state.pairs.forEach(function (p, i) {
      p.result = values[i];
    });
    clearReveals();
    renderAll();
    save();
  }

  /* ---------- 共有リンク・入出力 ---------- */

  // UTF-8 対応の URL セーフな base64 エンコード/デコード
  function encodePayload(obj) {
    var bytes = new TextEncoder().encode(JSON.stringify(obj));
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function decodePayload(s) {
    var b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  function readSharedFromUrl() {
    var m = (location.hash || "").match(/[#&]view=([^&]+)/);
    if (!m) return null;
    try {
      return normalizeState(decodePayload(m[1]));
    } catch (e) {
      return null;
    }
  }

  function createShareLink() {
    if (state.pairs.length < MIN_LINES) {
      alert("共有するデータがありません。参加者を2人以上登録してください。");
      return;
    }
    var url = location.href.split("#")[0] + "#view=" + encodePayload(state);
    var out = document.getElementById("shareOutput");
    var input = document.getElementById("shareUrl");
    input.value = url;
    out.hidden = false;
    input.focus();
    input.select();
    copyText(url).then(function (ok) {
      document.getElementById("shareMsg").textContent = ok
        ? "リンクをコピーしました。メールやLINEなどで共有してください。"
        : "下のリンクをコピーして共有してください。";
    });
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(
        function () {
          return true;
        },
        function () {
          return false;
        }
      );
    }
    return Promise.resolve(false);
  }

  function exportJson() {
    var blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (state.title.trim() || "amidakuji") + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function importJson(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var loaded = null;
      try {
        loaded = normalizeState(JSON.parse(String(reader.result)));
      } catch (e) {
        loaded = null;
      }
      if (!loaded) {
        alert("読み込めませんでした。このアプリで書き出した JSON を選んでください。");
        return;
      }
      state = loaded;
      clearReveals();
      renderAll();
      save();
    };
    reader.readAsText(file);
  }

  function setSaveStatus(text) {
    document.getElementById("saveStatus").textContent = text;
  }

  /* ---------- 起動 ---------- */

  function bindEvents() {
    document.getElementById("lotteryTitle").addEventListener("input", function (e) {
      state.title = e.target.value;
      save();
    });
    document.getElementById("densitySelect").addEventListener("change", function (e) {
      state.density = e.target.value;
      regenerate();
      renderAll();
      save();
    });
    document.getElementById("addRowBtn").addEventListener("click", addRow);
    document.getElementById("shuffleResultsBtn").addEventListener("click", shuffleResults);
    document.getElementById("regenerateBtn").addEventListener("click", function () {
      regenerate();
      renderAll();
      save();
    });
    document.getElementById("revealAllBtn").addEventListener("click", revealAll);
    document.getElementById("hideAllBtn").addEventListener("click", hideAll);
    document.getElementById("shareBtn").addEventListener("click", createShareLink);
    document.getElementById("copyShareBtn").addEventListener("click", function () {
      var input = document.getElementById("shareUrl");
      input.select();
      copyText(input.value);
    });
    document.getElementById("sampleBtn").addEventListener("click", function () {
      if (state.pairs.length > 0 && !confirm("今の内容をサンプルデータで置き換えます。よろしいですか？")) return;
      state = sampleState();
      clearReveals();
      renderAll();
      save();
    });
    document.getElementById("exportBtn").addEventListener("click", exportJson);
    document.getElementById("importBtn").addEventListener("click", function () {
      document.getElementById("importFile").click();
    });
    document.getElementById("importFile").addEventListener("change", function (e) {
      if (e.target.files && e.target.files[0]) importJson(e.target.files[0]);
      e.target.value = "";
    });
    document.getElementById("resetBtn").addEventListener("click", function () {
      if (!confirm("すべての内容を消去します。よろしいですか？")) return;
      state = emptyState();
      clearReveals();
      renderAll();
      save();
    });
    var resizeTimer = null;
    window.addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        renderLadder(-1);
      }, 150);
    });
    document.getElementById("editHereBtn").addEventListener("click", function () {
      isSharedView = false;
      location.hash = "";
      document.getElementById("sharedBanner").hidden = true;
      save();
      setSaveStatus("自動保存: この端末に保存しました");
    });
  }

  function init() {
    bindEvents();
    var shared = readSharedFromUrl();
    if (shared) {
      isSharedView = true;
      state = shared;
      document.getElementById("sharedBanner").hidden = false;
      setSaveStatus("共有ビュー: 保存しません");
    } else {
      state = load() || emptyState();
      setSaveStatus("自動保存: 有効");
    }
    renderAll();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
