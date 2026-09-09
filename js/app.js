(function () {
  'use strict';

  var cfg = window.RECOMWORKS_CONFIG || {};
  var sb = null;
  if (window.supabase && cfg.SUPABASE_URL && cfg.SUPABASE_URL.indexOf('YOUR_') !== 0) {
    sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  }

  // ── tiny helpers ──────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  function show(el) { el.hidden = false; }
  function hide(el) { el.hidden = true; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(msg, isError) {
    var t = document.createElement('div');
    t.className = 'toast' + (isError ? ' error' : '');
    t.textContent = msg;
    $('toast-container').appendChild(t);
    setTimeout(function () { t.remove(); }, 3800);
  }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function fmtDate(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function fmtTime(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function friendlyDate(d) {
    return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }
  function shortDate(d) {
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }

  // ── structured address helpers (shared by customers / engineers / job site) ──
  // `cols` maps the fixed field roles to the actual DB column names, since
  // jobs use a "site_" prefix (site_town, site_postcode, ...) while
  // customers/engineers don't.
  function readAddressFields(prefix, cols) {
    var out = {};
    out[cols.line1] = $(prefix + '-line1').value.trim();
    out[cols.line2] = $(prefix + '-line2').value.trim();
    out[cols.town] = $(prefix + '-town').value.trim();
    out[cols.county] = $(prefix + '-county').value.trim();
    out[cols.postcode] = $(prefix + '-postcode').value.trim();
    out[cols.country] = $(prefix + '-country').value.trim();
    return out;
  }
  function fillAddressFields(prefix, rec, cols) {
    $(prefix + '-line1').value = (rec && rec[cols.line1]) || '';
    $(prefix + '-line2').value = (rec && rec[cols.line2]) || '';
    $(prefix + '-town').value = (rec && rec[cols.town]) || '';
    $(prefix + '-county').value = (rec && rec[cols.county]) || '';
    $(prefix + '-postcode').value = (rec && rec[cols.postcode]) || '';
    $(prefix + '-country').value = (rec && rec[cols.country]) || '';
  }
  function assembleAddress(fieldsObj, cols) {
    return [fieldsObj[cols.line1], fieldsObj[cols.line2], fieldsObj[cols.town], fieldsObj[cols.county], fieldsObj[cols.postcode], fieldsObj[cols.country]]
      .filter(function (x) { return x && x.trim(); }).join(', ');
  }
  var CUSTOMER_ADDR_COLS = { line1: 'address_line1', line2: 'address_line2', town: 'town', county: 'county', postcode: 'postcode', country: 'country' };
  var ENGINEER_ADDR_COLS = CUSTOMER_ADDR_COLS;
  var JOB_SITE_ADDR_COLS = { line1: 'site_address_line1', line2: 'site_address_line2', town: 'site_town', county: 'site_county', postcode: 'site_postcode', country: 'site_country' };
  var JOB_MOVETO_ADDR_COLS = { line1: 'move_to_address_line1', line2: 'move_to_address_line2', town: 'move_to_town', county: 'move_to_county', postcode: 'move_to_postcode', country: 'move_to_country' };

  // ── Supabase Storage helper: short-lived signed URL for a private file ──
  async function signedUrl(bucket, path, seconds) {
    if (!path) return null;
    var res = await sb.storage.from(bucket).createSignedUrl(path, seconds || 3600);
    if (res.error) return null;
    return res.data.signedUrl;
  }
  function fileExt(name) {
    var m = /\.([a-zA-Z0-9]+)$/.exec(name || '');
    return m ? m[1].toLowerCase() : 'bin';
  }

  if (!sb) {
    document.addEventListener('DOMContentLoaded', function () {
      $('login-error').textContent = 'This admin system is not connected to a database yet. ' +
        'Add your Supabase project URL and anon key to js/config.js.';
      show($('login-error'));
      $('login-submit').disabled = true;
    });
    return;
  }

  // ── state ─────────────────────────────────────────────────────
  var state = {
    pendingFactorId: null,
    customers: [],
    engineers: [],
    jobs: [],           // flat, each with .bookingLines/.engineerIds
    chargeRates: [],
    calMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
    currentView: 'calendar',
    reportTab: 'profit',
    currentJobLines: [], // in-progress edit state for the open job modal's booking lines
    jobLineSeq: 0        // local id counter for brand-new (unsaved) booking lines
  };

  // ── auth flow ─────────────────────────────────────────────────
  function authError(el, err) {
    el.textContent = (err && err.message) ? err.message : 'Something went wrong. Please try again.';
    show(el);
  }

  function showAuthCard(name) {
    ['card-login', 'card-mfa-challenge', 'card-mfa-enroll'].forEach(function (id) { hide($(id)); });
    show($(name));
  }

  async function routeAfterSession() {
    var sessionRes = await sb.auth.getSession();
    var session = sessionRes.data.session;
    if (!session) { showAuthCard('card-login'); return; }

    var aalRes = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aalRes.error) { showAuthCard('card-login'); return; }
    var currentLevel = aalRes.data.currentLevel;
    var nextLevel = aalRes.data.nextLevel;

    if (currentLevel === 'aal2') {
      enterApp(session);
    } else if (nextLevel === 'aal2') {
      var factorsRes = await sb.auth.mfa.listFactors();
      var totp = (factorsRes.data && factorsRes.data.totp) || [];
      var verified = totp.find(function (f) { return f.status === 'verified'; });
      if (verified) {
        state.pendingFactorId = verified.id;
        showAuthCard('card-mfa-challenge');
      } else {
        showAuthCard('card-login');
      }
    } else {
      startEnrollment();
    }
  }

  async function startEnrollment() {
    showAuthCard('card-mfa-enroll');
    $('enroll-qr-box').innerHTML = '<span class="loading-dot"></span>';
    $('enroll-secret').textContent = '';
    hide($('enroll-error'));

    // Clean up any leftover unverified factor from an abandoned earlier
    // setup attempt (e.g. the page was closed/reloaded mid-QR-scan) —
    // Supabase refuses a same-name enroll while one is still sitting there.
    var existing = await sb.auth.mfa.listFactors();
    var stale = (existing.data && existing.data.totp || []).filter(function (f) { return f.status === 'unverified'; });
    for (var i = 0; i < stale.length; i++) {
      await sb.auth.mfa.unenroll({ factorId: stale[i].id });
    }

    // Explicitly name the issuer so authenticator apps show "Recomworks Ltd -
    // Admin" instead of defaulting to the Supabase project's Site URL
    // (which shows up as "localhost:3000" until that's changed too).
    var res = await sb.auth.mfa.enroll({
      factorType: 'totp',
      issuer: 'Recomworks Ltd - Admin',
      friendlyName: 'recomworks-admin-' + Date.now()
    });
    if (res.error) { authError($('enroll-error'), res.error); return; }
    state.pendingFactorId = res.data.id;
    // Build the <img> via the DOM rather than an HTML string: Supabase's
    // QR code is an SVG data URI containing raw double quotes, which would
    // otherwise close the src="..." attribute early and leak the rest of
    // the markup as visible text.
    $('enroll-qr-box').innerHTML = '';
    var qrImg = document.createElement('img');
    qrImg.src = res.data.totp.qr_code;
    qrImg.alt = 'Scan with your authenticator app';
    $('enroll-qr-box').appendChild(qrImg);
    $('enroll-secret').textContent = res.data.totp.secret;
  }

  $('form-login').addEventListener('submit', async function (e) {
    e.preventDefault();
    hide($('login-error'));
    $('login-submit').disabled = true;
    var email = $('login-email').value.trim();
    var password = $('login-password').value;
    var res = await sb.auth.signInWithPassword({ email: email, password: password });
    $('login-submit').disabled = false;
    if (res.error) { authError($('login-error'), res.error); return; }
    routeAfterSession();
  });

  $('form-challenge').addEventListener('submit', async function (e) {
    e.preventDefault();
    hide($('challenge-error'));
    var code = $('challenge-code').value.trim();
    var res = await sb.auth.mfa.challengeAndVerify({ factorId: state.pendingFactorId, code: code });
    if (res.error) { authError($('challenge-error'), res.error); return; }
    $('challenge-code').value = '';
    routeAfterSession();
  });

  $('btn-cancel-challenge').addEventListener('click', async function () {
    await sb.auth.signOut();
    showAuthCard('card-login');
  });

  $('form-enroll').addEventListener('submit', async function (e) {
    e.preventDefault();
    hide($('enroll-error'));
    var code = $('enroll-code').value.trim();
    var res = await sb.auth.mfa.challengeAndVerify({ factorId: state.pendingFactorId, code: code });
    if (res.error) { authError($('enroll-error'), res.error); return; }
    $('enroll-code').value = '';
    toast('Two-factor authentication set up.');
    routeAfterSession();
  });

  $('btn-sign-out').addEventListener('click', async function () {
    await sb.auth.signOut();
    location.reload();
  });

  function enterApp(session) {
    hide($('auth-wrap'));
    $('auth-wrap').style.display = 'none';
    $('sidebar-user-email').textContent = session.user.email || '';
    $('app-shell').classList.add('visible');
    loadAll();
  }

  // ── view routing ──────────────────────────────────────────────
  document.querySelectorAll('.nav-item').forEach(function (btn) {
    btn.addEventListener('click', function () { switchView(btn.dataset.view); });
  });
  function switchView(name) {
    state.currentView = name;
    document.querySelectorAll('.nav-item').forEach(function (b) {
      b.classList.toggle('active', b.dataset.view === name);
    });
    ['calendar', 'jobs', 'customers', 'engineers', 'payments', 'reports', 'rates'].forEach(function (v) {
      $('view-' + v).hidden = (v !== name);
    });
    if (name === 'payments') renderPaymentsTable();
    if (name === 'reports') renderReports();
    if (name === 'rates') renderRatesTable();
  }

  // ── modal helpers ─────────────────────────────────────────────
  document.querySelectorAll('[data-close]').forEach(function (btn) {
    btn.addEventListener('click', function () { hide($(btn.dataset.close)); });
  });
  document.querySelectorAll('.modal-overlay').forEach(function (ov) {
    ov.addEventListener('click', function (e) { if (e.target === ov) hide(ov); });
  });

  // ── data loading ──────────────────────────────────────────────
  async function loadAll() {
    await Promise.all([loadCustomers(), loadEngineers(), loadChargeRates()]);
    await loadJobs();
    renderCalendar();
    renderJobsTable();
    renderCustomersTable();
    renderEngineersTable();
  }

  async function loadCustomers() {
    var res = await sb.from('customers').select('*').order('company_name');
    if (res.error) { toast('Could not load customers: ' + res.error.message, true); return; }
    state.customers = res.data || [];
  }

  async function loadEngineers() {
    var res = await sb.from('engineers').select('*').order('name');
    if (res.error) { toast('Could not load contractors: ' + res.error.message, true); return; }
    state.engineers = res.data || [];
  }

  async function loadChargeRates() {
    var res = await sb.from('charge_rates').select('*').order('name');
    if (res.error) { toast('Could not load rates: ' + res.error.message, true); return; }
    state.chargeRates = res.data || [];
  }

  async function loadJobs() {
    // job_engineers is also fetched purely so a job saved under the old
    // single date/rate/engineer-picker model (before booking lines existed)
    // can still be displayed and edited — openJobModal synthesizes a single
    // booking line from it the first time such a job is reopened.
    var res = await sb.from('jobs').select('*, job_booking_lines(*), job_engineers(*)').order('start_at');
    if (res.error) { toast('Could not load jobs: ' + res.error.message, true); return; }
    state.jobs = (res.data || []).map(function (j) {
      j.bookingLines = (j.job_booking_lines || []).slice().sort(function (a, b) {
        if (a.booking_date !== b.booking_date) return a.booking_date < b.booking_date ? -1 : 1;
        return (a.start_time || '').localeCompare(b.start_time || '');
      });
      j.engineerAssignments = j.job_engineers || [];
      var idSet = {};
      j.bookingLines.forEach(function (l) { if (l.engineer_id) idSet[l.engineer_id] = true; });
      j.engineerIds = Object.keys(idSet);
      return j;
    });
  }

  function customerName(id) {
    var c = state.customers.find(function (x) { return x.id === id; });
    return c ? c.company_name : '—';
  }
  function engineerNames(ids) {
    return (ids || []).map(function (id) {
      var e = state.engineers.find(function (x) { return x.id === id; });
      return e ? e.name : null;
    }).filter(Boolean);
  }
  function engineerById(id) {
    return state.engineers.find(function (e) { return e.id === id; });
  }

  // ── profit helpers (now summed across a job's booking lines — falls
  //    back to the old single date/rate/engineer-picker fields for a job
  //    that hasn't been resaved under the booking-lines model yet) ─────
  function lineCost(line) {
    var amount = line.cost_amount;
    if (amount == null && line.engineer_id) { var e = engineerById(line.engineer_id); amount = e ? e.rate : null; }
    return Number(amount) || 0;
  }
  function jobEngineerCost(job) {
    if (job.bookingLines && job.bookingLines.length) {
      return job.bookingLines.reduce(function (sum, l) { return sum + lineCost(l); }, 0);
    }
    return (job.engineerAssignments || []).reduce(function (sum, a) {
      var amount = a.cost_amount;
      if (amount == null) { var e = engineerById(a.engineer_id); amount = e ? e.rate : null; }
      return sum + (Number(amount) || 0);
    }, 0);
  }
  function jobChargeTotal(job) {
    if (job.bookingLines && job.bookingLines.length) {
      return job.bookingLines.reduce(function (sum, l) { return sum + (Number(l.charge_amount) || 0); }, 0);
    }
    return Number(job.charge_amount) || 0;
  }
  function jobProfit(job) {
    var hasLines = job.bookingLines && job.bookingLines.length;
    var hasLegacy = job.charge_amount != null || (job.engineerAssignments && job.engineerAssignments.length);
    if (!hasLines && !hasLegacy) return null;
    return jobChargeTotal(job) - jobEngineerCost(job);
  }
  function money(n) {
    return '£' + Number(n || 0).toFixed(2);
  }
  function profitCell(job) {
    var p = jobProfit(job);
    if (p == null) return '<span style="color:var(--muted);">—</span>';
    return '<span class="' + (p < 0 ? 'profit-negative' : 'profit-positive') + '">' + money(p) + '</span>';
  }

  // ── booking-line date helpers ───────────────────────────────────
  // Distinct sorted booking dates for a job (falls back to the legacy
  // single start_at date for a job that hasn't been resaved yet).
  function jobBookingDates(job) {
    if (job.bookingLines && job.bookingLines.length) {
      var seen = {};
      var dates = [];
      job.bookingLines.forEach(function (l) {
        if (!seen[l.booking_date]) { seen[l.booking_date] = true; dates.push(l.booking_date); }
      });
      return dates.sort();
    }
    if (job.start_at) return [fmtDate(new Date(job.start_at))];
    return [];
  }
  function jobDateRangeLabel(job) {
    var dates = jobBookingDates(job);
    if (!dates.length) return '—';
    var first = new Date(dates[0] + 'T00:00:00');
    if (dates.length === 1) return shortDate(first);
    var last = new Date(dates[dates.length - 1] + 'T00:00:00');
    return shortDate(first) + ' – ' + shortDate(last);
  }

  // ── calendar ──────────────────────────────────────────────────
  var WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  (function initWeekdayRow() {
    $('cal-weekdays').innerHTML = WEEKDAYS.map(function (d) {
      return '<div class="cal-weekday">' + d + '</div>';
    }).join('');
  })();

  $('cal-prev').addEventListener('click', function () { shiftMonth(-1); });
  $('cal-next').addEventListener('click', function () { shiftMonth(1); });
  $('cal-today').addEventListener('click', function () {
    state.calMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
    renderCalendar();
  });
  function shiftMonth(delta) {
    state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + delta, 1);
    renderCalendar();
  }

  function renderCalendar() {
    var y = state.calMonth.getFullYear(), m = state.calMonth.getMonth();
    $('cal-month-label').textContent = state.calMonth.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

    var firstOfMonth = new Date(y, m, 1);
    var startOffset = (firstOfMonth.getDay() + 6) % 7; // Monday = 0
    var gridStart = new Date(y, m, 1 - startOffset);
    var today = new Date();
    var todayStr = fmtDate(today);

    // Each entry on the calendar is one booking line's own date (so a
    // multi-day job shows up on every day it's actually booked) — a job
    // saved before booking lines existed falls back to its old single
    // start_at date so nothing disappears off the calendar.
    var entriesByDay = {};
    state.jobs.forEach(function (j) {
      if (j.bookingLines && j.bookingLines.length) {
        j.bookingLines.forEach(function (l) {
          (entriesByDay[l.booking_date] = entriesByDay[l.booking_date] || []).push({ job: j, line: l });
        });
      } else if (j.start_at) {
        var key = fmtDate(new Date(j.start_at));
        (entriesByDay[key] = entriesByDay[key] || []).push({ job: j, line: null });
      }
    });

    var html = '';
    for (var i = 0; i < 42; i++) {
      var d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
      var key = fmtDate(d);
      var inMonth = d.getMonth() === m;
      var dayEntries = (entriesByDay[key] || []).slice().sort(function (a, b) {
        var at = a.line ? (a.line.start_time || '') : fmtTime(new Date(a.job.start_at));
        var bt = b.line ? (b.line.start_time || '') : fmtTime(new Date(b.job.start_at));
        return at.localeCompare(bt);
      });
      var chips = dayEntries.slice(0, 3).map(function (en) {
        var j = en.job, l = en.line;
        var timeLabel = l ? (l.start_time ? l.start_time.slice(0, 5) : '—') : fmtTime(new Date(j.start_at));
        var rateLabel = l && l.charge_rate_name ? ' · ' + esc(l.charge_rate_name) : '';
        return '<div class="job-chip status-' + j.status + '">' + timeLabel + ' ' + esc(j.client_name || customerName(j.customer_id)) + rateLabel + '</div>';
      }).join('');
      var more = dayEntries.length > 3 ? '<div class="chip-more">+' + (dayEntries.length - 3) + ' more</div>' : '';
      html += '<div class="cal-day' + (inMonth ? '' : ' out') + (key === todayStr ? ' today' : '') + '" data-date="' + key + '">' +
        '<div class="day-num">' + d.getDate() + '</div>' + chips + more + '</div>';
    }
    $('cal-grid').innerHTML = html;

    document.querySelectorAll('.cal-day').forEach(function (el) {
      el.addEventListener('click', function () { openDayModal(el.dataset.date); });
    });
  }

  function openDayModal(dateStr) {
    var d = new Date(dateStr + 'T00:00:00');
    $('day-modal-title').textContent = friendlyDate(d);
    var dayEntries = [];
    state.jobs.forEach(function (j) {
      if (j.bookingLines && j.bookingLines.length) {
        j.bookingLines.forEach(function (l) {
          if (l.booking_date === dateStr) dayEntries.push({ job: j, line: l });
        });
      } else if (j.start_at && fmtDate(new Date(j.start_at)) === dateStr) {
        dayEntries.push({ job: j, line: null });
      }
    });
    dayEntries.sort(function (a, b) {
      var at = a.line ? (a.line.start_time || '') : fmtTime(new Date(a.job.start_at));
      var bt = b.line ? (b.line.start_time || '') : fmtTime(new Date(b.job.start_at));
      return at.localeCompare(bt);
    });
    var list = $('day-modal-list');
    if (!dayEntries.length) {
      list.innerHTML = '<p style="color:var(--muted); font-size:14px;">No jobs booked this day.</p>';
    } else {
      list.innerHTML = dayEntries.map(function (en) {
        var j = en.job, l = en.line;
        var timeLabel = l ? (l.start_time ? l.start_time.slice(0, 5) : '—') : fmtTime(new Date(j.start_at));
        var eng = l ? (l.engineer_id ? engineerNames([l.engineer_id])[0] : null) : null;
        var engLabel = l ? (eng || 'Unassigned') : (engineerNames(j.engineerIds).join(', ') || 'Unassigned');
        var rateLabel = l && l.charge_rate_name ? l.charge_rate_name + (l.charge_amount != null ? ' (' + money(l.charge_amount) + ')' : '') : '';
        return '<div class="panel" style="padding:12px 14px; cursor:pointer;" data-job-id="' + j.id + '">' +
          '<div style="display:flex; justify-content:space-between; align-items:center; gap:10px;">' +
          '<strong style="font-size:14px;">' + timeLabel + ' — ' + esc(j.client_name || customerName(j.customer_id)) + '</strong>' +
          '<span class="badge status-' + j.status + '">' + j.status + '</span></div>' +
          '<div style="font-size:13px; color:var(--muted); margin-top:4px;">' + esc(j.service_type || '') +
          (rateLabel ? ' · ' + esc(rateLabel) : '') + ' · ' + esc(engLabel) + '</div></div>';
      }).join('');
      list.querySelectorAll('[data-job-id]').forEach(function (el) {
        el.addEventListener('click', function () {
          hide($('modal-day'));
          openJobModal(state.jobs.find(function (j) { return j.id === el.dataset.jobId; }));
        });
      });
    }
    $('day-modal-add').onclick = function () {
      hide($('modal-day'));
      openJobModal(null, dateStr);
    };
    show($('modal-day'));
  }

  // ── jobs table ────────────────────────────────────────────────
  function renderJobsTable() {
    var sorted = state.jobs.slice().sort(function (a, b) {
      var aKey = jobBookingDates(a)[0] || '';
      var bKey = jobBookingDates(b)[0] || '';
      return bKey.localeCompare(aKey);
    });
    $('jobs-empty').hidden = sorted.length > 0;
    $('jobs-tbody').innerHTML = sorted.map(function (j) {
      var engs = engineerNames(j.engineerIds).join(', ') || '—';
      return '<tr data-job-id="' + j.id + '" style="cursor:pointer;">' +
        '<td>' + jobDateRangeLabel(j) + '</td>' +
        '<td>' + esc(customerName(j.customer_id)) + '</td>' +
        '<td>' + esc(j.client_name || '—') + '</td>' +
        '<td>' + esc(j.service_type || '—') + '</td>' +
        '<td>' + esc(j.site_address || '—') + '</td>' +
        '<td>' + esc(engs) + '</td>' +
        '<td><span class="badge status-' + j.status + '">' + j.status + '</span></td>' +
        '<td>' + profitCell(j) + '</td>' +
        '<td class="row-actions"><button class="btn btn-ghost btn-sm" data-mailto-job="' + j.id + '">Email contractor</button></td>' +
        '</tr>';
    }).join('');
    $('jobs-tbody').querySelectorAll('tr').forEach(function (tr) {
      tr.addEventListener('click', function (e) {
        if (e.target.closest('[data-mailto-job]')) return;
        openJobModal(state.jobs.find(function (j) { return j.id === tr.dataset.jobId; }));
      });
    });
    $('jobs-tbody').querySelectorAll('[data-mailto-job]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        emailContractorsForJob(state.jobs.find(function (j) { return j.id === btn.dataset.mailtoJob; }));
      });
    });
  }

  function emailContractorsForJob(job) {
    var engs = state.engineers.filter(function (e) { return (job.engineerIds || []).indexOf(e.id) !== -1 && e.email; });
    if (!engs.length) { toast('No contractor with an email address is assigned to this job yet.', true); return; }
    var cust = state.customers.find(function (c) { return c.id === job.customer_id; });
    var dates = jobBookingDates(job);
    var subject = 'Job — ' + (job.service_type || 'Recomworks job') + ' — ' + (dates.length ? shortDate(new Date(dates[0] + 'T00:00:00')) : '');
    var itinerary;
    if (job.bookingLines && job.bookingLines.length) {
      itinerary = job.bookingLines.map(function (l) {
        var d = new Date(l.booking_date + 'T00:00:00');
        var timeRange = (l.start_time ? l.start_time.slice(0, 5) : '') + (l.end_time ? '–' + l.end_time.slice(0, 5) : '');
        var eng = l.engineer_id ? engineerNames([l.engineer_id])[0] : null;
        return '  ' + friendlyDate(d) + (timeRange ? ' ' + timeRange : '') +
          (l.charge_rate_name ? ' — ' + l.charge_rate_name : '') + (eng ? ' — ' + eng : '');
      }).join('\n');
    } else {
      var t = new Date(job.start_at);
      itinerary = '  ' + friendlyDate(t) + ' ' + fmtTime(t) + (job.end_at ? '–' + fmtTime(new Date(job.end_at)) : '');
    }
    var lines = [
      'Job details from Recomworks:',
      '',
      'Customer: ' + (cust ? cust.company_name : '—'),
      job.client_name ? 'Client: ' + job.client_name : '',
      'Service: ' + (job.service_type || '—'),
      '',
      'Booking:',
      itinerary,
      '',
      'Site address: ' + (job.site_address || '—'),
      job.has_move_to_address ? 'Moving to: ' + assembleAddress(job, JOB_MOVETO_ADDR_COLS) : '',
      job.onsite_contact_name ? 'On-site contact: ' + job.onsite_contact_name + (job.onsite_contact_phone ? ' (' + job.onsite_contact_phone + ')' : '') : '',
      job.site_foreman_name ? 'Site foreman: ' + job.site_foreman_name + (job.site_foreman_phone ? ' (' + job.site_foreman_phone + ')' : '') : '',
      job.po_reference ? 'PO / reference: ' + job.po_reference : '',
      '',
      job.description ? 'Description: ' + job.description : '',
      job.notes ? 'Notes: ' + job.notes : ''
    ].filter(Boolean);
    var mailto = 'mailto:' + engs.map(function (e) { return e.email; }).join(',') +
      '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(lines.join('\n'));
    window.location.href = mailto;
  }

  // ── job modal ─────────────────────────────────────────────────
  $('btn-new-job-cal').addEventListener('click', function () { openJobModal(null); });
  $('btn-new-job-list').addEventListener('click', function () { openJobModal(null); });

  $('job-has-move-to').addEventListener('change', function () {
    $('job-move-to-section').hidden = !this.checked;
  });

  // ── booking lines: repeatable date + time + rate + engineer rows ──
  function blankBookingLine(defaultDate) {
    state.jobLineSeq += 1;
    return {
      _key: 'new-' + state.jobLineSeq,
      id: null,
      booking_date: defaultDate || fmtDate(new Date()),
      start_time: '09:00',
      end_time: '',
      charge_rate_id: '',
      charge_rate_name: null,
      charge_amount: null,
      engineer_id: '',
      cost_amount: null,
      payment_status: 'unpaid',
      invoice_received_at: null,
      paid_at: null
    };
  }

  function updateJobProfitLine() {
    var lines = state.currentJobLines;
    var charge = 0, cost = 0;
    lines.forEach(function (line) {
      charge += Number(line.charge_amount) || 0;
      var c = line.cost_amount;
      if (c == null && line.engineer_id) { var e = engineerById(line.engineer_id); c = e ? e.rate : null; }
      cost += Number(c) || 0;
    });
    var el = $('job-profit-line');
    if (!lines.length) {
      el.textContent = 'Estimated profit: —';
      el.classList.remove('negative');
      return;
    }
    var profit = charge - cost;
    el.textContent = 'Estimated profit: ' + money(profit) + ' (charging ' + money(charge) + ' − ' + money(cost) +
      ' contractor cost across ' + lines.length + ' booking line' + (lines.length === 1 ? '' : 's') + ')';
    el.classList.toggle('negative', profit < 0);
  }

  function bookingLineCardHtml(line) {
    var rateOptions = '<option value="">— Custom / none —</option>' + state.chargeRates.map(function (r) {
      return '<option value="' + r.id + '"' + (line.charge_rate_id === r.id ? ' selected' : '') + '>' +
        esc(r.name) + ' — ' + money(r.amount) + '/' + r.rate_type + (r.active ? '' : ' (inactive)') + '</option>';
    }).join('');
    var engOptions = '<option value="">— Unassigned —</option>' + state.engineers.map(function (e) {
      return '<option value="' + e.id + '"' + (line.engineer_id === e.id ? ' selected' : '') + '>' +
        esc(e.name) + (e.active ? '' : ' (inactive)') + '</option>';
    }).join('');
    var statusBadge = line.id ? ' <span class="badge status-' + (line.payment_status || 'unpaid') + '">' + paymentStatusLabel(line.payment_status || 'unpaid') + '</span>' : '';
    return '<div class="booking-line-card" data-line-key="' + line._key + '">' +
      '<div class="booking-line-head"><span class="booking-line-label">Booking line' + statusBadge + '</span>' +
      '<button type="button" class="btn btn-ghost btn-sm booking-line-remove" data-remove-line="' + line._key + '">Remove</button></div>' +
      '<div class="field-row" style="grid-template-columns:1fr 1fr 1fr;">' +
      '<div class="field"><label>Date</label><input type="date" class="bl-date" value="' + esc(line.booking_date || '') + '" required></div>' +
      '<div class="field"><label>Start</label><input type="time" class="bl-start" value="' + esc(line.start_time || '') + '"></div>' +
      '<div class="field"><label>End</label><input type="time" class="bl-end" value="' + esc(line.end_time || '') + '"></div>' +
      '</div>' +
      '<div class="field-row">' +
      '<div class="field"><label>Rate charged</label><select class="bl-rate">' + rateOptions + '</select></div>' +
      '<div class="field"><label>Amount charged</label><input type="number" step="0.01" min="0" class="bl-amount" placeholder="0.00" value="' + (line.charge_amount != null ? line.charge_amount : '') + '"></div>' +
      '</div>' +
      '<div class="field-row">' +
      '<div class="field"><label>Engineer</label><select class="bl-engineer">' + engOptions + '</select></div>' +
      '<div class="field"><label>Engineer cost</label><input type="number" step="0.01" min="0" class="bl-cost" placeholder="Cost £" value="' + (line.cost_amount != null ? line.cost_amount : '') + '"></div>' +
      '</div>' +
      '</div>';
  }

  function wireBookingLineCard(line) {
    var card = document.querySelector('.booking-line-card[data-line-key="' + line._key + '"]');
    if (!card) return;
    card.querySelector('.bl-date').addEventListener('change', function () { line.booking_date = this.value; renderBookingLines(); });
    card.querySelector('.bl-start').addEventListener('change', function () { line.start_time = this.value; renderBookingLines(); });
    card.querySelector('.bl-end').addEventListener('change', function () { line.end_time = this.value; });
    card.querySelector('.bl-rate').addEventListener('change', function () {
      var selectedId = this.value;
      var rate = state.chargeRates.find(function (r) { return r.id === selectedId; });
      line.charge_rate_id = selectedId || '';
      if (rate) {
        line.charge_rate_name = rate.name;
        line.charge_amount = rate.amount;
        card.querySelector('.bl-amount').value = rate.amount;
      } else {
        line.charge_rate_name = null;
      }
      updateJobProfitLine();
    });
    card.querySelector('.bl-amount').addEventListener('input', function () {
      line.charge_amount = this.value === '' ? null : Number(this.value);
      updateJobProfitLine();
    });
    card.querySelector('.bl-engineer').addEventListener('change', function () {
      line.engineer_id = this.value || '';
      if (line.engineer_id && line.cost_amount == null) {
        var eng = engineerById(line.engineer_id);
        if (eng && eng.rate != null) {
          line.cost_amount = eng.rate;
          card.querySelector('.bl-cost').value = eng.rate;
        }
      }
      updateJobProfitLine();
    });
    card.querySelector('.bl-cost').addEventListener('input', function () {
      line.cost_amount = this.value === '' ? null : Number(this.value);
      updateJobProfitLine();
    });
    card.querySelector('[data-remove-line]').addEventListener('click', function () {
      state.currentJobLines = state.currentJobLines.filter(function (l) { return l._key !== line._key; });
      renderBookingLines();
    });
  }

  function renderBookingLines() {
    var container = $('job-booking-lines');
    var lines = state.currentJobLines;
    if (!lines.length) {
      container.innerHTML = '<p class="booking-lines-empty">No booking lines yet — add one below.</p>';
      updateJobProfitLine();
      return;
    }
    var sorted = lines.slice().sort(function (a, b) {
      if (a.booking_date !== b.booking_date) return (a.booking_date || '').localeCompare(b.booking_date || '');
      return (a.start_time || '').localeCompare(b.start_time || '');
    });
    var html = '';
    var lastDate = null;
    sorted.forEach(function (line) {
      if (line.booking_date && line.booking_date !== lastDate) {
        lastDate = line.booking_date;
        html += '<div class="booking-lines-date-heading">' + esc(friendlyDate(new Date(line.booking_date + 'T00:00:00'))) + '</div>';
      }
      html += bookingLineCardHtml(line);
    });
    container.innerHTML = html;
    sorted.forEach(function (line) { wireBookingLineCard(line); });
    updateJobProfitLine();
  }

  $('job-add-line').addEventListener('click', function () {
    var lastDate = state.currentJobLines.length ? state.currentJobLines[state.currentJobLines.length - 1].booking_date : null;
    state.currentJobLines.push(blankBookingLine(lastDate));
    renderBookingLines();
  });

  function openJobModal(job, presetDate) {
    var form = $('form-job');
    form.reset();
    $('job-id').value = job ? job.id : '';
    $('job-modal-title').textContent = job ? 'Edit job' : 'New job';
    $('job-delete').hidden = !job;

    var customerSel = $('job-customer');
    customerSel.innerHTML = state.customers.map(function (c) {
      return '<option value="' + c.id + '">' + esc(c.company_name) + '</option>';
    }).join('') || '<option value="">Add a customer first</option>';

    if (job) {
      customerSel.value = job.customer_id || '';
      $('job-client-name').value = job.client_name || '';
      $('job-service').value = job.service_type || 'IT Relocations';
      $('job-status').value = job.status || 'unassigned';
      $('job-onsite-name').value = job.onsite_contact_name || '';
      $('job-onsite-phone').value = job.onsite_contact_phone || '';
      $('job-onsite-email').value = job.onsite_contact_email || '';
      if (job.site_address_line1 || job.site_town || job.site_postcode) {
        fillAddressFields('job-site', job, JOB_SITE_ADDR_COLS);
      } else {
        // Older job saved before structured addresses existed — drop the
        // old free-text address into line 1 so nothing is lost.
        fillAddressFields('job-site', null, JOB_SITE_ADDR_COLS);
        $('job-site-line1').value = job.site_address || '';
      }
      $('job-has-move-to').checked = !!job.has_move_to_address;
      $('job-move-to-section').hidden = !job.has_move_to_address;
      fillAddressFields('job-moveto', job, JOB_MOVETO_ADDR_COLS);
      $('job-foreman-name').value = job.site_foreman_name || '';
      $('job-foreman-phone').value = job.site_foreman_phone || '';
      $('job-po').value = job.po_reference || '';
      $('job-description').value = job.description || '';
      $('job-notes').value = job.notes || '';

      if (job.bookingLines && job.bookingLines.length) {
        state.currentJobLines = job.bookingLines.map(function (l) {
          return {
            _key: l.id, id: l.id,
            booking_date: l.booking_date,
            start_time: l.start_time ? l.start_time.slice(0, 5) : '',
            end_time: l.end_time ? l.end_time.slice(0, 5) : '',
            charge_rate_id: l.charge_rate_id || '', charge_rate_name: l.charge_rate_name, charge_amount: l.charge_amount,
            engineer_id: l.engineer_id || '', cost_amount: l.cost_amount,
            payment_status: l.payment_status || 'unpaid', invoice_received_at: l.invoice_received_at, paid_at: l.paid_at
          };
        });
      } else if (job.start_at) {
        // Job saved under the old single date/rate/engineer-picker model,
        // before booking lines existed — synthesize lines from it so
        // nothing is lost the first time it's reopened (one line per
        // previously-assigned contractor; only the first carries the old
        // charge amount, since that single figure covered the whole job,
        // not each contractor individually).
        var s = new Date(job.start_at);
        var baseDate = fmtDate(s), baseStart = fmtTime(s), baseEnd = job.end_at ? fmtTime(new Date(job.end_at)) : '';
        var legacyAssignments = job.engineerAssignments || [];
        if (legacyAssignments.length) {
          state.currentJobLines = legacyAssignments.map(function (a, idx) {
            state.jobLineSeq += 1;
            return {
              _key: 'legacy-' + state.jobLineSeq, id: null,
              booking_date: baseDate, start_time: baseStart, end_time: baseEnd,
              charge_rate_id: idx === 0 ? (job.charge_rate_id || '') : '',
              charge_rate_name: idx === 0 ? (job.charge_rate_name || null) : null,
              charge_amount: idx === 0 ? job.charge_amount : null,
              engineer_id: a.engineer_id || '', cost_amount: a.cost_amount,
              payment_status: a.payment_status || 'unpaid', invoice_received_at: a.invoice_received_at, paid_at: a.paid_at
            };
          });
        } else {
          state.jobLineSeq += 1;
          state.currentJobLines = [{
            _key: 'legacy-' + state.jobLineSeq, id: null,
            booking_date: baseDate, start_time: baseStart, end_time: baseEnd,
            charge_rate_id: job.charge_rate_id || '', charge_rate_name: job.charge_rate_name || null, charge_amount: job.charge_amount,
            engineer_id: '', cost_amount: null, payment_status: 'unpaid', invoice_received_at: null, paid_at: null
          }];
        }
      } else {
        state.currentJobLines = [];
      }
    } else {
      $('job-move-to-section').hidden = true;
      state.currentJobLines = [blankBookingLine(presetDate)];
    }

    renderBookingLines();
    show($('modal-job'));
  }

  $('form-job').addEventListener('submit', async function (e) {
    e.preventDefault();
    var id = $('job-id').value;
    var siteAddrFields = readAddressFields('job-site', JOB_SITE_ADDR_COLS);
    var hasMoveTo = $('job-has-move-to').checked;
    var moveToFields = readAddressFields('job-moveto', JOB_MOVETO_ADDR_COLS);
    if (!hasMoveTo) {
      // Don't keep stale "moving to" address data around once the box is unticked.
      Object.keys(moveToFields).forEach(function (k) { moveToFields[k] = ''; });
    }

    var lines = state.currentJobLines;
    if (!lines.length) { toast('Add at least one booking line before saving.', true); return; }
    for (var i = 0; i < lines.length; i++) {
      if (!lines[i].booking_date) { toast('Every booking line needs a date.', true); return; }
    }

    // jobs.start_at / end_at are NOT NULL and drive the flat Jobs-list sort
    // and the old Outlook feed — derive them from the earliest/latest
    // booking line so they stay meaningful even though the real per-line
    // detail now lives in job_booking_lines.
    var sortedLines = lines.slice().sort(function (a, b) {
      if (a.booking_date !== b.booking_date) return a.booking_date < b.booking_date ? -1 : 1;
      return (a.start_time || '').localeCompare(b.start_time || '');
    });
    var firstLine = sortedLines[0];
    var lastLine = sortedLines[sortedLines.length - 1];
    var startAt = new Date(firstLine.booking_date + 'T' + (firstLine.start_time || '09:00') + ':00');
    var endAt = lastLine.end_time ? new Date(lastLine.booking_date + 'T' + lastLine.end_time + ':00') : null;

    var payload = Object.assign({
      customer_id: $('job-customer').value || null,
      client_name: $('job-client-name').value.trim(),
      service_type: $('job-service').value,
      status: $('job-status').value,
      onsite_contact_name: $('job-onsite-name').value.trim(),
      onsite_contact_phone: $('job-onsite-phone').value.trim(),
      onsite_contact_email: $('job-onsite-email').value.trim(),
      // site_address is kept as a plain-text summary, auto-derived from the
      // structured fields below, so the jobs table, "Email contractor" and
      // the Outlook calendar feed keep working unchanged.
      site_address: assembleAddress(siteAddrFields, JOB_SITE_ADDR_COLS),
      has_move_to_address: hasMoveTo,
      site_foreman_name: $('job-foreman-name').value.trim(),
      site_foreman_phone: $('job-foreman-phone').value.trim(),
      po_reference: $('job-po').value.trim(),
      description: $('job-description').value.trim(),
      notes: $('job-notes').value.trim(),
      start_at: startAt.toISOString(),
      end_at: endAt ? endAt.toISOString() : null,
      updated_at: new Date().toISOString()
    }, siteAddrFields, moveToFields);

    var jobId = id;
    if (id) {
      var res = await sb.from('jobs').update(payload).eq('id', id);
      if (res.error) { toast('Could not save job: ' + res.error.message, true); return; }
    } else {
      var ins = await sb.from('jobs').insert(payload).select().single();
      if (ins.error) { toast('Could not save job: ' + ins.error.message, true); return; }
      jobId = ins.data.id;
    }

    // Diff booking lines by id rather than delete-all-and-reinsert, so a
    // line's payment status survives an edit to any *other* line on the job.
    var existingJob = id ? state.jobs.find(function (j) { return j.id === id; }) : null;
    var existingIds = (existingJob && existingJob.bookingLines || []).map(function (l) { return l.id; });
    var keptIds = lines.filter(function (l) { return l.id; }).map(function (l) { return l.id; });
    var toRemove = existingIds.filter(function (lid) { return keptIds.indexOf(lid) === -1; });
    if (toRemove.length) {
      var delRes = await sb.from('job_booking_lines').delete().in('id', toRemove);
      if (delRes.error) { toast('Could not update booking lines: ' + delRes.error.message, true); return; }
    }

    var toInsert = lines.filter(function (l) { return !l.id; }).map(function (l) {
      return {
        job_id: jobId,
        booking_date: l.booking_date,
        start_time: l.start_time || null,
        end_time: l.end_time || null,
        charge_rate_id: l.charge_rate_id || null,
        charge_rate_name: l.charge_rate_name || null,
        charge_amount: l.charge_amount,
        engineer_id: l.engineer_id || null,
        cost_amount: l.cost_amount,
        payment_status: l.payment_status || 'unpaid'
      };
    });
    if (toInsert.length) {
      var insLines = await sb.from('job_booking_lines').insert(toInsert);
      if (insLines.error) { toast('Could not save booking lines: ' + insLines.error.message, true); return; }
    }

    var toUpdate = lines.filter(function (l) { return l.id; });
    for (var u = 0; u < toUpdate.length; u++) {
      var l = toUpdate[u];
      var updRes = await sb.from('job_booking_lines').update({
        booking_date: l.booking_date,
        start_time: l.start_time || null,
        end_time: l.end_time || null,
        charge_rate_id: l.charge_rate_id || null,
        charge_rate_name: l.charge_rate_name || null,
        charge_amount: l.charge_amount,
        engineer_id: l.engineer_id || null,
        cost_amount: l.cost_amount,
        updated_at: new Date().toISOString()
      }).eq('id', l.id);
      if (updRes.error) { toast('Could not update a booking line: ' + updRes.error.message, true); return; }
    }

    hide($('modal-job'));
    toast('Job saved.');
    await loadJobs();
    renderCalendar(); renderJobsTable();
  });

  $('job-delete').addEventListener('click', async function () {
    var id = $('job-id').value;
    if (!id || !confirm('Delete this job? This cannot be undone.')) return;
    var res = await sb.from('jobs').delete().eq('id', id);
    if (res.error) { toast('Could not delete job: ' + res.error.message, true); return; }
    hide($('modal-job'));
    toast('Job deleted.');
    await loadJobs();
    renderCalendar(); renderJobsTable();
  });

  // ── customers ─────────────────────────────────────────────────
  function customersById() {
    var byId = {};
    state.customers.forEach(function (c) { byId[c.id] = c; });
    return byId;
  }

  function renderCustomersTable() {
    var q = ($('customer-search').value || '').toLowerCase();
    var byId = customersById();
    var rows = state.customers.filter(function (c) {
      return !q || (c.company_name + ' ' + (c.contact_name || '')).toLowerCase().indexOf(q) !== -1;
    });
    // Group sub-customers directly under their owner: sort by the owning
    // company's name first (a top-level customer is its own group), then
    // put the owner itself before its sub-customers, then alphabetically.
    rows = rows.slice().sort(function (a, b) {
      var aParent = byId[a.parent_customer_id];
      var bParent = byId[b.parent_customer_id];
      var aGroup = (aParent ? aParent.company_name : a.company_name).toLowerCase();
      var bGroup = (bParent ? bParent.company_name : b.company_name).toLowerCase();
      if (aGroup !== bGroup) return aGroup < bGroup ? -1 : 1;
      var aChild = aParent ? 1 : 0, bChild = bParent ? 1 : 0;
      if (aChild !== bChild) return aChild - bChild;
      return a.company_name.toLowerCase() < b.company_name.toLowerCase() ? -1 : 1;
    });
    $('customers-empty').hidden = rows.length > 0;
    $('customers-tbody').innerHTML = rows.map(function (c) {
      var parent = byId[c.parent_customer_id];
      var nameCell = (parent ? '<span style="color:var(--muted);">↳ </span>' : '') + esc(c.company_name);
      return '<tr data-id="' + c.id + '" style="cursor:pointer;">' +
        '<td>' + nameCell + '</td>' +
        '<td class="sub-client-tag">' + (parent ? esc(parent.company_name) : '—') + '</td>' +
        '<td>' + esc(c.contact_name || '—') + (c.contact_position ? ' <span style="color:var(--muted);">(' + esc(c.contact_position) + ')</span>' : '') + '</td>' +
        '<td>' + esc(c.email || '—') + '</td><td>' + esc(c.phone || '—') + '</td><td></td></tr>';
    }).join('');
    $('customers-tbody').querySelectorAll('tr').forEach(function (tr) {
      tr.addEventListener('click', function () {
        openCustomerModal(state.customers.find(function (c) { return c.id === tr.dataset.id; }));
      });
    });
  }
  $('customer-search').addEventListener('input', renderCustomersTable);
  $('btn-new-customer').addEventListener('click', function () { openCustomerModal(null); });

  async function refreshCustomerLogoPreview(c) {
    var box = $('customer-logo-preview');
    if (c && c.logo_path) {
      var url = await signedUrl('logos', c.logo_path, 3600);
      box.innerHTML = url ? '<img src="' + url + '" alt="">' : '<span>No logo</span>';
      $('customer-logo-remove').hidden = !url;
    } else {
      box.innerHTML = '<span>No logo</span>';
      $('customer-logo-remove').hidden = true;
    }
  }

  function openCustomerModal(c) {
    $('form-customer').reset();
    $('customer-id').value = c ? c.id : '';
    $('customer-modal-title').textContent = c ? 'Edit customer' : 'New customer';
    $('customer-delete').hidden = !c;
    $('customer-company').value = c ? c.company_name : '';

    var parentSel = $('customer-parent');
    parentSel.innerHTML = '<option value="">— None: this is a main customer —</option>' +
      state.customers.filter(function (other) { return !c || other.id !== c.id; }).map(function (other) {
        return '<option value="' + other.id + '">' + esc(other.company_name) + '</option>';
      }).join('');
    parentSel.value = c ? (c.parent_customer_id || '') : '';

    $('customer-contact').value = c ? (c.contact_name || '') : '';
    $('customer-contact-position').value = c ? (c.contact_position || '') : '';
    $('customer-phone').value = c ? (c.phone || '') : '';
    $('customer-email').value = c ? (c.email || '') : '';
    fillAddressFields('customer', c, CUSTOMER_ADDR_COLS);
    $('customer-notes').value = c ? (c.notes || '') : '';

    // Logo upload needs a saved customer id (files are stored per-id) —
    // enable it only when editing an existing customer.
    $('customer-logo-file').value = '';
    $('customer-logo-file').disabled = !c;
    $('customer-logo-hint').hidden = !!c;
    refreshCustomerLogoPreview(c);

    show($('modal-customer'));
  }

  $('customer-logo-file').addEventListener('change', async function () {
    var id = $('customer-id').value;
    var file = this.files[0];
    if (!id || !file) return;
    var path = 'customers/' + id + '/logo-' + Date.now() + '.' + fileExt(file.name);
    var up = await sb.storage.from('logos').upload(path, file, { upsert: true });
    if (up.error) { toast('Could not upload logo: ' + up.error.message, true); return; }
    var oldPath = (state.customers.find(function (c) { return c.id === id; }) || {}).logo_path;
    var res = await sb.from('customers').update({ logo_path: path, updated_at: new Date().toISOString() }).eq('id', id);
    if (res.error) { toast('Could not save logo: ' + res.error.message, true); return; }
    if (oldPath && oldPath !== path) await sb.storage.from('logos').remove([oldPath]);
    await loadCustomers();
    refreshCustomerLogoPreview(state.customers.find(function (c) { return c.id === id; }));
    renderCustomersTable();
    toast('Logo uploaded.');
    this.value = '';
  });

  $('customer-logo-remove').addEventListener('click', async function () {
    var id = $('customer-id').value;
    var c = state.customers.find(function (x) { return x.id === id; });
    if (!id || !c || !c.logo_path) return;
    await sb.storage.from('logos').remove([c.logo_path]);
    var res = await sb.from('customers').update({ logo_path: null, updated_at: new Date().toISOString() }).eq('id', id);
    if (res.error) { toast('Could not remove logo: ' + res.error.message, true); return; }
    await loadCustomers();
    refreshCustomerLogoPreview(state.customers.find(function (x) { return x.id === id; }));
    renderCustomersTable();
    toast('Logo removed.');
  });

  $('form-customer').addEventListener('submit', async function (e) {
    e.preventDefault();
    var id = $('customer-id').value;
    var payload = Object.assign({
      company_name: $('customer-company').value.trim(),
      parent_customer_id: $('customer-parent').value || null,
      contact_name: $('customer-contact').value.trim(),
      contact_position: $('customer-contact-position').value.trim(),
      phone: $('customer-phone').value.trim(),
      email: $('customer-email').value.trim(),
      notes: $('customer-notes').value.trim(),
      updated_at: new Date().toISOString()
    }, readAddressFields('customer', CUSTOMER_ADDR_COLS));
    var res = id ? await sb.from('customers').update(payload).eq('id', id)
                 : await sb.from('customers').insert(payload);
    if (res.error) { toast('Could not save customer: ' + res.error.message, true); return; }
    hide($('modal-customer'));
    toast(id ? 'Customer saved.' : 'Customer saved. Reopen it from the list to add a logo.');
    await loadCustomers();
    renderCustomersTable(); renderCalendar(); renderJobsTable();
  });

  $('customer-delete').addEventListener('click', async function () {
    var id = $('customer-id').value;
    if (!id || !confirm('Delete this customer? Jobs linked to them will keep their history but lose the link.')) return;
    var res = await sb.from('customers').delete().eq('id', id);
    if (res.error) { toast('Could not delete customer: ' + res.error.message, true); return; }
    hide($('modal-customer'));
    toast('Customer deleted.');
    await loadCustomers();
    renderCustomersTable(); renderCalendar(); renderJobsTable();
  });

  // ── engineers ─────────────────────────────────────────────────
  function formatRate(e) {
    if (e.rate == null || e.rate === '') return '—';
    var n = '£' + Number(e.rate).toFixed(2);
    if (e.rate_type === 'hour') return n + '/hr';
    if (e.rate_type === 'fixed') return n + ' fixed';
    return n + '/day';
  }

  function renderEngineersTable() {
    var q = ($('engineer-search').value || '').toLowerCase();
    var rows = state.engineers.filter(function (e) { return !q || e.name.toLowerCase().indexOf(q) !== -1; });
    $('engineers-empty').hidden = rows.length > 0;
    $('engineers-tbody').innerHTML = rows.map(function (e) {
      return '<tr data-id="' + e.id + '" style="cursor:pointer;">' +
        '<td>' + esc(e.name) + '</td><td>' + esc(e.email || '—') + '</td><td>' + esc(e.phone || '—') + '</td>' +
        '<td>' + esc(e.skills || '—') + '</td>' +
        '<td>' + esc(formatRate(e)) + '</td>' +
        '<td><span class="badge ' + (e.active ? 'status-confirmed' : 'status-cancelled') + '">' + (e.active ? 'Active' : 'Inactive') + '</span></td><td></td></tr>';
    }).join('');
    $('engineers-tbody').querySelectorAll('tr').forEach(function (tr) {
      tr.addEventListener('click', function () {
        openEngineerModal(state.engineers.find(function (e) { return e.id === tr.dataset.id; }));
      });
    });
  }
  $('engineer-search').addEventListener('input', renderEngineersTable);
  $('btn-new-engineer').addEventListener('click', function () { openEngineerModal(null); });

  // ── contractor invoices ──────────────────────────────────────────
  async function loadEngineerInvoices(engineerId) {
    var res = await sb.from('engineer_invoices').select('*').eq('engineer_id', engineerId).order('uploaded_at', { ascending: false });
    if (res.error) { toast('Could not load invoices: ' + res.error.message, true); return []; }
    return res.data || [];
  }

  async function renderEngineerInvoices(engineerId) {
    var list = $('engineer-invoices-list');
    list.innerHTML = '<p class="invoices-empty">Loading…</p>';
    var invoices = await loadEngineerInvoices(engineerId);
    if (!invoices.length) {
      list.innerHTML = '<p class="invoices-empty">No invoices uploaded yet.</p>';
      return;
    }
    list.innerHTML = invoices.map(function (inv) {
      var d = new Date(inv.uploaded_at);
      var amount = (inv.amount != null && inv.amount !== '') ? ' · £' + Number(inv.amount).toFixed(2) : '';
      return '<div class="invoice-row" data-invoice-id="' + inv.id + '">' +
        '<div class="invoice-meta"><strong>' + esc(inv.file_name || 'Invoice') + '</strong>' +
        '<div style="color:var(--muted); font-size:12px;">' + shortDate(d) + amount + '</div></div>' +
        '<div class="invoice-actions">' +
        '<button class="btn btn-ghost btn-sm" type="button" data-inv-download>Download</button>' +
        '<button class="btn btn-danger btn-sm" type="button" data-inv-delete>Delete</button>' +
        '</div></div>';
    }).join('');
    list.querySelectorAll('[data-inv-download]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var row = btn.closest('[data-invoice-id]');
        var inv = invoices.find(function (i) { return i.id === row.dataset.invoiceId; });
        if (!inv) return;
        var url = await signedUrl('contractor-invoices', inv.file_path, 300);
        if (!url) { toast('Could not open invoice.', true); return; }
        window.open(url, '_blank');
      });
    });
    list.querySelectorAll('[data-inv-delete]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var row = btn.closest('[data-invoice-id]');
        var inv = invoices.find(function (i) { return i.id === row.dataset.invoiceId; });
        if (!inv || !confirm('Delete this invoice?')) return;
        await sb.storage.from('contractor-invoices').remove([inv.file_path]);
        var del = await sb.from('engineer_invoices').delete().eq('id', inv.id);
        if (del.error) { toast('Could not delete invoice: ' + del.error.message, true); return; }
        toast('Invoice deleted.');
        renderEngineerInvoices(engineerId);
      });
    });
  }

  $('engineer-invoice-upload').addEventListener('click', async function () {
    var id = $('engineer-id').value;
    var file = $('engineer-invoice-file').files[0];
    if (!id || !file) { toast('Choose a file to upload first.', true); return; }
    var path = 'engineers/' + id + '/invoice-' + Date.now() + '-' + file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
    var up = await sb.storage.from('contractor-invoices').upload(path, file);
    if (up.error) { toast('Could not upload invoice: ' + up.error.message, true); return; }
    var amountVal = $('engineer-invoice-amount').value;
    var ins = await sb.from('engineer_invoices').insert({
      engineer_id: id,
      file_path: path,
      file_name: file.name,
      amount: amountVal === '' ? null : Number(amountVal)
    });
    if (ins.error) { toast('Could not save invoice record: ' + ins.error.message, true); return; }
    $('engineer-invoice-file').value = '';
    $('engineer-invoice-amount').value = '';
    toast('Invoice uploaded.');
    renderEngineerInvoices(id);
  });

  function openEngineerModal(e) {
    $('form-engineer').reset();
    $('engineer-id').value = e ? e.id : '';
    $('engineer-modal-title').textContent = e ? 'Edit contractor' : 'New contractor';
    $('engineer-delete').hidden = !e;
    $('engineer-name').value = e ? e.name : '';
    $('engineer-email').value = e ? (e.email || '') : '';
    $('engineer-phone').value = e ? (e.phone || '') : '';
    fillAddressFields('engineer', e, ENGINEER_ADDR_COLS);
    $('engineer-utr').value = e ? (e.utr_number || '') : '';
    $('engineer-rate').value = e && e.rate != null ? e.rate : '';
    $('engineer-rate-type').value = e ? (e.rate_type || 'day') : 'day';
    $('engineer-skills').value = e ? (e.skills || '') : '';
    $('engineer-active').checked = e ? !!e.active : true;

    // Invoices need a saved contractor id — only available once editing.
    $('engineer-invoices-section').hidden = !e;
    $('engineer-invoices-hint').hidden = !!e;
    $('engineer-invoice-file').value = '';
    $('engineer-invoice-amount').value = '';
    if (e) renderEngineerInvoices(e.id);

    show($('modal-engineer'));
  }

  $('form-engineer').addEventListener('submit', async function (e) {
    e.preventDefault();
    var id = $('engineer-id').value;
    var rateVal = $('engineer-rate').value;
    var payload = Object.assign({
      name: $('engineer-name').value.trim(),
      email: $('engineer-email').value.trim(),
      phone: $('engineer-phone').value.trim(),
      utr_number: $('engineer-utr').value.trim(),
      rate: rateVal === '' ? null : Number(rateVal),
      rate_type: $('engineer-rate-type').value,
      skills: $('engineer-skills').value.trim(),
      active: $('engineer-active').checked,
      updated_at: new Date().toISOString()
    }, readAddressFields('engineer', ENGINEER_ADDR_COLS));
    var res = id ? await sb.from('engineers').update(payload).eq('id', id)
                 : await sb.from('engineers').insert(payload);
    if (res.error) { toast('Could not save contractor: ' + res.error.message, true); return; }
    hide($('modal-engineer'));
    toast(id ? 'Contractor saved.' : 'Contractor saved. Reopen it from the list to upload invoices.');
    await loadEngineers();
    renderEngineersTable(); renderCalendar(); renderJobsTable();
  });

  $('engineer-delete').addEventListener('click', async function () {
    var id = $('engineer-id').value;
    if (!id || !confirm('Delete this contractor?')) return;
    var res = await sb.from('engineers').delete().eq('id', id);
    if (res.error) { toast('Could not delete contractor: ' + res.error.message, true); return; }
    hide($('modal-engineer'));
    toast('Contractor deleted.');
    await loadEngineers();
    renderEngineersTable(); renderCalendar(); renderJobsTable();
  });

  // ── payments ──────────────────────────────────────────────────
  function paymentRows() {
    var rows = [];
    state.jobs.forEach(function (j) {
      if (j.bookingLines && j.bookingLines.length) {
        j.bookingLines.forEach(function (l) {
          if (!l.engineer_id) return; // only lines with a contractor actually booked need paying
          rows.push({ job: j, line: l, engineer: engineerById(l.engineer_id), legacy: false });
        });
      } else {
        // Job saved before booking lines existed and not yet reopened —
        // fall back to its old job_engineers assignments so payment
        // tracking doesn't just disappear for it.
        (j.engineerAssignments || []).forEach(function (a) {
          rows.push({
            job: j, engineer: engineerById(a.engineer_id), legacy: true,
            line: { id: null, booking_date: fmtDate(new Date(j.start_at)), payment_status: a.payment_status, cost_amount: a.cost_amount, charge_rate_name: j.charge_rate_name, engineer_id: a.engineer_id }
          });
        });
      }
    });
    rows.sort(function (a, b) { return (b.line.booking_date || '').localeCompare(a.line.booking_date || ''); });
    return rows;
  }

  function paymentStatusLabel(s) {
    if (s === 'invoice_received') return 'Invoice received';
    if (s === 'paid') return 'Paid';
    return 'Unpaid';
  }

  function renderPaymentsTable() {
    var statusFilter = $('payments-status-filter').value;
    var q = ($('payments-search').value || '').toLowerCase();
    var rows = paymentRows().filter(function (r) {
      if (statusFilter && (r.line.payment_status || 'unpaid') !== statusFilter) return false;
      if (!q) return true;
      var hay = ((r.engineer ? r.engineer.name : '') + ' ' + customerName(r.job.customer_id) + ' ' + (r.job.client_name || '')).toLowerCase();
      return hay.indexOf(q) !== -1;
    });
    $('payments-empty').hidden = rows.length > 0;
    $('payments-tbody').innerHTML = rows.map(function (r) {
      var d = r.line.booking_date ? new Date(r.line.booking_date + 'T00:00:00') : null;
      var status = r.line.payment_status || 'unpaid';
      var cost = r.line.cost_amount != null ? r.line.cost_amount : (r.engineer ? r.engineer.rate : null);
      var actions = '';
      if (status === 'unpaid') actions += '<button class="btn btn-ghost btn-sm" data-pay-action="invoice_received">Invoice received</button>';
      if (status === 'invoice_received') actions += '<button class="btn btn-primary btn-sm" data-pay-action="paid">Mark paid</button>';
      if (status !== 'unpaid') actions += ' <button class="btn btn-ghost btn-sm" data-pay-action="unpaid">Reset</button>';
      return '<tr data-line-id="' + (r.line.id || '') + '" data-legacy="' + (r.legacy ? '1' : '') + '" data-job-id="' + r.job.id + '" data-engineer-id="' + (r.line.engineer_id || '') + '">' +
        '<td>' + (d ? shortDate(d) : '—') + '</td>' +
        '<td>' + esc(customerName(r.job.customer_id)) + '</td>' +
        '<td>' + esc(r.job.client_name || r.job.service_type || '—') + '</td>' +
        '<td>' + esc(r.line.charge_rate_name || '—') + '</td>' +
        '<td>' + esc(r.engineer ? r.engineer.name : 'Unknown contractor') + '</td>' +
        '<td>' + (cost != null ? money(cost) : '—') + '</td>' +
        '<td><span class="badge status-' + status + '">' + paymentStatusLabel(status) + '</span></td>' +
        '<td class="row-actions">' + actions + '</td></tr>';
    }).join('');
    $('payments-tbody').querySelectorAll('[data-pay-action]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        var tr = btn.closest('tr');
        var newStatus = btn.dataset.payAction;
        var patch = { payment_status: newStatus };
        if (newStatus === 'invoice_received') patch.invoice_received_at = new Date().toISOString();
        if (newStatus === 'paid') patch.paid_at = new Date().toISOString();
        if (newStatus === 'unpaid') { patch.invoice_received_at = null; patch.paid_at = null; }
        var res = tr.dataset.legacy
          ? await sb.from('job_engineers').update(patch).eq('job_id', tr.dataset.jobId).eq('engineer_id', tr.dataset.engineerId)
          : await sb.from('job_booking_lines').update(patch).eq('id', tr.dataset.lineId);
        if (res.error) { toast('Could not update payment status: ' + res.error.message, true); return; }
        await loadJobs();
        renderPaymentsTable();
        toast('Payment status updated.');
      });
    });
  }
  $('payments-status-filter').addEventListener('change', renderPaymentsTable);
  $('payments-search').addEventListener('input', renderPaymentsTable);

  // ── reports ───────────────────────────────────────────────────
  document.querySelectorAll('.report-tab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      state.reportTab = btn.dataset.report;
      document.querySelectorAll('.report-tab').forEach(function (b) { b.classList.toggle('active', b === btn); });
      $('report-profit').hidden = state.reportTab !== 'profit';
      $('report-usage').hidden = state.reportTab !== 'usage';
    });
  });
  $('report-from').addEventListener('change', renderReports);
  $('report-to').addEventListener('change', renderReports);
  $('report-this-month').addEventListener('click', function () {
    var now = new Date();
    var first = new Date(now.getFullYear(), now.getMonth(), 1);
    var last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    $('report-from').value = fmtDate(first);
    $('report-to').value = fmtDate(last);
    renderReports();
  });
  $('report-clear').addEventListener('click', function () {
    $('report-from').value = '';
    $('report-to').value = '';
    renderReports();
  });

  function reportFilteredJobs() {
    var from = $('report-from').value;
    var to = $('report-to').value;
    if (!from && !to) return state.jobs;
    return state.jobs.filter(function (j) {
      // A job is "in range" if any of its booking dates fall in the range
      // (falls back to the old single start_at date for a job that hasn't
      // been resaved under the booking-lines model yet).
      var dates = jobBookingDates(j);
      return dates.some(function (d) {
        if (from && d < from) return false;
        if (to && d > to) return false;
        return true;
      });
    });
  }

  function renderReports() {
    $('report-profit').hidden = state.reportTab !== 'profit';
    $('report-usage').hidden = state.reportTab !== 'usage';
    var jobs = reportFilteredJobs();

    // Profit by job
    var totalCharge = 0, totalCost = 0;
    var sorted = jobs.slice().sort(function (a, b) {
      var aKey = jobBookingDates(a)[0] || '';
      var bKey = jobBookingDates(b)[0] || '';
      return bKey.localeCompare(aKey);
    });
    $('report-profit-empty').hidden = sorted.length > 0;
    $('report-profit-tbody').innerHTML = sorted.map(function (j) {
      var cost = jobEngineerCost(j);
      var charge = jobChargeTotal(j);
      totalCharge += charge || 0;
      totalCost += cost;
      var margin = (charge > 0) ? Math.round(((charge - cost) / charge) * 100) + '%' : '—';
      return '<tr>' +
        '<td>' + jobDateRangeLabel(j) + '</td>' +
        '<td>' + esc(customerName(j.customer_id)) + '</td>' +
        '<td>' + esc(j.client_name || j.service_type || '—') + '</td>' +
        '<td>' + (charge ? money(charge) : '—') + '</td>' +
        '<td>' + money(cost) + '</td>' +
        '<td>' + profitCell(j) + '</td>' +
        '<td>' + margin + '</td></tr>';
    }).join('');
    var totalProfit = totalCharge - totalCost;
    $('report-profit-summary').innerHTML =
      '<div><div class="stat-label">Jobs</div><div class="stat-value">' + sorted.length + '</div></div>' +
      '<div><div class="stat-label">Total charged</div><div class="stat-value">' + money(totalCharge) + '</div></div>' +
      '<div><div class="stat-label">Total contractor cost</div><div class="stat-value">' + money(totalCost) + '</div></div>' +
      '<div><div class="stat-label">Total profit</div><div class="stat-value ' + (totalProfit < 0 ? 'profit-negative' : 'profit-positive') + '">' + money(totalProfit) + '</div></div>';

    // Contractor usage
    var byEngineer = {};
    function tallyEngineerUse(engineerId, costAmount, paymentStatus) {
      if (!engineerId) return;
      byEngineer[engineerId] = byEngineer[engineerId] || { count: 0, total: 0, paid: 0, outstanding: 0 };
      var amount = costAmount != null ? Number(costAmount) : (engineerById(engineerId) ? Number(engineerById(engineerId).rate) || 0 : 0);
      byEngineer[engineerId].count += 1;
      byEngineer[engineerId].total += amount;
      if (paymentStatus === 'paid') byEngineer[engineerId].paid += amount;
      else byEngineer[engineerId].outstanding += amount;
    }
    jobs.forEach(function (j) {
      if (j.bookingLines && j.bookingLines.length) {
        j.bookingLines.forEach(function (l) { tallyEngineerUse(l.engineer_id, l.cost_amount, l.payment_status); });
      } else {
        (j.engineerAssignments || []).forEach(function (a) { tallyEngineerUse(a.engineer_id, a.cost_amount, a.payment_status); });
      }
    });
    var usageRows = Object.keys(byEngineer).map(function (id) {
      var eng = engineerById(id);
      return Object.assign({ id: id, name: eng ? eng.name : 'Unknown contractor' }, byEngineer[id]);
    }).sort(function (a, b) { return b.count - a.count; });
    $('report-usage-empty').hidden = usageRows.length > 0;
    $('report-usage-tbody').innerHTML = usageRows.map(function (r) {
      return '<tr>' +
        '<td>' + esc(r.name) + '</td>' +
        '<td>' + r.count + '</td>' +
        '<td>' + money(r.total) + '</td>' +
        '<td>' + money(r.paid) + '</td>' +
        '<td>' + money(r.outstanding) + '</td></tr>';
    }).join('');
  }

  // ── charge rates admin ───────────────────────────────────────────
  function renderRatesTable() {
    var rows = state.chargeRates.slice().sort(function (a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1; });
    $('rates-empty').hidden = rows.length > 0;
    $('rates-tbody').innerHTML = rows.map(function (r) {
      return '<tr data-id="' + r.id + '" style="cursor:pointer;">' +
        '<td>' + esc(r.name) + '</td>' +
        '<td>' + money(r.amount) + ' / ' + esc(r.rate_type) + '</td>' +
        '<td><span class="badge ' + (r.active ? 'status-confirmed' : 'status-cancelled') + '">' + (r.active ? 'Active' : 'Inactive') + '</span></td>' +
        '<td></td></tr>';
    }).join('');
    $('rates-tbody').querySelectorAll('tr').forEach(function (tr) {
      tr.addEventListener('click', function () {
        openRateModal(state.chargeRates.find(function (r) { return r.id === tr.dataset.id; }));
      });
    });
  }
  $('btn-new-rate').addEventListener('click', function () { openRateModal(null); });

  function openRateModal(r) {
    $('form-rate').reset();
    $('rate-id').value = r ? r.id : '';
    $('rate-modal-title').textContent = r ? 'Edit rate' : 'New rate';
    $('rate-delete').hidden = !r;
    $('rate-name').value = r ? r.name : '';
    $('rate-amount').value = r ? r.amount : '';
    $('rate-type').value = r ? r.rate_type : 'day';
    $('rate-active').checked = r ? !!r.active : true;
    show($('modal-rate'));
  }

  $('form-rate').addEventListener('submit', async function (e) {
    e.preventDefault();
    var id = $('rate-id').value;
    var payload = {
      name: $('rate-name').value.trim(),
      amount: Number($('rate-amount').value),
      rate_type: $('rate-type').value,
      active: $('rate-active').checked,
      updated_at: new Date().toISOString()
    };
    var res = id ? await sb.from('charge_rates').update(payload).eq('id', id)
                 : await sb.from('charge_rates').insert(payload);
    if (res.error) { toast('Could not save rate: ' + res.error.message, true); return; }
    hide($('modal-rate'));
    toast('Rate saved.');
    await loadChargeRates();
    renderRatesTable();
  });

  $('rate-delete').addEventListener('click', async function () {
    var id = $('rate-id').value;
    if (!id || !confirm('Delete this rate? Jobs that already used it keep their price — this only removes it from the picker.')) return;
    var res = await sb.from('charge_rates').delete().eq('id', id);
    if (res.error) { toast('Could not delete rate: ' + res.error.message, true); return; }
    hide($('modal-rate'));
    toast('Rate deleted.');
    await loadChargeRates();
    renderRatesTable();
  });

  // ── boot ──────────────────────────────────────────────────────
  sb.auth.onAuthStateChange(function (event) {
    if (event === 'SIGNED_OUT') {
      $('app-shell').classList.remove('visible');
      $('auth-wrap').style.display = 'flex';
      show($('auth-wrap'));
      showAuthCard('card-login');
    }
  });

  routeAfterSession();
})();
