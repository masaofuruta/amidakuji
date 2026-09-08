/*
 * あみだくじ
 *
 * くじの数と賞品を先に用意しておき、参加者が「まだ選ばれていないくじ」を
 * 選ぶことで、そのくじの道すじがたどられ、賞品が判明します。
 *
 * データは通信せず、この端末の localStorage にのみ保存します。
 */
(function () {
  "use strict";

  var STORAGE_KEY = "amidakuji.v1";
  var MIN_LOTS = 2;
  var MAX_LOTS = 20;

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
  var animateLot = -1; // 直近に引いたくじ（この1本だけアニメーションする）

  /* ---------- 状態 ---------- */

  function emptyState() {
    return {
      title: "",
      prizes: [], // 賞品名。長さがそのまま「くじの数」
      members: [], // 参加者名（任意）
      density: "normal",
      rungs: [], // rungs[row][col] === 1 なら col 番目と col+1 番目の縦線を結ぶ横線
      picks: [], // 引いた順に { lot: くじ番号, member: 参加者の添字 or null }
    };
  }

  function lotCount() {
    return state.prizes.length;
  }

  function sampleState() {
    var s = emptyState();
    s.title = "おやつ争奪くじ";
    s.prizes = ["🍰 ケーキ", "☕ コーヒー", "🍫 チョコ", "🧃 ジュース", "🍪 クッキー"];
    s.members = ["さとう", "すずき", "たかはし", "たなか", "いとう"];
    s.rungs = generateRungs(s.prizes.length, s.density);
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

    if (Array.isArray(data.prizes) || Array.isArray(data.members)) {
      s.prizes = toStrings(data.prizes).slice(0, MAX_LOTS);
      s.members = toStrings(data.members).slice(0, s.prizes.length);
    } else if (Array.isArray(data.pairs)) {
      // 旧形式（参加者と結果を1対1で並べていた頃）からの移行
      var pairs = data.pairs.slice(0, MAX_LOTS);
      s.prizes = pairs.map(function (p) {
        return p && typeof p.result === "string" ? p.result : "";
      });
      s.members = pairs.map(function (p) {
        return p && typeof p.name === "string" ? p.name : "";
      });
    }

    if (isValidRungs(data.rungs, s.prizes.length)) {
      s.rungs = data.rungs.map(function (row) {
        return row.map(function (v) {
          return v ? 1 : 0;
        });
      });
    } else if (s.prizes.length >= MIN_LOTS) {
      s.rungs = generateRungs(s.prizes.length, s.density);
    }

    s.picks = normalizePicks(data.picks, s.prizes.length, s.members.length);
    return s;
  }

  function toStrings(arr) {
    return Array.isArray(arr)
      ? arr.map(function (v) {
          return typeof v === "string" ? v : "";
        })
      : [];
  }

  // 1つのくじ／1人の参加者が二重に使われていないものだけ残す
  function normalizePicks(picks, lots, memberCount) {
    if (!Array.isArray(picks)) return [];
    var usedLots = [];
    var usedMembers = [];
    var out = [];
    picks.forEach(function (p) {
      if (!p || typeof p.lot !== "number") return;
      var lot = Math.floor(p.lot);
      if (lot < 0 || lot >= lots || usedLots.indexOf(lot) !== -1) return;
      var member = typeof p.member === "number" ? Math.floor(p.member) : null;
      if (member === null || member < 0 || member >= memberCount || usedMembers.indexOf(member) !== -1) {
        member = null;
      } else {
        usedMembers.push(member);
      }
      usedLots.push(lot);
      out.push({ lot: lot, member: member });
    });
    return out;
  }

  function isValidRungs(rungs, lots) {
    if (!Array.isArray(rungs) || rungs.length === 0) return false;
    if (lots < MIN_LOTS) return false;
    for (var r = 0; r < rungs.length; r++) {
      if (!Array.isArray(rungs[r]) || rungs[r].length !== lots - 1) return false;
      for (var c = 0; c < rungs[r].length - 1; c++) {
        // 同じ行で横線が隣り合うと道すじが決まらないので不正扱い
        if (rungs[r][c] && rungs[r][c + 1]) return false;
      }
    }
    return true;
  }

  /* ---------- あみだの生成 ---------- */

  function generateRungs(lots, density) {
    if (lots < MIN_LOTS) return [];
    var rows = Math.max(8, lots * 2);
    var p = DENSITY[density] || DENSITY.normal;
    var rungs = [];
    var r, c;

    for (r = 0; r < rows; r++) {
      var row = [];
      for (c = 0; c < lots - 1; c++) {
        // 直前の列に横線があると隣接してしまうため、そこには引かない
        row.push(!row[c - 1] && Math.random() < p ? 1 : 0);
      }
      rungs.push(row);
    }

    // どの縦線どうしも最低1本はつながるようにする（一直線に落ちる列をなくす）
    for (c = 0; c < lots - 1; c++) {
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
    state.rungs = generateRungs(lotCount(), state.density);
    state.picks = [];
    animateLot = -1;
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
  function rungY(row) {
    return LADDER_TOP + (row + 1) * ROW_GAP;
  }
  function ladderBottom() {
    return LADDER_TOP + (state.rungs.length + 1) * ROW_GAP;
  }

  // 縦線が画面内に収まるように列幅を決める（狭すぎるとラベルが読めないので下限あり）
  function updateColGap() {
    var wrap = document.getElementById("ladderWrap");
    var n = lotCount();
    if (!wrap || n < 1) {
      colGap = COL_GAP_MAX;
      return;
    }
    var avail = wrap.clientWidth - PAD_X * 2;
    if (avail <= 0) avail = COL_GAP_MAX * n;
    colGap = Math.max(COL_GAP_MIN, Math.min(COL_GAP_MAX, Math.floor(avail / n)));
  }

  /* ---------- くじの状態 ---------- */

  function pickOfLot(lot) {
    for (var i = 0; i < state.picks.length; i++) {
      if (state.picks[i].lot === lot) return state.picks[i];
    }
    return null;
  }

  function isDrawn(lot) {
    return pickOfLot(lot) !== null;
  }

  function remainingLots() {
    var out = [];
    for (var i = 0; i < lotCount(); i++) if (!isDrawn(i)) out.push(i);
    return out;
  }

  // まだ引いていない参加者の添字
  function remainingMembers() {
    var used = state.picks
      .map(function (p) {
        return p.member;
      })
      .filter(function (m) {
        return m !== null;
      });
    var out = [];
    for (var i = 0; i < state.members.length; i++) {
      if (used.indexOf(i) === -1) out.push(i);
    }
    return out;
  }

  function prizeOf(lot) {
    return (state.prizes[lot] || "").trim() || "賞品" + (lot + 1);
  }
  function memberName(index) {
    return (state.members[index] || "").trim() || "参加者" + (index + 1);
  }
  function lotLabel(lot) {
    return "くじ" + (lot + 1);
  }
  function pickLabel(pick) {
    return pick.member === null ? lotLabel(pick.lot) : memberName(pick.member);
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
    renderPrizes();
    renderMembers();
    renderLadder(-1);
    renderResults();
    syncControls();
  }

  function renderPrizes() {
    var box = document.getElementById("prizesContainer");
    box.innerHTML = "";
    if (lotCount() === 0) {
      box.appendChild(emptyMessage("「＋」でくじの数を決めると、賞品の入力欄が出ます。"));
      return;
    }
    state.prizes.forEach(function (prize, i) {
      var row = document.createElement("div");
      row.className = "prize-row";

      // 賞品は「あみだの下端の左から何番目か」で並ぶ。上端のくじ番号とは対応しない
      var tag = document.createElement("span");
      tag.className = "lot-tag";
      tag.textContent = i + 1 + "番目";

      var input = document.createElement("input");
      input.type = "text";
      input.value = prize;
      input.placeholder = "賞品" + (i + 1);
      input.setAttribute("aria-label", i + 1 + "番目の賞品");
      input.addEventListener("input", function () {
        state.prizes[i] = input.value;
        renderLadder(-1);
        renderResults();
        save();
      });

      row.appendChild(tag);
      row.appendChild(input);
      box.appendChild(row);
    });
  }

  function renderMembers() {
    var box = document.getElementById("membersContainer");
    box.innerHTML = "";
    if (state.members.length === 0) {
      box.appendChild(emptyMessage("「＋ 名前を追加」で参加者を登録できます（未登録でも引けます）。"));
      return;
    }
    state.members.forEach(function (name, i) {
      var row = document.createElement("div");
      row.className = "member-row";

      var input = document.createElement("input");
      input.type = "text";
      input.value = name;
      input.placeholder = "参加者" + (i + 1);
      input.setAttribute("aria-label", (i + 1) + "人目の名前");
      input.addEventListener("input", function () {
        state.members[i] = input.value;
        renderLadder(-1);
        renderResults();
        syncControls();
        save();
      });

      var del = document.createElement("button");
      del.type = "button";
      del.className = "icon-btn";
      del.textContent = "✕";
      del.title = "この名前を削除";
      del.setAttribute("aria-label", (i + 1) + "人目を削除");
      del.addEventListener("click", function () {
        removeMember(i);
      });

      row.appendChild(input);
      row.appendChild(del);
      box.appendChild(row);
    });
  }

  function emptyMessage(text) {
    var p = document.createElement("p");
    p.className = "empty";
    p.textContent = text;
    return p;
  }

  function renderLadder(animateIndex) {
    var svg = document.getElementById("ladder");
    var hint = document.getElementById("ladderHint");
    svg.innerHTML = "";
    updateColGap();

    var n = lotCount();
    if (n < MIN_LOTS || state.rungs.length === 0) {
      svg.setAttribute("viewBox", "0 0 320 80");
      svg.setAttribute("width", "320");
      svg.setAttribute("height", "80");
      var msg = el("text", { x: 160, y: 44, class: "slot-text" });
      msg.textContent = "くじの数を2以上にすると表示されます";
      svg.appendChild(msg);
      hint.textContent = "「くじの数」を2以上にしてください。";
      return;
    }

    var left = remainingLots().length;
    hint.textContent = left > 0
      ? "まだ選ばれていないくじ（グレーの「くじ◯」）をタップすると、道すじをたどって賞品が判明します。"
      : "すべてのくじが引かれました。";

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

    // 道すじ（引かれたぶん）。直近の1本だけ最後にアニメーションで描く
    var traceLayer = el("g", { id: "traceLayer" });
    svg.appendChild(traceLayer);
    state.picks.forEach(function (p, order) {
      if (p.lot !== animateIndex) drawTrace(traceLayer, p.lot, order, false);
    });
    var animated = pickOfLot(animateIndex);
    if (animated) {
      drawTrace(traceLayer, animated.lot, state.picks.indexOf(animated), true);
    }

    // 上（くじ）と下（賞品）のラベル
    var openCols = state.picks.map(function (p) {
      return trace(p.lot).endCol;
    });
    var inner = colGap - 20; // ラベルに使える横幅
    for (var i2 = 0; i2 < n; i2++) {
      var pick = pickOfLot(i2);
      var topLabel = pick ? pickLabel(pick) : lotLabel(i2);
      var top = makeTopSlot(i2, topLabel, pick);
      svg.appendChild(top);
      fitSlotText(top, topLabel, inner);

      var open = openCols.indexOf(i2) !== -1;
      var label = open ? prizeOf(i2) : "？";
      var btm = makeBottomSlot(i2, label, bottom + BOX_H / 2 + 10, open);
      svg.appendChild(btm);
      fitSlotText(btm, label, inner);
    }
  }

  function makeSlotGroup(index, label, cy, className) {
    var g = el("g", { class: className });
    var bw = colGap - 12;
    g.appendChild(
      el("rect", { class: "slot-box", x: x(index) - bw / 2, y: cy - BOX_H / 2, width: bw, height: BOX_H, rx: 7 })
    );
    var text = el("text", { class: "slot-text", x: x(index), y: cy + 1 });
    text.textContent = label;
    g.appendChild(text);
    var title = el("title");
    title.textContent = label;
    g.appendChild(title);
    return g;
  }

  function makeTopSlot(lot, label, pick) {
    var cls = "slot slot-top" + (pick ? " is-drawn" : " is-open");
    var g = makeSlotGroup(lot, label, 24, cls);
    if (!pick) {
      g.addEventListener("click", function () {
        drawLot(lot);
      });
    }
    return g;
  }

  function makeBottomSlot(lot, label, cy, open) {
    return makeSlotGroup(lot, label, cy, "slot slot-bottom" + (open ? "" : " is-hidden"));
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

  function drawTrace(layer, lot, order, animate) {
    var path = trace(lot);
    var d = path.points
      .map(function (pt, i) {
        return (i === 0 ? "M" : "L") + pt[0] + " " + pt[1];
      })
      .join(" ");
    var node = el("path", { class: "trace-path", d: d });
    // CSS の stroke 指定より優先させるため style で色を付ける
    node.style.stroke = TRACE_COLORS[Math.max(0, order) % TRACE_COLORS.length];
    layer.appendChild(node);
    if (animate) {
      var len = node.getTotalLength();
      node.style.strokeDasharray = len;
      node.style.strokeDashoffset = len;
      node.getBoundingClientRect(); // 再描画を確定させてからアニメーションを開始
      node.classList.add("animating");
      node.style.strokeDashoffset = 0;
    }
  }

  function renderResults() {
    var box = document.getElementById("resultsContainer");
    box.innerHTML = "";
    if (state.picks.length === 0) return;

    var list = document.createElement("div");
    list.className = "result-list";
    state.picks.forEach(function (p) {
      var item = document.createElement("div");
      item.className = "result-item" + (p.lot === animateLot ? " is-active" : "");
      item.innerHTML =
        '<span class="result-name"></span><span class="result-lot"></span>' +
        '<span class="result-arrow">→</span><span class="result-value"></span>';
      item.querySelector(".result-name").textContent = pickLabel(p);
      item.querySelector(".result-lot").textContent =
        p.member === null ? "" : "（" + lotLabel(p.lot) + "）";
      item.querySelector(".result-value").textContent = prizeOf(trace(p.lot).endCol);
      list.appendChild(item);
    });
    box.appendChild(list);
  }

  function syncControls() {
    var n = lotCount();
    var left = remainingLots().length;

    document.getElementById("lotCountValue").textContent = n;
    document.getElementById("lotMinusBtn").disabled = n <= 0;
    document.getElementById("lotPlusBtn").disabled = n >= MAX_LOTS;
    document.getElementById("addMemberBtn").disabled = state.members.length >= Math.max(n, 1) || n === 0;
    document.getElementById("regenerateBtn").disabled = n < MIN_LOTS;
    document.getElementById("shufflePrizesBtn").disabled = n < MIN_LOTS;
    document.getElementById("revealRestBtn").disabled = n < MIN_LOTS || left === 0;
    document.getElementById("resetDrawsBtn").disabled = state.picks.length === 0;
    document.getElementById("densitySelect").value = state.density;
    document.getElementById("lotteryTitle").value = state.title;

    var remaining = document.getElementById("remainingLabel");
    remaining.textContent = n < MIN_LOTS ? "" : "残り " + left + " / " + n + " 本";

    renderDrawerSelect();
  }

  // 「次に引く人」の候補。未登録・全員引き終わりのときは「名前なし」だけになる
  function renderDrawerSelect() {
    var select = document.getElementById("drawerSelect");
    var previous = select.value;
    select.innerHTML = "";
    remainingMembers().forEach(function (i) {
      var opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = memberName(i);
      select.appendChild(opt);
    });
    var none = document.createElement("option");
    none.value = "none";
    none.textContent = "名前なし";
    select.appendChild(none);

    // 直前に選んでいた人がまだ引いていなければ維持し、そうでなければ次の人に送る。
    // 「名前なし」は引き継がない（引くたびに次の人が既定になるように）
    var kept =
      previous !== "" &&
      previous !== "none" &&
      Array.prototype.some.call(select.options, function (o) {
        return o.value === previous;
      });
    select.value = kept ? previous : select.options[0].value;
  }

  function currentDrawer() {
    var v = document.getElementById("drawerSelect").value;
    return v === "none" || v === "" ? null : Number(v);
  }

  /* ---------- 操作 ---------- */

  function setLotCount(next) {
    var n = Math.max(0, Math.min(MAX_LOTS, next));
    if (n === lotCount()) return;
    if (state.picks.length > 0 && !confirm("くじの数を変えると、引いた結果はリセットされます。よろしいですか？")) {
      return;
    }
    while (state.prizes.length < n) state.prizes.push("");
    state.prizes.length = n;
    if (state.members.length > n) state.members.length = n;
    regenerate();
    renderAll();
    save();
  }

  function addMember() {
    if (state.members.length >= lotCount()) return;
    state.members.push("");
    renderMembers();
    syncControls();
    save();
  }

  function removeMember(index) {
    // 削除した人が引いていたくじは未選択に戻し、以降の添字をずらす
    state.picks = state.picks
      .filter(function (p) {
        return p.member !== index;
      })
      .map(function (p) {
        if (p.member !== null && p.member > index) return { lot: p.lot, member: p.member - 1 };
        return p;
      });
    state.members.splice(index, 1);
    animateLot = -1;
    renderAll();
    save();
  }

  function drawLot(lot) {
    if (isDrawn(lot)) return;
    var member = currentDrawer();
    if (member !== null && remainingMembers().indexOf(member) === -1) member = null;
    state.picks.push({ lot: lot, member: member });
    animateLot = lot;
    renderLadder(lot);
    renderResults();
    syncControls();
    save();
  }

  // 残ったくじを一気に開く（引く人は割り当てず、くじ番号のまま表示する）
  function revealRest() {
    remainingLots().forEach(function (lot) {
      state.picks.push({ lot: lot, member: null });
    });
    animateLot = -1;
    renderLadder(-1);
    renderResults();
    syncControls();
    save();
  }

  function resetDraws() {
    if (state.picks.length === 0) return;
    if (!confirm("引いた結果をすべて取り消します。よろしいですか？")) return;
    state.picks = [];
    animateLot = -1;
    renderAll();
    save();
  }

  function shufflePrizes() {
    if (state.picks.length > 0 && !confirm("賞品を並べ替えると、引いた結果はリセットされます。よろしいですか？")) {
      return;
    }
    state.prizes = shuffled(state.prizes);
    state.picks = [];
    animateLot = -1;
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
    if (lotCount() < MIN_LOTS) {
      alert("共有するデータがありません。くじの数を2以上にしてください。");
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
      animateLot = -1;
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
    document.getElementById("lotPlusBtn").addEventListener("click", function () {
      setLotCount(lotCount() === 0 ? MIN_LOTS : lotCount() + 1);
    });
    document.getElementById("lotMinusBtn").addEventListener("click", function () {
      setLotCount(lotCount() <= MIN_LOTS ? 0 : lotCount() - 1);
    });
    document.getElementById("densitySelect").addEventListener("change", function (e) {
      state.density = e.target.value;
      regenerate();
      renderAll();
      save();
    });
    document.getElementById("shufflePrizesBtn").addEventListener("click", shufflePrizes);
    document.getElementById("addMemberBtn").addEventListener("click", addMember);
    document.getElementById("regenerateBtn").addEventListener("click", function () {
      if (state.picks.length > 0 && !confirm("くじを作り直すと、引いた結果はリセットされます。よろしいですか？")) {
        return;
      }
      regenerate();
      renderAll();
      save();
    });
    document.getElementById("revealRestBtn").addEventListener("click", revealRest);
    document.getElementById("resetDrawsBtn").addEventListener("click", resetDraws);
    document.getElementById("shareBtn").addEventListener("click", createShareLink);
    document.getElementById("copyShareBtn").addEventListener("click", function () {
      var input = document.getElementById("shareUrl");
      input.select();
      copyText(input.value);
    });
    document.getElementById("sampleBtn").addEventListener("click", function () {
      if (lotCount() > 0 && !confirm("今の内容をサンプルデータで置き換えます。よろしいですか？")) return;
      state = sampleState();
      animateLot = -1;
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
      animateLot = -1;
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
