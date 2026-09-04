/* ============================================================
   Islamic Relief Pakistan — Fundraising Dashboard
   Layers: Config -> Storage (Supabase) -> State -> Calculations
           -> Rendering -> Events

   Donation records live in Supabase and are the single source of
   truth. localStorage is used ONLY for device-local campaign
   settings (name, target, description, milestones, celebration
   log, cash adjustment) — never for donations.
   ============================================================ */
(function () {
  "use strict";

  /* ============================================================
     1. SUPABASE CONFIGURATION
     ------------------------------------------------------------
     Project Settings -> API Keys in the Supabase dashboard.
     Only the "publishable" (or legacy "anon") key belongs here.
     It is meant to be public — Row Level Security is what protects
     the data. Never paste a secret / service_role key into this
     file: everything here is readable once the site is deployed.
     ============================================================ */
  var SUPABASE_URL = "https://vvodmshgosiohgyumkkr.supabase.co";
  var SUPABASE_PUBLISHABLE_KEY = "sb_publishable_VgYSNwLLuwXnoHu6kbc-Yg_d_OnnXTb";
  var DONATIONS_TABLE = "donations";
  /* ========================= END CONFIG ====================== */

  var REQUEST_TIMEOUT_MS = 12000;
  var SETTINGS_KEY = "irp.settings.v3";
  var LEGACY_DONATIONS_KEY = "irp.fundraising.v1"; // old localStorage store — removed on boot

  var CONFIG_MESSAGE =
    "Supabase is not configured yet. Open script.js and set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY.";
  var ADMIN_MESSAGE =
    "Removing donations is restricted to an admin. Sign in first, then try again.";

  /* ---------- 2. Storage layer: Supabase (donations) ---------- */
  var db = null;
  var realtimeChannel = null;
  var realtimeOk = false;

  function createClient() {
    if (!window.supabase || typeof window.supabase.createClient !== "function") return null;
    if (!SUPABASE_URL || SUPABASE_URL.indexOf("YOUR_SUPABASE") === 0) return null;
    if (!SUPABASE_PUBLISHABLE_KEY || SUPABASE_PUBLISHABLE_KEY.indexOf("YOUR_SUPABASE") === 0) return null;
    try {
      return window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
    } catch (e) {
      return null;
    }
  }

  function friendlyError(error) {
    var msg = (error && error.message) || "";
    var code = (error && error.code) || "";
    if (code === "42501" || /row-level security/i.test(msg)) return ADMIN_MESSAGE;
    if (code === "42P01" || /relation .* does not exist/i.test(msg)) {
      return "The donations table was not found. Run the setup SQL in your Supabase project.";
    }
    if (/Invalid login credentials/i.test(msg)) return "That email or password is not correct.";
    if (/Email not confirmed/i.test(msg)) {
      return "That account is not confirmed yet. Open Authentication in Supabase and confirm the user.";
    }
    if (/JWT|api key|Invalid authentication/i.test(msg)) {
      return "Supabase rejected the key. Check SUPABASE_PUBLISHABLE_KEY in script.js.";
    }
    if (/Failed to fetch|NetworkError|load failed/i.test(msg)) {
      return "Could not reach Supabase. Check the internet connection and SUPABASE_URL.";
    }
    return msg || "Something went wrong talking to Supabase.";
  }

  // Never let a request hang the dashboard.
  function withTimeout(thenable, label) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = window.setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error(label + " timed out. Check your connection and try again."));
      }, REQUEST_TIMEOUT_MS);
      Promise.resolve(thenable).then(
        function (value) { if (!settled) { settled = true; window.clearTimeout(timer); resolve(value); } },
        function (err) { if (!settled) { settled = true; window.clearTimeout(timer); reject(err); } }
      );
    });
  }

  function unwrap(res) {
    if (res && res.error) throw new Error(friendlyError(res.error));
    return res ? res.data : null;
  }

  var Donations = {
    list: function () {
      return withTimeout(
        db.from(DONATIONS_TABLE)
          .select("id,name,amount,created_at")
          .order("created_at", { ascending: false })
          .limit(20000),
        "Loading donations"
      ).then(unwrap);
    },
    insert: function (name, amount) {
      return withTimeout(
        db.from(DONATIONS_TABLE)
          .insert({ name: name, amount: amount })
          .select("id,name,amount,created_at")
          .single(),
        "Saving the donation"
      ).then(unwrap);
    },
    insertMany: function (rows) {
      return withTimeout(
        db.from(DONATIONS_TABLE).insert(rows).select("id"),
        "Saving the donations"
      ).then(unwrap);
    },
    remove: function (id) {
      return withTimeout(
        db.from(DONATIONS_TABLE).delete().eq("id", id).select("id"),
        "Removing the donation"
      ).then(unwrap);
    },
    removeAll: function () {
      return withTimeout(
        db.from(DONATIONS_TABLE).delete().gte("created_at", "1970-01-01").select("id"),
        "Clearing the donations"
      ).then(unwrap);
    }
  };

  function mapRow(row) {
    var at = Date.parse(row.created_at);
    return {
      id: String(row.id),
      name: row.name || "Anonymous",
      amount: toNumber(row.amount, 0),
      at: isFinite(at) ? at : Date.now()
    };
  }

  /* ---------- 2b. Storage layer: device-local settings ---------- */
  /* Campaign name, target, description, milestones, celebration log
     and the cash adjustment. These are per-device by design — see the
     README for the table you would add to sync them too.           */
  var settingsFallback = null;

  var SettingsStore = {
    read: function () {
      try {
        var raw = window.localStorage.getItem(SETTINGS_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (e) {
        return settingsFallback;
      }
    },
    write: function (data) {
      settingsFallback = data;
      try {
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
        return true;
      } catch (e) {
        return false;
      }
    }
  };

  /* ---------- 3. Defaults and state ---------- */
  function defaultState() {
    return {
      campaign: {
        name: "Nimra Education",
        description: "Rs. 92,400 keeps one child in school for a full year — books, uniform, fees and a safe classroom.",
        target: 92400,
        adjustment: 0
      },
      milestones: [
        { id: "q1", label: "Quarter 1", amount: 23100, message: "We've successfully covered 3 months of a child's education." },
        { id: "q2", label: "Quarter 2", amount: 46200, message: "We've successfully covered 6 months of a child's education." },
        { id: "q3", label: "Quarter 3", amount: 69300, message: "We've successfully covered 9 months of a child's education." },
        { id: "q4", label: "Quarter 4", amount: 92400, message: "We've covered a full year of a child's education. The target is complete." }
      ],
      donations: [],
      celebrated: []
    };
  }

  // Used only by the "Load sample donations" button — never inserted automatically.
  var SAMPLE_DONATIONS = [
    { name: "Anonymous", amount: 3000 },
    { name: "Ahmed", amount: 1000 },
    { name: "Sara", amount: 2500 },
    { name: "Ali", amount: 5000 }
  ];

  var state = defaultState();
  var displayed = { total: 0, remaining: 0, pct: 0, count: 0 };
  var celebrationQueue = [];
  var celebrationOpen = false;
  var lastFocused = null;

  var adminUser = null;   // set when an admin is signed in via Supabase Auth
  var knownIds = Object.create(null);
  var firstLoadDone = false;
  var refreshSeq = 0;
  var refreshPending = false;
  var emptyText = "";

  function loadSettings() {
    var base = defaultState();
    var saved = SettingsStore.read();
    if (saved && typeof saved === "object") {
      state.campaign = Object.assign({}, base.campaign, saved.campaign || {});
      state.milestones = Array.isArray(saved.milestones) && saved.milestones.length ? saved.milestones : base.milestones;
      state.celebrated = Array.isArray(saved.celebrated) ? saved.celebrated : [];
    } else {
      state.campaign = base.campaign;
      state.milestones = base.milestones;
      state.celebrated = [];
    }
    state.campaign.target = toNumber(state.campaign.target, base.campaign.target);
    state.campaign.adjustment = toNumber(state.campaign.adjustment, 0);
    state.donations = []; // donations always come from Supabase
  }

  function persistSettings() {
    return SettingsStore.write({
      campaign: state.campaign,
      milestones: state.milestones,
      celebrated: state.celebrated
    });
  }

  /* ---------- 4. Calculations ---------- */
  function toNumber(v, fallback) {
    var n = typeof v === "number" ? v : parseFloat(v);
    return isFinite(n) ? n : (fallback || 0);
  }

  function getDonations() {
    return state.donations.slice().sort(function (a, b) { return b.at - a.at; });
  }

  function donationsTotal() {
    return state.donations.reduce(function (sum, d) { return sum + toNumber(d.amount, 0); }, 0);
  }

  function calculateProgress() {
    var target = Math.max(1, toNumber(state.campaign.target, 1));
    var total = Math.max(0, donationsTotal() + toNumber(state.campaign.adjustment, 0));
    var pct = (total / target) * 100;
    return {
      total: total,
      target: target,
      remaining: Math.max(0, target - total),
      pct: pct,
      pctClamped: Math.max(0, Math.min(100, pct)),
      count: state.donations.length,
      complete: total >= target
    };
  }

  function formatRs(n) {
    return "Rs. " + Math.round(n).toLocaleString("en-US");
  }

  function relativeTime(ts) {
    var s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 45) return "Just now";
    var m = Math.floor(s / 60);
    if (m < 1) return "Just now";
    if (m === 1) return "1 min ago";
    if (m < 60) return m + " mins ago";
    var h = Math.floor(m / 60);
    if (h === 1) return "1 hour ago";
    if (h < 24) return h + " hours ago";
    var d = Math.floor(h / 24);
    return d === 1 ? "1 day ago" : d + " days ago";
  }

  /* ---------- 5. Rendering ---------- */
  var $ = function (id) { return document.getElementById(id); };

  function prefersReducedMotion() {
    try {
      return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (e) {
      return false;
    }
  }

  function animateNumber(el, from, to, render, duration) {
    if (!el) return;
    if (prefersReducedMotion() || from === to) { el.textContent = render(to); return; }
    var start = performance.now();
    var dur = duration || 800;
    function step(now) {
      var t = Math.min(1, (now - start) / dur);
      var eased = 1 - Math.pow(1 - t, 3);
      el.textContent = render(from + (to - from) * eased);
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function setJarLevel(pctClamped) {
    var liquid = $("liquid");
    if (!liquid) return;
    var topY = 96;      // full
    var bottomY = 330;  // empty
    var y = bottomY - (bottomY - topY) * (pctClamped / 100);
    liquid.style.transform = "translateY(" + y.toFixed(1) + "px)";
  }

  function renderHeader() {
    $("campaignName").textContent = state.campaign.name;
    $("campaignDesc").textContent = state.campaign.description || "";
    $("targetChip").textContent = formatRs(state.campaign.target);
    document.title = state.campaign.name + " — Islamic Relief Pakistan";
  }

  function renderDonations() {
    var list = $("donationList");
    var donations = getDonations();
    list.innerHTML = "";
    $("donationEmpty").textContent = emptyText;
    $("donationEmpty").hidden = donations.length > 0;

    donations.forEach(function (d) {
      var li = document.createElement("li");
      li.dataset.id = d.id;

      var who = document.createElement("span");
      who.className = "who";
      who.textContent = d.name || "Anonymous";

      var amt = document.createElement("span");
      amt.className = "amt num";
      amt.textContent = formatRs(d.amount);

      var when = document.createElement("span");
      when.className = "when";
      when.dataset.at = d.at;
      when.textContent = relativeTime(d.at);

      var del = document.createElement("button");
      del.className = "del admin-only";
      del.type = "button";
      del.textContent = "Remove";
      del.setAttribute("aria-label", "Remove donation from " + (d.name || "Anonymous") + " of " + formatRs(d.amount));
      del.addEventListener("click", function () { removeDonation(d.id); });

      li.appendChild(who);
      li.appendChild(amt);
      li.appendChild(when);
      li.appendChild(del);
      list.appendChild(li);
    });
  }

  // Walks the donations oldest-first and keeps whatever lands beyond the
  // campaign target. The donation that crosses the line is split, so only
  // the part above the target counts as extra.
  function getExtraDonations() {
    var target = Math.max(1, toNumber(state.campaign.target, 1));
    var running = toNumber(state.campaign.adjustment, 0);
    var extras = [];

    state.donations.slice()
      .sort(function (a, b) { return a.at - b.at; })
      .forEach(function (d) {
        var amount = toNumber(d.amount, 0);
        var before = running;
        running += amount;
        if (running <= target) return;
        var portion = before >= target ? amount : running - target;
        if (portion <= 0) return;
        extras.push({
          id: d.id,
          name: d.name,
          at: d.at,
          full: amount,
          amount: portion,
          partial: portion < amount
        });
      });

    return extras.sort(function (a, b) { return b.at - a.at; });
  }

  function renderExtra(p) {
    var list = $("extraList");
    if (!list) return;

    var extras = getExtraDonations();
    var extraTotal = Math.max(0, p.total - p.target);

    $("extraAmount").textContent = formatRs(extraTotal);
    $("extraCount").textContent = String(extras.length);
    $("extraPct").textContent = Math.round((extraTotal / p.target) * 100) + "%";

    $("extraEmpty").textContent = p.complete
      ? "The target has just been met — anything from here counts as extra."
      : formatRs(p.remaining) + " still to go before extra money starts.";
    $("extraEmpty").hidden = extras.length > 0;

    list.innerHTML = "";
    extras.forEach(function (d) {
      var li = document.createElement("li");

      var who = document.createElement("span");
      who.className = "who";
      who.textContent = d.name || "Anonymous";

      var amt = document.createElement("span");
      amt.className = "amt num";
      amt.textContent = formatRs(d.amount);

      var when = document.createElement("span");
      when.className = "when";
      when.dataset.at = d.at;
      when.dataset.suffix = d.partial ? " · part of " + formatRs(d.full) : "";
      when.textContent = relativeTime(d.at) + when.dataset.suffix;

      li.appendChild(who);
      li.appendChild(amt);
      li.appendChild(when);
      list.appendChild(li);
    });
  }

  function refreshRelativeTimes() {
    Array.prototype.forEach.call(document.querySelectorAll(".donations .when"), function (el) {
      el.textContent = relativeTime(Number(el.dataset.at)) + (el.dataset.suffix || "");
    });
  }

  function renderMilestones(p) {
    var list = $("milestoneList");
    list.innerHTML = "";
    var sorted = state.milestones.slice().sort(function (a, b) { return a.amount - b.amount; });
    sorted.forEach(function (m) {
      var done = p.total >= m.amount;
      var li = document.createElement("li");
      li.className = done ? "done" : "";

      var badge = document.createElement("span");
      badge.className = "badge";
      badge.setAttribute("aria-hidden", "true");
      badge.textContent = done ? "✓" : "🔒";

      var text = document.createElement("span");
      var title = document.createElement("span");
      title.className = "m-title";
      title.textContent = m.label + (done ? " — complete" : " — remaining");
      var sub = document.createElement("span");
      sub.className = "m-sub";
      sub.style.display = "block";
      sub.textContent = done ? m.message : formatRs(Math.max(0, m.amount - p.total)) + " to go";
      text.appendChild(title);
      text.appendChild(sub);

      var amt = document.createElement("span");
      amt.className = "m-amt num";
      amt.textContent = formatRs(m.amount);

      li.appendChild(badge);
      li.appendChild(text);
      li.appendChild(amt);
      list.appendChild(li);
    });
  }

  function updateDashboard(options) {
    var p = calculateProgress();
    var animate = !options || options.animate !== false;

    animateNumber($("totalRaised"), animate ? displayed.total : p.total, p.total, formatRs);
    animateNumber($("remainingValue"), animate ? displayed.remaining : p.remaining, p.remaining, formatRs);
    animateNumber($("sTotal"), animate ? displayed.total : p.total, p.total, formatRs);
    animateNumber($("sRemaining"), animate ? displayed.remaining : p.remaining, p.remaining, formatRs);
    animateNumber($("donationCount"), animate ? displayed.count : p.count, p.count, function (n) { return Math.round(n).toString(); });
    animateNumber($("sDonors"), animate ? displayed.count : p.count, p.count, function (n) { return Math.round(n).toString(); });

    var pctText = function (n) { return (Math.round(n * 10) / 10).toFixed(n >= 99.95 ? 0 : 1).replace(/\.0$/, "") + "%"; };
    animateNumber($("pctLabel"), animate ? displayed.pct : p.pct, p.pct, pctText);
    animateNumber($("jarPct"), animate ? displayed.pct : p.pct, p.pct, pctText);
    animateNumber($("sPct"), animate ? displayed.pct : p.pct, p.pct, pctText);

    $("targetValue").textContent = formatRs(p.target);
    $("sTarget").textContent = formatRs(p.target);
    $("ofTarget").textContent = "of " + formatRs(p.target);
    $("barFill").style.width = p.pctClamped + "%";
    $("progressBar").setAttribute("aria-valuenow", Math.round(p.pctClamped));
    $("progressBar").setAttribute("aria-valuetext", formatRs(p.total) + " of " + formatRs(p.target) + ", " + Math.round(p.pctClamped) + " percent");
    $("barCaption").textContent = p.complete ? "target reached — thank you" : "complete · " + formatRs(p.remaining) + " still needed";

    $("tick25").textContent = formatRs(p.target * 0.25);
    $("tick50").textContent = formatRs(p.target * 0.5);
    $("tick75").textContent = formatRs(p.target * 0.75);
    $("tick100").textContent = formatRs(p.target);

    setJarLevel(p.pctClamped);
    $("jarNote").textContent = p.complete
      ? "The jar is full. The campaign target has been reached."
      : "The jar fills as the stall collects donations.";

    var done = state.milestones.filter(function (m) { return p.total >= m.amount; }).length;
    $("sMilestones").textContent = done + " of " + state.milestones.length;

    renderMilestones(p);
    renderExtra(p);

    displayed = { total: p.total, remaining: p.remaining, pct: p.pct, count: p.count };
    return p;
  }

  /* ---------- 6. Notifications ---------- */
  var MESSAGES = [
    "{name} just donated {amount}!",
    "💚 A new contribution just came in — {amount} from {name}.",
    "🤲 {name} just helped move us closer to our goal.",
    "✨ Another step towards changing a life — {amount} from {name}."
  ];
  var THANKS = [
    "Thank you for making a difference!",
    "Thank you for helping change a life. 💚",
    "Every rupee keeps a child in the classroom.",
    "May this bring barakah to your day."
  ];

  function showToast(headline, body, isWarning) {
    var toast = document.createElement("div");
    toast.className = isWarning ? "toast warn" : "toast";
    var b = document.createElement("b");
    b.textContent = headline;
    var s = document.createElement("span");
    s.textContent = body || "";
    toast.appendChild(b);
    toast.appendChild(s);
    $("toasts").appendChild(toast);

    window.setTimeout(function () {
      toast.classList.add("out");
      window.setTimeout(function () { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 400);
    }, isWarning ? 6500 : 4200);
  }

  function showDonationNotification(donation) {
    var name = donation.name || "Anonymous";
    var template = MESSAGES[Math.floor(Math.random() * MESSAGES.length)];
    var headline = template.replace("{name}", name).replace("{amount}", formatRs(donation.amount));
    if (template === MESSAGES[0]) headline = "🎉 " + headline;
    showToast(headline, THANKS[Math.floor(Math.random() * THANKS.length)]);
  }

  /* ---------- 7. Milestones and celebration ---------- */
  function checkMilestones(previousTotal, newTotal) {
    var crossed = state.milestones
      .filter(function (m) { return newTotal >= m.amount && previousTotal < m.amount; })
      .filter(function (m) { return state.celebrated.indexOf(m.id) === -1; })
      .sort(function (a, b) { return a.amount - b.amount; });

    var target = calculateProgress().target;
    var hitsTarget = crossed.some(function (m) { return m.amount >= target; });
    if (previousTotal < target && newTotal >= target && !hitsTarget && state.celebrated.indexOf("__target__") === -1) {
      crossed.push({
        id: "__target__",
        label: "Campaign target",
        amount: target,
        message: "We've reached the full campaign target of " + formatRs(target) + "."
      });
    }

    if (!crossed.length) return;
    crossed.forEach(function (m) { state.celebrated.push(m.id); });
    persistSettings();
    celebrationQueue = celebrationQueue.concat(crossed);
    if (!celebrationOpen) showMilestoneCelebration();
  }

  function showMilestoneCelebration() {
    var m = celebrationQueue.shift();
    if (!m) return;
    celebrationOpen = true;
    lastFocused = document.activeElement;

    var p = calculateProgress();
    var final = m.amount >= p.target;
    $("celebrateTitle").textContent = final ? "🎉 Target reached!" : "🎉 Congratulations!";
    $("celebrateMsg").textContent = m.message;
    $("celebrateSub").textContent = final
      ? "The full campaign target is covered. Thank you to every donor at the stall. 💚"
      : "Thank you for helping us make a difference. 💚";
    $("celebrateClose").textContent = final ? "Wonderful" : "Keep going";
    $("celebrateBackdrop").hidden = false;
    $("celebrateClose").focus();
    launchConfetti();
  }

  function closeCelebration() {
    $("celebrateBackdrop").hidden = true;
    celebrationOpen = false;
    if (lastFocused && lastFocused.focus) lastFocused.focus();
    if (celebrationQueue.length) window.setTimeout(showMilestoneCelebration, 450);
  }

  /* ---------- 8. Confetti ---------- */
  var canvas = $("confetti");
  var ctx = null;
  try { ctx = canvas.getContext("2d"); } catch (e) { ctx = null; }
  var pieces = [];
  var confettiRunning = false;

  function sizeCanvas() {
    if (!ctx) return;
    var dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = window.innerWidth + "px";
    canvas.style.height = window.innerHeight + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function launchConfetti() {
    if (prefersReducedMotion() || !ctx) return;
    sizeCanvas();
    var colors = ["#0778D4", "#0A4D8C", "#3AA5E6", "#00A651", "#7FE0AA"];
    var w = window.innerWidth;
    for (var i = 0; i < 90; i++) {
      pieces.push({
        x: w * 0.5 + (Math.random() - 0.5) * w * 0.7,
        y: -20 - Math.random() * 120,
        vx: (Math.random() - 0.5) * 2.4,
        vy: 2 + Math.random() * 3.2,
        size: 5 + Math.random() * 6,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.24,
        color: colors[Math.floor(Math.random() * colors.length)],
        life: 0
      });
    }
    if (!confettiRunning) { confettiRunning = true; requestAnimationFrame(drawConfetti); }
  }

  function drawConfetti() {
    if (!ctx) { pieces = []; confettiRunning = false; return; }
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    pieces = pieces.filter(function (p) { return p.life < 260 && p.y < window.innerHeight + 40; });
    pieces.forEach(function (p) {
      p.life++;
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.035;
      p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.globalAlpha = Math.max(0, 1 - p.life / 260);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.62);
      ctx.restore();
    });
    if (pieces.length) {
      requestAnimationFrame(drawConfetti);
    } else {
      confettiRunning = false;
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    }
  }

  /* ---------- 9. Syncing with Supabase ---------- */
  function cssQuote(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function signature(rows) {
    return rows.length + "|" + rows.map(function (d) { return d.id + ":" + d.amount; }).join(",");
  }
  var lastSignature = null;

  // Replaces local state wholesale with what Supabase returned.
  // Because the list is always re-read, a donation can never be counted twice.
  function applyDonations(rows, options) {
    var opts = options || {};
    var sig = signature(rows);
    if (lastSignature !== null && sig === lastSignature) return; // nothing changed
    lastSignature = sig;

    var before = calculateProgress().total;

    state.donations = rows;

    var fresh = rows.filter(function (d) { return !knownIds[d.id]; });
    rows.forEach(function (d) { knownIds[d.id] = true; });

    renderDonations();
    var after = updateDashboard({ animate: opts.animate !== false }).total;

    if (firstLoadDone && !opts.silent && fresh.length) {
      fresh.sort(function (a, b) { return a.at - b.at; });
      fresh.forEach(function (d) {
        showDonationNotification(d);
        var row = document.querySelector('.donations li[data-id="' + cssQuote(d.id) + '"]');
        if (row) row.classList.add("new-row");
      });
      checkMilestones(before, after);
    }

    applyStallMode();
  }

  function refreshFromSupabase(options) {
    if (!db) return Promise.reject(new Error(CONFIG_MESSAGE));
    var seq = ++refreshSeq;
    refreshPending = true;
    return Donations.list().then(function (rows) {
      refreshPending = false;
      if (seq !== refreshSeq) return false; // a newer refresh has already landed
      applyDonations((rows || []).map(mapRow), options);
      return true;
    }, function (err) {
      refreshPending = false;
      throw err;
    });
  }

  var refreshTimer = null;
  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = window.setTimeout(function () {
      refreshTimer = null;
      refreshFromSupabase().catch(function () { /* a later poll will retry */ });
    }, 350);
  }

  function subscribeRealtime() {
    if (!db || realtimeChannel) return;
    try {
      realtimeChannel = db
        .channel("irp-donations")
        .on("postgres_changes", { event: "*", schema: "public", table: DONATIONS_TABLE }, scheduleRefresh)
        .subscribe(function (status) {
          realtimeOk = status === "SUBSCRIBED";
        });
    } catch (e) {
      realtimeOk = false;
    }
  }

  // Safety net so devices stay in sync even if Realtime is not enabled:
  // every 15s normally, every 45s once Realtime is confirmed live.
  var pollTick = 0;
  function startPolling() {
    window.setInterval(function () {
      if (!db || refreshPending || document.hidden) return;
      pollTick++;
      if (realtimeOk && pollTick % 3 !== 0) return;
      refreshFromSupabase().catch(function () {});
    }, 15000);
  }

  /* ---------- 10. Actions ---------- */
  function addDonation(name, amount) {
    var value = toNumber(amount, NaN);
    if (!isFinite(value) || value <= 0) {
      return Promise.resolve({ ok: false, error: "Enter a donation amount greater than zero." });
    }
    if (value > 100000000) {
      return Promise.resolve({ ok: false, error: "That amount looks too large. Check the figure and try again." });
    }
    if (!db) {
      return Promise.resolve({ ok: false, error: CONFIG_MESSAGE, backend: true });
    }

    var donorName = (name || "").trim() || "Anonymous";
    var donorAmount = Math.round(value);

    // Insert first, confirm, then re-read. The UI is never updated optimistically.
    return Donations.insert(donorName, donorAmount)
      .then(function () { return refreshFromSupabase(); })
      .then(function () { return { ok: true }; })
      .catch(function (err) {
        return { ok: false, error: err.message || "The donation could not be saved.", backend: true };
      });
  }

  function removeDonation(id) {
    if (!db) { showToast("Not connected", CONFIG_MESSAGE, true); return; }
    Donations.remove(id)
      .then(function (rows) {
        if (!rows || !rows.length) throw new Error(ADMIN_MESSAGE);
        return refreshFromSupabase({ silent: true });
      })
      .catch(function (err) {
        showToast("Donation not removed", err.message, true);
      });
  }

  function resetCampaign() {
    function finish() {
      state.campaign.adjustment = 0;
      state.celebrated = [];
      persistSettings();
      return refreshFromSupabase({ silent: true, animate: false }).then(function () {
        showToast("Campaign data reset", "All donation records were cleared from Supabase.");
      });
    }

    if (!db) { showToast("Not connected", CONFIG_MESSAGE, true); return; }

    Donations.removeAll()
      .then(function (rows) {
        if (rows && rows.length) return finish();
        // Nothing deleted: either the table was already empty, or RLS blocked it.
        return Donations.list().then(function (remaining) {
          if (remaining && remaining.length) throw new Error(ADMIN_MESSAGE);
          return finish();
        });
      })
      .catch(function (err) {
        showToast("Data not reset", err.message, true);
      });
  }

  function loadSampleDonations() {
    if (!db) { showToast("Not connected", CONFIG_MESSAGE, true); return; }
    var btn = $("sampleBtn");
    btn.disabled = true;
    Donations.insertMany(SAMPLE_DONATIONS.map(function (d) { return { name: d.name, amount: d.amount }; }))
      .then(function () { return refreshFromSupabase({ silent: true }); })
      .then(function () {
        showToast("Sample donations added", "Four example records were written to Supabase. Use Reset campaign data to clear them.");
      })
      .catch(function (err) {
        showToast("Samples not added", err.message, true);
      })
      .then(function () { btn.disabled = false; });
  }

  /* ---------- 11. Settings (device-local) ---------- */
  function renderSettingsForm() {
    $("setName").value = state.campaign.name;
    $("setTarget").value = state.campaign.target;
    $("setDesc").value = state.campaign.description || "";
    $("setCurrent").value = Math.round(calculateProgress().total);
    $("setSplit").value = "keep";

    var box = $("msEditor");
    box.innerHTML = "";
    state.milestones.forEach(function (m, i) {
      var row = document.createElement("div");
      row.className = "ms-edit";

      var amtId = "msAmt" + i, msgId = "msMsg" + i;

      var amtWrap = document.createElement("div");
      var amtLabel = document.createElement("label");
      amtLabel.setAttribute("for", amtId);
      amtLabel.style.fontSize = ".8rem";
      amtLabel.textContent = m.label + " (Rs.)";
      var amtInput = document.createElement("input");
      amtInput.id = amtId; amtInput.type = "number"; amtInput.min = "1"; amtInput.value = m.amount;
      amtInput.dataset.index = i; amtInput.dataset.field = "amount";
      amtWrap.appendChild(amtLabel); amtWrap.appendChild(amtInput);

      var msgWrap = document.createElement("div");
      var msgLabel = document.createElement("label");
      msgLabel.setAttribute("for", msgId);
      msgLabel.style.fontSize = ".8rem";
      msgLabel.textContent = "Celebration message";
      var msgInput = document.createElement("input");
      msgInput.id = msgId; msgInput.type = "text"; msgInput.maxLength = 160; msgInput.value = m.message;
      msgInput.dataset.index = i; msgInput.dataset.field = "message";
      msgWrap.appendChild(msgLabel); msgWrap.appendChild(msgInput);

      row.appendChild(amtWrap);
      row.appendChild(msgWrap);
      box.appendChild(row);
    });
  }

  function saveCampaignSettings() {
    var target = toNumber($("setTarget").value, state.campaign.target);
    if (target <= 0) target = state.campaign.target;

    state.campaign.name = ($("setName").value || "").trim() || state.campaign.name;
    state.campaign.description = ($("setDesc").value || "").trim();
    state.campaign.target = Math.round(target);

    Array.prototype.forEach.call($("msEditor").querySelectorAll("input"), function (input) {
      var i = Number(input.dataset.index);
      if (!state.milestones[i]) return;
      if (input.dataset.field === "amount") {
        state.milestones[i].amount = Math.round(toNumber(input.value, state.milestones[i].amount));
      } else {
        state.milestones[i].message = input.value.trim() || state.milestones[i].message;
      }
    });

    if ($("setSplit").value === "quarters") {
      state.milestones.forEach(function (m, i) {
        m.amount = Math.round((state.campaign.target / state.milestones.length) * (i + 1));
      });
    }

    var wanted = toNumber($("setCurrent").value, calculateProgress().total);
    state.campaign.adjustment = Math.round(wanted - donationsTotal());

    var afterEdit = calculateProgress();
    state.celebrated = state.milestones
      .filter(function (m) { return afterEdit.total >= m.amount; })
      .map(function (m) { return m.id; });
    if (afterEdit.complete) state.celebrated.push("__target__");

    persistSettings();
    renderHeader();
    renderSettingsForm();
    updateDashboard();

    var flash = $("savedFlash");
    flash.classList.add("on");
    window.setTimeout(function () { flash.classList.remove("on"); }, 2200);
  }

  /* ---------- 12. Stall mode ---------- */
  function applyStallMode() {
    var stall = document.body.classList.contains("stall");
    var hideAdmin = stall || !adminUser;   // admin tools need a signed-in admin

    Array.prototype.forEach.call(document.querySelectorAll(".admin-only"), function (el) {
      if (hideAdmin) {
        el.setAttribute("hidden", "hidden");
      } else if (el.id !== "settings" || $("settingsBtn").getAttribute("aria-expanded") === "true") {
        el.removeAttribute("hidden");
      }
    });
    if (!hideAdmin && $("settingsBtn").getAttribute("aria-expanded") !== "true") {
      $("settings").setAttribute("hidden", "hidden");
    }

    var authBtn = $("authBtn");
    authBtn.hidden = stall;
    if (adminUser) {
      authBtn.textContent = "Sign out";
      authBtn.title = "Signed in as " + (adminUser.email || "admin");
    } else {
      authBtn.textContent = "Admin sign in";
      authBtn.removeAttribute("title");
    }

    $("stallBtn").textContent = stall ? "Exit stall mode" : "Enter stall mode";
  }

  function toggleStallMode() {
    document.body.classList.toggle("stall");
    applyStallMode();
    if (document.body.classList.contains("stall")) {
      try { if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen(); } catch (e) {}
    } else {
      try { if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen(); } catch (e) {}
    }
  }

  /* ---------- 12b. Light and dark theme ----------
     The choice is remembered on this device only. With no saved
     choice the dashboard follows the device's own appearance.
     ------------------------------------------------------------ */
  var THEME_KEY = "irp.theme";

  function storedTheme() {
    try {
      var t = window.localStorage.getItem(THEME_KEY);
      return (t === "dark" || t === "light") ? t : null;
    } catch (e) {
      return null;
    }
  }

  function systemPrefersDark() {
    try {
      return typeof window.matchMedia === "function" &&
             window.matchMedia("(prefers-color-scheme: dark)").matches;
    } catch (e) {
      return false;
    }
  }

  function activeTheme() {
    return storedTheme() || (systemPrefersDark() ? "dark" : "light");
  }

  function applyTheme(theme) {
    var dark = theme === "dark";
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");

    var btn = $("themeBtn");
    if (!btn) return;
    btn.setAttribute("aria-pressed", dark ? "true" : "false");
    btn.title = dark ? "Switch to light mode" : "Switch to dark mode";
    $("themeIcon").textContent = dark ? "☀️" : "🌙";
    $("themeLabel").textContent = dark ? "Light mode" : "Dark mode";
  }

  function toggleTheme() {
    var next = activeTheme() === "dark" ? "light" : "dark";
    try { window.localStorage.setItem(THEME_KEY, next); } catch (e) {}
    applyTheme(next);
  }

  function watchSystemTheme() {
    if (typeof window.matchMedia !== "function") return;
    var mq = window.matchMedia("(prefers-color-scheme: dark)");
    var onChange = function () {
      if (!storedTheme()) applyTheme(systemPrefersDark() ? "dark" : "light");
    };
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  /* ---------- 13. Events ---------- */
  function submitDonation() {
    var nameEl = $("donorName");
    var amtEl = $("donorAmount");
    var err = $("amountError");
    var btn = $("addBtn");
    if (btn.disabled) return;

    var label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Saving…";

    addDonation(nameEl.value, amtEl.value).then(function (result) {
      btn.disabled = false;
      btn.textContent = label;

      if (!result.ok) {
        err.textContent = result.error;
        amtEl.setAttribute("aria-invalid", "true");
        if (result.backend) showToast("Donation not saved", result.error, true);
        amtEl.focus();
        return;
      }
      err.textContent = "";
      amtEl.removeAttribute("aria-invalid");
      nameEl.value = "";
      amtEl.value = "";
      nameEl.focus();
    });
  }

  function bind() {
    $("addBtn").addEventListener("click", submitDonation);
    ["donorName", "donorAmount"].forEach(function (id) {
      $(id).addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); submitDonation(); }
      });
    });
    $("donorAmount").addEventListener("input", function () {
      $("amountError").textContent = "";
      this.removeAttribute("aria-invalid");
    });
    Array.prototype.forEach.call(document.querySelectorAll(".quick button"), function (b) {
      b.addEventListener("click", function () {
        $("donorAmount").value = b.dataset.amt;
        $("donorAmount").focus();
      });
    });

    $("stallBtn").addEventListener("click", toggleStallMode);
    $("themeBtn").addEventListener("click", toggleTheme);

    $("settingsBtn").addEventListener("click", function () {
      var open = this.getAttribute("aria-expanded") === "true";
      this.setAttribute("aria-expanded", String(!open));
      $("settings").hidden = open;
      if (!open) {
        renderSettingsForm();
        if ($("settings").scrollIntoView) $("settings").scrollIntoView({ behavior: "smooth", block: "start" });
        $("setName").focus();
      }
    });

    $("saveSettings").addEventListener("click", saveCampaignSettings);
    $("sampleBtn").addEventListener("click", loadSampleDonations);

    $("resetBtn").addEventListener("click", function () {
      lastFocused = document.activeElement;
      $("confirmBackdrop").hidden = false;
      $("confirmCancel").focus();
    });
    $("confirmCancel").addEventListener("click", closeConfirm);
    $("confirmOk").addEventListener("click", function () {
      resetCampaign();
      closeConfirm();
      renderSettingsForm();
    });
    function closeConfirm() {
      $("confirmBackdrop").hidden = true;
      if (lastFocused && lastFocused.focus) lastFocused.focus();
    }

    $("authBtn").addEventListener("click", function () {
      if (adminUser) signOut(); else openAuthDialog();
    });
    $("authSubmit").addEventListener("click", submitSignIn);
    $("authCancel").addEventListener("click", closeAuthDialog);
    ["authEmail", "authPassword"].forEach(function (id) {
      $(id).addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); submitSignIn(); }
      });
    });

    $("celebrateClose").addEventListener("click", closeCelebration);

    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      if (!$("celebrateBackdrop").hidden) { closeCelebration(); return; }
      if (!$("confirmBackdrop").hidden) { closeConfirm(); return; }
      if (!$("authBackdrop").hidden) { closeAuthDialog(); return; }
      if (document.body.classList.contains("stall")) toggleStallMode();
    });

    // Keep focus inside an open dialog.
    document.addEventListener("focusin", function (e) {
      var open = !$("celebrateBackdrop").hidden ? $("celebrateModal")
               : (!$("confirmBackdrop").hidden ? $("confirmBackdrop").firstElementChild
               : (!$("authBackdrop").hidden ? $("authModal") : null));
      if (open && !open.contains(e.target)) {
        var f = open.querySelector("button");
        if (f) f.focus();
      }
    });

    window.addEventListener("resize", function () { if (confettiRunning) sizeCanvas(); });
    window.setInterval(refreshRelativeTimes, 30000);
  }

  /* ---------- 14. Admin sign-in ----------
     Adding and removing donations is restricted to a signed-in admin,
     enforced by Row Level Security in Supabase. The buttons below only
     control what the page shows; the database is the real gate.
     --------------------------------------------------------------- */
  function setAdminUser(user) {
    adminUser = user || null;
    if (firstLoadDone) renderDonations();   // redraw so Remove buttons appear/disappear
    applyStallMode();
  }

  function openAuthDialog() {
    lastFocused = document.activeElement;
    $("authError").textContent = "";
    $("authPassword").value = "";
    $("authBackdrop").hidden = false;
    $("authEmail").focus();
  }

  function closeAuthDialog() {
    $("authBackdrop").hidden = true;
    $("authPassword").value = "";
    if (lastFocused && lastFocused.focus) lastFocused.focus();
  }

  function signIn(email, password) {
    if (!db) return Promise.reject(new Error(CONFIG_MESSAGE));
    if (!email || !password) return Promise.reject(new Error("Enter both an email and a password."));
    return withTimeout(db.auth.signInWithPassword({ email: email, password: password }), "Signing in")
      .then(function (res) {
        if (res.error) throw new Error(friendlyError(res.error));
        return res.data.user;
      });
  }

  function submitSignIn() {
    var btn = $("authSubmit");
    if (btn.disabled) return;
    var label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Signing in…";
    $("authError").textContent = "";

    signIn(($("authEmail").value || "").trim(), $("authPassword").value)
      .then(function (user) {
        btn.disabled = false;
        btn.textContent = label;
        closeAuthDialog();
        setAdminUser(user);
        showToast("Signed in", "You can now add and remove donations.");
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.textContent = label;
        $("authError").textContent = err.message;
        $("authPassword").focus();
      });
  }

  function signOut() {
    if (!db) return;
    db.auth.signOut().then(function () {
      setAdminUser(null);
      showToast("Signed out", "The dashboard is now in view-only mode.");
    });
  }

  function restoreSession() {
    if (!db) return Promise.resolve(null);
    return db.auth.getSession().then(function (res) {
      var user = res && res.data && res.data.session ? res.data.session.user : null;
      setAdminUser(user);
      return user;
    }, function () { return null; });
  }

  /* ---------- 15. Boot ---------- */
  function init() {
    // The old localStorage donation store is retired — clear it so there is
    // never a second copy of the data alongside Supabase.
    try { window.localStorage.removeItem(LEGACY_DONATIONS_KEY); } catch (e) {}

    applyTheme(activeTheme());
    watchSystemTheme();

    emptyText = $("donationEmpty").textContent;
    loadSettings();

    renderHeader();
    renderSettingsForm();
    updateDashboard({ animate: false });
    displayed = { total: 0, remaining: calculateProgress().target, pct: 0, count: 0 };
    bind();
    applyStallMode();

    db = createClient();

    if (!db) {
      $("donationEmpty").hidden = false;
      showToast("Supabase is not connected", CONFIG_MESSAGE, true);
      return;
    }

    restoreSession();

    $("donationEmpty").textContent = "Loading donations…";
    $("donationEmpty").hidden = false;

    refreshFromSupabase({ silent: true, animate: false })
      .then(function () {
        // Anything already achieved on load counts as celebrated, so a
        // refresh — or a second device joining — stays quiet.
        var p = calculateProgress();
        state.milestones.forEach(function (m) {
          if (p.total >= m.amount && state.celebrated.indexOf(m.id) === -1) state.celebrated.push(m.id);
        });
        if (p.complete && state.celebrated.indexOf("__target__") === -1) state.celebrated.push("__target__");
        persistSettings();

        firstLoadDone = true;
        // Animate the opening figures once, from zero.
        window.setTimeout(function () { updateDashboard(); }, 120);

        subscribeRealtime();
        startPolling();
      })
      .catch(function (err) {
        firstLoadDone = true;
        $("donationEmpty").textContent = emptyText;
        $("donationEmpty").hidden = false;
        showToast("Could not load donations", err.message, true);
        startPolling();
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
