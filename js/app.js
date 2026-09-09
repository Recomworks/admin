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
    jobs: [],           // flat, each with .engineers = [engineer_id,...]
    calMonth: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
    currentView: 'calendar'
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

    var res = await sb.auth.mfa.enroll({ factorType: 'totp' });
    if (res.error) { authError($('enroll-error'), res.error); return; }
    state.pendingFactorId = res.data.id;
    $('enroll-qr-box').innerHTML = '<img src="' + res.data.totp.qr_code + '" alt="Scan with your authenticator app">';
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
    ['calendar', 'jobs', 'customers', 'engineers'].forEach(function (v) {
      $('view-' + v).hidden = (v !== name);
    });
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
    await Promise.all([loadCustomers(), loadEngineers()]);
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

  async function loadJobs() {
    var res = await sb.from('jobs').select('*, job_engineers(engineer_id)').order('start_at');
    if (res.error) { toast('Could not load jobs: ' + res.error.message, true); return; }
    state.jobs = (res.data || []).map(function (j) {
      j.engineerIds = (j.job_engineers || []).map(function (x) { return x.engineer_id; });
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

    var jobsByDay = {};
    state.jobs.forEach(function (j) {
      var key = fmtDate(new Date(j.start_at));
      (jobsByDay[key] = jobsByDay[key] || []).push(j);
    });

    var html = '';
    for (var i = 0; i < 42; i++) {
      var d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
      var key = fmtDate(d);
      var inMonth = d.getMonth() === m;
      var dayJobs = (jobsByDay[key] || []).slice().sort(function (a, b) { return a.start_at.localeCompare(b.start_at); });
      var chips = dayJobs.slice(0, 3).map(function (j) {
        var t = new Date(j.start_at);
        return '<div class="job-chip status-' + j.status + '">' + pad2(t.getHours()) + ':' + pad2(t.getMinutes()) + ' ' + esc(customerName(j.customer_id)) + '</div>';
      }).join('');
      var more = dayJobs.length > 3 ? '<div class="chip-more">+' + (dayJobs.length - 3) + ' more</div>' : '';
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
    var dayJobs = state.jobs.filter(function (j) { return fmtDate(new Date(j.start_at)) === dateStr; })
      .sort(function (a, b) { return a.start_at.localeCompare(b.start_at); });
    var list = $('day-modal-list');
    if (!dayJobs.length) {
      list.innerHTML = '<p style="color:var(--muted); font-size:14px;">No jobs booked this day.</p>';
    } else {
      list.innerHTML = dayJobs.map(function (j) {
        var t = new Date(j.start_at);
        var engs = engineerNames(j.engineerIds).join(', ') || 'Unassigned';
        return '<div class="panel" style="padding:12px 14px; cursor:pointer;" data-job-id="' + j.id + '">' +
          '<div style="display:flex; justify-content:space-between; align-items:center; gap:10px;">' +
          '<strong style="font-size:14px;">' + pad2(t.getHours()) + ':' + pad2(t.getMinutes()) + ' — ' + esc(customerName(j.customer_id)) + '</strong>' +
          '<span class="badge status-' + j.status + '">' + j.status + '</span></div>' +
          '<div style="font-size:13px; color:var(--muted); margin-top:4px;">' + esc(j.service_type || '') + ' · ' + esc(engs) + '</div></div>';
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
    var sorted = state.jobs.slice().sort(function (a, b) { return b.start_at.localeCompare(a.start_at); });
    $('jobs-empty').hidden = sorted.length > 0;
    $('jobs-tbody').innerHTML = sorted.map(function (j) {
      var t = new Date(j.start_at);
      var engs = engineerNames(j.engineerIds).join(', ') || '—';
      return '<tr data-job-id="' + j.id + '" style="cursor:pointer;">' +
        '<td>' + shortDate(t) + ' ' + fmtTime(t) + '</td>' +
        '<td>' + esc(customerName(j.customer_id)) + '</td>' +
        '<td>' + esc(j.service_type || '—') + '</td>' +
        '<td>' + esc(j.site_address || '—') + '</td>' +
        '<td>' + esc(engs) + '</td>' +
        '<td><span class="badge status-' + j.status + '">' + j.status + '</span></td>' +
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
    var t = new Date(job.start_at);
    var cust = state.customers.find(function (c) { return c.id === job.customer_id; });
    var subject = 'Job — ' + (job.service_type || 'Recomworks job') + ' — ' + shortDate(t);
    var lines = [
      'Job details from Recomworks:',
      '',
      'Customer: ' + (cust ? cust.company_name : '—'),
      'Service: ' + (job.service_type || '—'),
      'Date: ' + friendlyDate(t),
      'Start time: ' + fmtTime(t),
      job.end_at ? 'End time: ' + fmtTime(new Date(job.end_at)) : '',
      'Site address: ' + (job.site_address || '—'),
      job.po_reference ? 'PO / reference: ' + job.po_reference : '',
      '',
      job.notes ? 'Notes: ' + job.notes : ''
    ].filter(Boolean);
    var mailto = 'mailto:' + engs.map(function (e) { return e.email; }).join(',') +
      '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(lines.join('\n'));
    window.location.href = mailto;
  }

  // ── job modal ─────────────────────────────────────────────────
  $('btn-new-job-cal').addEventListener('click', function () { openJobModal(null); });
  $('btn-new-job-list').addEventListener('click', function () { openJobModal(null); });

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

    var picker = $('job-engineer-picker');
    picker.innerHTML = state.engineers.map(function (e) {
      return '<label><input type="checkbox" value="' + e.id + '"> ' + esc(e.name) + (e.active ? '' : ' (inactive)') + '</label>';
    }).join('') || '<p style="font-size:13px; color:var(--muted); margin:0;">Add a contractor first.</p>';

    if (job) {
      customerSel.value = job.customer_id || '';
      $('job-service').value = job.service_type || 'IT Relocations';
      $('job-status').value = job.status || 'unassigned';
      $('job-site').value = job.site_address || '';
      var s = new Date(job.start_at);
      $('job-date').value = fmtDate(s);
      $('job-start-time').value = fmtTime(s);
      $('job-end-time').value = job.end_at ? fmtTime(new Date(job.end_at)) : '';
      $('job-po').value = job.po_reference || '';
      $('job-notes').value = job.notes || '';
      (job.engineerIds || []).forEach(function (id) {
        var cb = picker.querySelector('input[value="' + id + '"]');
        if (cb) cb.checked = true;
      });
    } else {
      $('job-date').value = presetDate || fmtDate(new Date());
      $('job-start-time').value = '09:00';
    }
    show($('modal-job'));
  }

  $('form-job').addEventListener('submit', async function (e) {
    e.preventDefault();
    var id = $('job-id').value;
    var date = $('job-date').value;
    var startTime = $('job-start-time').value;
    var endTime = $('job-end-time').value;
    var payload = {
      customer_id: $('job-customer').value || null,
      service_type: $('job-service').value,
      status: $('job-status').value,
      site_address: $('job-site').value.trim(),
      start_at: new Date(date + 'T' + startTime).toISOString(),
      end_at: endTime ? new Date(date + 'T' + endTime).toISOString() : null,
      po_reference: $('job-po').value.trim(),
      notes: $('job-notes').value.trim(),
      updated_at: new Date().toISOString()
    };
    var engineerIds = Array.from($('job-engineer-picker').querySelectorAll('input:checked')).map(function (cb) { return cb.value; });

    var jobId = id;
    if (id) {
      var res = await sb.from('jobs').update(payload).eq('id', id);
      if (res.error) { toast('Could not save job: ' + res.error.message, true); return; }
    } else {
      var ins = await sb.from('jobs').insert(payload).select().single();
      if (ins.error) { toast('Could not save job: ' + ins.error.message, true); return; }
      jobId = ins.data.id;
    }

    var delRes = await sb.from('job_engineers').delete().eq('job_id', jobId);
    if (delRes.error) { toast('Could not update contractor assignment: ' + delRes.error.message, true); return; }
    if (engineerIds.length) {
      var rows = engineerIds.map(function (eid) { return { job_id: jobId, engineer_id: eid }; });
      var insEng = await sb.from('job_engineers').insert(rows);
      if (insEng.error) { toast('Could not assign contractors: ' + insEng.error.message, true); return; }
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
  function renderCustomersTable() {
    var q = ($('customer-search').value || '').toLowerCase();
    var rows = state.customers.filter(function (c) {
      return !q || (c.company_name + ' ' + (c.contact_name || '')).toLowerCase().indexOf(q) !== -1;
    });
    $('customers-empty').hidden = rows.length > 0;
    $('customers-tbody').innerHTML = rows.map(function (c) {
      return '<tr data-id="' + c.id + '" style="cursor:pointer;">' +
        '<td>' + esc(c.company_name) + '</td><td>' + esc(c.contact_name || '—') + '</td>' +
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

  function openCustomerModal(c) {
    $('form-customer').reset();
    $('customer-id').value = c ? c.id : '';
    $('customer-modal-title').textContent = c ? 'Edit customer' : 'New customer';
    $('customer-delete').hidden = !c;
    $('customer-company').value = c ? c.company_name : '';
    $('customer-contact').value = c ? (c.contact_name || '') : '';
    $('customer-phone').value = c ? (c.phone || '') : '';
    $('customer-email').value = c ? (c.email || '') : '';
    $('customer-address').value = c ? (c.address || '') : '';
    $('customer-notes').value = c ? (c.notes || '') : '';
    show($('modal-customer'));
  }

  $('form-customer').addEventListener('submit', async function (e) {
    e.preventDefault();
    var id = $('customer-id').value;
    var payload = {
      company_name: $('customer-company').value.trim(),
      contact_name: $('customer-contact').value.trim(),
      phone: $('customer-phone').value.trim(),
      email: $('customer-email').value.trim(),
      address: $('customer-address').value.trim(),
      notes: $('customer-notes').value.trim(),
      updated_at: new Date().toISOString()
    };
    var res = id ? await sb.from('customers').update(payload).eq('id', id)
                 : await sb.from('customers').insert(payload);
    if (res.error) { toast('Could not save customer: ' + res.error.message, true); return; }
    hide($('modal-customer'));
    toast('Customer saved.');
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
  function renderEngineersTable() {
    var q = ($('engineer-search').value || '').toLowerCase();
    var rows = state.engineers.filter(function (e) { return !q || e.name.toLowerCase().indexOf(q) !== -1; });
    $('engineers-empty').hidden = rows.length > 0;
    $('engineers-tbody').innerHTML = rows.map(function (e) {
      return '<tr data-id="' + e.id + '" style="cursor:pointer;">' +
        '<td>' + esc(e.name) + '</td><td>' + esc(e.email || '—') + '</td><td>' + esc(e.phone || '—') + '</td>' +
        '<td>' + esc(e.skills || '—') + '</td>' +
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

  function openEngineerModal(e) {
    $('form-engineer').reset();
    $('engineer-id').value = e ? e.id : '';
    $('engineer-modal-title').textContent = e ? 'Edit contractor' : 'New contractor';
    $('engineer-delete').hidden = !e;
    $('engineer-name').value = e ? e.name : '';
    $('engineer-email').value = e ? (e.email || '') : '';
    $('engineer-phone').value = e ? (e.phone || '') : '';
    $('engineer-skills').value = e ? (e.skills || '') : '';
    $('engineer-active').checked = e ? !!e.active : true;
    show($('modal-engineer'));
  }

  $('form-engineer').addEventListener('submit', async function (e) {
    e.preventDefault();
    var id = $('engineer-id').value;
    var payload = {
      name: $('engineer-name').value.trim(),
      email: $('engineer-email').value.trim(),
      phone: $('engineer-phone').value.trim(),
      skills: $('engineer-skills').value.trim(),
      active: $('engineer-active').checked,
      updated_at: new Date().toISOString()
    };
    var res = id ? await sb.from('engineers').update(payload).eq('id', id)
                 : await sb.from('engineers').insert(payload);
    if (res.error) { toast('Could not save contractor: ' + res.error.message, true); return; }
    hide($('modal-engineer'));
    toast('Contractor saved.');
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
