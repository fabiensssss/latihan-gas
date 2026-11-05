/* =====================================================================
 * app.js — Antarmuka Infografis Laporan Harian Produksi BGA
 * ---------------------------------------------------------------------
 * Halaman: Ringkasan · Bedah Gap · Drill-down · Admin
 * Komunikasi ke backend: fetch POST 'text/plain' (anti CORS preflight)
 * ===================================================================== */
(function () {
  'use strict';

  var GAS_URL = (window.APP_CONFIG || {}).GAS_URL || '';
  var A = window.LHPAnalisa;
  var TOKEN_KEY = 'lhp_session';

  var DEFAULT_REGIONS = [['Reg 1', 'Kalteng'], ['Reg 2', 'Kalteng'], ['Reg 3', 'Kalteng'], ['Reg 4', 'Kalteng'],
    ['Reg 5A', 'Kalteng'], ['Reg 5B', 'Kalteng'], ['Reg 6', 'Kalbar'], ['Reg 7A', 'Kalbar'], ['Reg 7B', 'Kalbar'],
    ['Reg 8A', 'Kalbar'], ['Reg 8B', 'Kalbar'], ['Reg 10', 'Kalbar']]
    .map(function (r, i) { return { region: r[0], wilayah: r[1], urutan: i + 1 }; });

  var state = {
    session: null,       // {token, nama, role, exp}
    dates: [],
    tanggal: null,
    reports: {},         // tanggal -> report mentah dari API
    model: null,
    view: 'ringkasan',
    bedah: { level: 'REGION', filter: 'Semua', open: {}, showAll: false },
    drill: { region: null, estate: null, filter: 'Semua' },
    admin: { parsed: null, file: null, wb: null, arsip: true }
  };
  var charts = [];

  // =================================================================
  // UTIL
  // =================================================================
  var $ = function (s, el) { return (el || document).querySelector(s); };
  var $$ = function (s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); };

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function f0(v) { return isNum(v) ? Math.round(v).toLocaleString('id-ID') : '-'; }
  function f1(v) { return isNum(v) ? v.toLocaleString('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : '-'; }
  function sgn(v) { return isNum(v) ? (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(Math.round(v)).toLocaleString('id-ID') : '-'; }
  function pct(v) { return isNum(v) ? Math.round(v * 100) + '%' : '-'; }
  function pctS(v) { return isNum(v) ? (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(Math.round(v * 100)) + '%' : '-'; }
  function dash(v, fn) { return isNum(v) && Math.abs(v) >= 0.5 ? fn(v) : '-'; }

  function tglPanjang(t) {
    return new Date(t + 'T00:00:00').toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }
  function namaBulan(t) { return new Date(t + 'T00:00:00').toLocaleDateString('id-ID', { month: 'long' }); }
  function namaBulanTahun(t) { return new Date(t + 'T00:00:00').toLocaleDateString('id-ID', { month: 'long', year: 'numeric' }); }

  function store(k, v) {
    try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* mode privat */ }
  }
  function load(k) {
    try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; }
  }

  var toastTimer;
  function toast(msg, bad) {
    var t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (bad ? ' bad' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = 'toast hidden'; }, 4200);
  }

  function loadingHtml(msg) {
    return '<div class="loading"><div class="spinner"></div>' + esc(msg || 'Memuat data…') + '</div>';
  }

  // Kelas warna (gaya Excel)
  function cAch(v) {
    if (!isNum(v)) return '';
    var k = state.model ? state.model.settings.ACH_KUNING : 0.9;
    return v >= 1 ? 'c-good' : v >= k ? 'c-warn' : 'c-bad';
  }
  function cGrowth(v) { return !isNum(v) ? '' : v >= 0 ? 'c-good' : v > -0.1 ? 'c-warn' : 'c-bad'; }
  function cHke(v) { return isNum(v) && v > 0 && state.model && v < state.model.settings.HKE_MIN ? 't-bad' : ''; }

  function chipsHtml(list, emptyText) {
    if (!list || !list.length) return emptyText ? '<span class="chip none">' + esc(emptyText) + '</span>' : '';
    return list.map(function (f) { return '<span class="chip k-' + f.key + '">' + esc(f.label) + '</span>'; }).join('');
  }

  // =================================================================
  // API
  // =================================================================
  function api(action, data, extra) {
    if (!GAS_URL || GAS_URL.indexOf('PASTE_') === 0) {
      return Promise.reject(new Error('GAS_URL belum diisi di js/config.js'));
    }
    var body = Object.assign({ action: action, data: data || {} }, extra || {});
    if (state.session && action !== 'login') body.token = state.session.token;
    return fetch(GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      redirect: 'follow'
    }).then(function (r) {
      if (!r.ok) throw new Error('Server error ' + r.status);
      return r.json();
    }).then(function (res) {
      if (!res.success) {
        if (res.code === 'AUTH') { logout(true); }
        var e = new Error(res.message || 'Terjadi kesalahan');
        e.code = res.code;
        throw e;
      }
      return res.data;
    });
  }

  // =================================================================
  // SESI
  // =================================================================
  function showLogin(msg) {
    $('#app').classList.add('hidden');
    $('#login').classList.remove('hidden');
    $('#loginErr').textContent = msg || '';
    setTimeout(function () { $('#pin').focus(); }, 50);
  }

  function logout(expired) {
    state.session = null;
    state.reports = {};
    state.model = null;
    store(TOKEN_KEY, null);
    showLogin(expired ? 'Sesi berakhir, silakan masuk lagi.' : '');
  }

  $('#loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var pin = $('#pin').value.trim();
    var btn = $('#loginBtn');
    btn.disabled = true;
    btn.textContent = 'Memeriksa…';
    $('#loginErr').textContent = '';
    api('login', null, { pin: pin }).then(function (s) {
      state.session = s;
      store(TOKEN_KEY, s);
      $('#pin').value = '';
      startApp();
    }).catch(function (err) {
      $('#loginErr').textContent = err.message;
    }).then(function () {
      btn.disabled = false;
      btn.textContent = 'Masuk';
    });
  });

  $('#logoutBtn').addEventListener('click', function () { logout(false); });

  // =================================================================
  // NAVIGASI
  // =================================================================
  $('#tabs').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-view]');
    if (!b) return;
    setView(b.getAttribute('data-view'));
  });

  function setView(v) {
    state.view = v;
    $$('#tabs button').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-view') === v); });
    render();
    window.scrollTo(0, 0);
  }

  $('#datePick').addEventListener('change', function () {
    loadReport(this.value);
  });

  function startApp() {
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    $('#userName').textContent = state.session.nama;
    $('#tabAdmin').classList.toggle('hidden', state.session.role !== 'Admin');
    $('#view').innerHTML = loadingHtml('Memuat daftar tanggal…');
    api('getDates').then(function (dates) {
      state.dates = dates || [];
      fillDates();
      if (!state.dates.length) {
        state.model = null;
        if (state.session.role === 'Admin') setView('admin');
        else $('#view').innerHTML = '<div class="lead">Belum ada data yang dipublish. Hubungi Admin.</div>';
        return;
      }
      loadReport(state.dates[0]);
    }).catch(function (err) {
      $('#view').innerHTML = '<div class="lead">Gagal memuat: ' + esc(err.message) + '</div>';
    });
  }

  function fillDates() {
    var sel = $('#datePick');
    sel.innerHTML = state.dates.map(function (t) {
      return '<option value="' + t + '">' + esc(tglPanjang(t)) + '</option>';
    }).join('') || '<option>Belum ada data</option>';
    if (state.tanggal) sel.value = state.tanggal;
  }

  function loadReport(t) {
    state.tanggal = t;
    $('#datePick').value = t;
    if (state.reports[t]) {
      state.model = A.build(state.reports[t]);
      render();
      return;
    }
    if (state.view !== 'admin') $('#view').innerHTML = loadingHtml('Memuat laporan ' + tglPanjang(t) + '…');
    api('getReport', { tanggal: t }).then(function (rep) {
      if (!rep) throw new Error('Laporan ' + t + ' tidak ditemukan.');
      state.reports[t] = rep;
      state.model = A.build(rep);
      render();
    }).catch(function (err) {
      $('#view').innerHTML = '<div class="lead">Gagal memuat laporan: ' + esc(err.message) + '</div>';
    });
  }

  // =================================================================
  // RENDER
  // =================================================================
  function destroyCharts() {
    charts.forEach(function (c) { c.destroy(); });
    charts = [];
  }

  function render() {
    destroyCharts();
    var v = state.view;
    if (v === 'admin') return renderAdmin();
    if (!state.model) {
      $('#view').innerHTML = loadingHtml();
      return;
    }
    if (v === 'ringkasan') return renderRingkasan();
    if (v === 'bedah') return renderBedah();
    if (v === 'drill') return renderDrill();
  }

  // ---------- Plugin Chart.js: label nilai di atas batang ----------
  var valueLabels = {
    id: 'valueLabels',
    afterDatasetsDraw: function (chart, args, opts) {
      if (!opts || !opts.fmt) return;
      var ctx = chart.ctx;
      ctx.save();
      ctx.font = '600 11px Inter, sans-serif';
      ctx.fillStyle = '#17231a';
      ctx.textAlign = 'center';
      chart.data.datasets.forEach(function (ds, i) {
        if (ds.type === 'line' || ds.noLabel) return;
        var meta = chart.getDatasetMeta(i);
        if (meta.hidden) return;
        meta.data.forEach(function (bar, j) {
          var v = ds.data[j];
          if (!isNum(v)) return;
          var y = v >= 0 ? bar.y - 5 : bar.y + 13;
          ctx.fillText(opts.fmt(v), bar.x, y);
        });
      });
      ctx.restore();
    }
  };

  function newChart(canvas, cfg) {
    if (!window.Chart) return null;
    cfg.plugins = (cfg.plugins || []).concat([valueLabels]);
    var c = new window.Chart(canvas, cfg);
    charts.push(c);
    return c;
  }

  function lineAt(value, color, label) {
    return {
      id: 'lineAt' + value,
      afterDraw: function (chart) {
        var y = chart.scales.y.getPixelForValue(value);
        var ctx = chart.ctx, a = chart.chartArea;
        ctx.save();
        ctx.strokeStyle = color; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(a.left, y); ctx.lineTo(a.right, y); ctx.stroke();
        if (label) {
          ctx.fillStyle = color; ctx.font = '600 12px Inter, sans-serif'; ctx.textAlign = 'right';
          ctx.fillText(label, a.right, y - 6);
        }
        ctx.restore();
      }
    };
  }

  // =================================================================
  // 1) RINGKASAN
  // =================================================================
  function renderRingkasan() {
    var m = state.model, b = m.bga, t = m.tanggal;
    var bln = namaBulanTahun(t).toUpperCase();
    var hkeJalan = b.rata2 ? Math.round(b.sd_hi / b.rata2) : null;
    var naikTurun = b.var_hl < 0 ? '▼ Turun ' + f0(-b.var_hl) : '▲ Naik ' + f0(b.var_hl);
    var sor = m.sorotanManual.length ? m.sorotanManual : m.sorotanAuto;

    var regGapNeg = m.rank.regionGap.filter(function (r) { return r.gap < 0; });

    var html = '' +
      '<div class="lead">Produksi <b>' + esc(tglPanjang(t)) + '</b>: <b>' + f0(b.prod_hi) + ' ton</b>, ' +
      '<b>' + pct(b.ach_harian) + '</b> dari budget harian (gap <span class="' + (b.gap < 0 ? 'neg' : 'pos') + '">' + sgn(b.gap) + ' ton</span>). ' +
      regGapNeg.length + ' dari ' + m.regions.length + ' region di bawah budget harian' +
      (regGapNeg.length ? '; terbesar ' + esc(regGapNeg.slice(0, 2).map(function (r) { return r.unit; }).join(' & ')) + '.' : '.') +
      ' <a href="#" data-go="bedah">Lihat bedah gap →</a></div>' +

      '<div class="grid g3">' +
        kpiCard('1. Produksi hari ini', b.ach_harian, 'Dari Budget Harian', b.prod_hi,
          ['<span class="' + (b.var_hl < 0 ? 'neg' : 'pos') + '">' + naikTurun + ' ton dari hari kemarin</span> (' + f0(b.prod_hl) + ' ton)',
            'Budget ' + esc(namaBulan(t)) + ': ' + f0(b.budget_bulan) + ' ton · harian ' + f0(b.budget_harian) + ' ton']) +
        kpiCard('2. Produksi ' + bln + (hkeJalan ? ' (' + hkeJalan + ' HKE)' : ''), b.ach_bi, 'Dari Budget S.d Hari Ini', b.sd_hi,
          ['Rata-rata produksi harian ' + f0(b.rata2) + ' ton/hari',
            '<span class="' + (b.growth_bi < 0 ? 'neg' : 'pos') + '">' + (b.growth_bi < 0 ? 'Turun ' : 'Tumbuh ') + pct(Math.abs(b.growth_bi)) + ' dari aktual ' + esc(namaBulan(t)) + ' tahun lalu</span>']) +
        kpiCard('3. Produksi s.d. ' + bln, b.ach_sdbi, 'Dari Budget S.d Bln Ini', b.sd_bi,
          ['<span class="' + (b.growth_sdbi < 0 ? 'neg' : 'pos') + '">' + (b.growth_sdbi < 0 ? 'Turun ' : 'Tumbuh ') + pct(Math.abs(b.growth_sdbi)) + ' dari aktual tahun lalu</span>']) +
      '</div>' +

      '<div class="grid g3" style="margin-top:14px">' +
        '<div class="card"><div class="card-h">4. Capaian produksi harian</div><div class="card-b"><div class="chart-box"><canvas id="chHarian"></canvas></div>' +
          '<div class="legend-line"><span class="' + (b.gap < 0 ? 'neg' : 'pos') + '"><b>' + pct(b.ach_harian) + ' dari budget</b> · selisih ' + sgn(b.gap) + ' ton</span></div></div></div>' +
        '<div class="card"><div class="card-h">5. Capaian budget s.d. ' + esc(namaBulan(t)) + '</div><div class="card-b"><div class="chart-box"><canvas id="chAch"></canvas></div>' +
          '<div class="legend-line"><span><i style="background:#1b7a3d"></i>Capaian ≥100%</span><span><i style="background:#ef5350"></i>Capaian &lt;100%</span><span class="neg">— Target 100%</span></div></div></div>' +
        '<div class="card"><div class="card-h">6. Growth produksi s.d. ' + esc(namaBulan(t)) + '</div><div class="card-b"><div class="chart-box"><canvas id="chGrowth"></canvas></div>' +
          '<div class="legend-line"><span><i style="background:#1b7a3d"></i>Growth ≥0%</span><span><i style="background:#ef5350"></i>Growth &lt;0%</span><span class="neg">— Threshold 0%</span></div></div></div>' +
      '</div>' +

      '<div class="grid g2" style="margin-top:14px">' +
        cardPanen(m) + cardPusingan(m) + cardRestan(m) + cardHke(m) +
      '</div>' +

      '<div class="card sorotan" style="margin-top:14px"><div class="card-h">★ Sorotan utama' +
        (m.sorotanManual.length ? '' : '<span class="right">disusun otomatis</span>') + '</div><div class="card-b"><ol class="points">' +
        sor.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol></div></div>';

    $('#view').innerHTML = html;
    var go = $('[data-go]');
    if (go) go.addEventListener('click', function (e) { e.preventDefault(); setView('bedah'); });

    // Grafik 4: budget harian vs HL vs HI
    newChart($('#chHarian'), {
      type: 'bar',
      data: {
        labels: ['Budget harian', 'Hari lalu', 'Hari ini'],
        datasets: [{ data: [b.budget_harian, b.prod_hl, b.prod_hi], backgroundColor: ['#1565c0', '#f57c00', '#0c4a24'], borderRadius: 4 }]
      },
      options: baseOpts({ fmt: f0, legend: false, yTitle: 'Ton' })
    });
    // Grafik 5 & 6 per region
    var regs = m.regions;
    newChart($('#chAch'), {
      type: 'bar',
      data: {
        labels: regs.map(function (r) { return r.unit.replace('Reg ', ''); }),
        datasets: [{ data: regs.map(function (r) { return Math.round(r.ach_sdbi * 100); }),
          backgroundColor: regs.map(function (r) { return Math.round(r.ach_sdbi * 100) >= 100 ? '#1b7a3d' : '#ef5350'; }), borderRadius: 3 }]
      },
      options: baseOpts({ fmt: function (v) { return v + '%'; }, legend: false, yTitle: '%', min: 0, max: 140 }),
      plugins: [lineAt(100, '#d7261e')]
    });
    newChart($('#chGrowth'), {
      type: 'bar',
      data: {
        labels: regs.map(function (r) { return r.unit.replace('Reg ', ''); }),
        datasets: [{ data: regs.map(function (r) { return Math.round(r.growth_sdbi * 100); }),
          backgroundColor: regs.map(function (r) { return Math.round(r.growth_sdbi * 100) >= 0 ? '#1b7a3d' : '#ef5350'; }), borderRadius: 3 }]
      },
      options: baseOpts({ fmt: function (v) { return v + '%'; }, legend: false, yTitle: '%' }),
      plugins: [lineAt(0, '#d7261e')]
    });
  }

  function baseOpts(o) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      layout: { padding: { top: 18 } },
      plugins: {
        legend: { display: !!o.legend, position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
        tooltip: { callbacks: { label: function (c) { return (c.dataset.label ? c.dataset.label + ': ' : '') + (o.fmt ? o.fmt(c.parsed.y) : c.parsed.y); } } },
        valueLabels: { fmt: o.noLabels ? null : o.fmt }
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 11 } } },
        y: { beginAtZero: true, min: o.min, max: o.max, grace: '12%', title: { display: !!o.yTitle, text: o.yTitle, font: { size: 11 } },
          ticks: { font: { size: 11 }, callback: function (v) { return Number(v).toLocaleString('id-ID'); } }, grid: { color: '#edf2ec' } }
      }
    };
  }

  function kpiCard(judul, ach, lbl, ton, lines) {
    return '<div class="card"><div class="card-h">' + esc(judul) + '</div><div class="card-b"><div class="kpi">' +
      '<div class="badge"><div class="big">' + pct(ach) + '</div><div class="lbl">' + esc(lbl) + '</div></div>' +
      '<div class="val"><div class="ton num">' + f0(ton) + '<span>Ton</span></div><ul>' +
      lines.map(function (l) { return '<li>' + l + '</li>'; }).join('') + '</ul></div></div></div></div>';
  }

  function topList(list, fn, n) {
    return list.slice(0, n || 3).map(fn).join(', ') || '-';
  }

  function cardPanen(m) {
    var b = m.bga;
    var anc = m.regions.filter(function (r) { return r.ancak > 0.5; }).sort(function (a, c) { return c.ancak - a.ancak; });
    var ancE = m.estates.filter(function (r) { return r.ancak > 0.5; }).sort(function (a, c) { return c.ancak - a.ancak; });
    return '<div class="card"><div class="card-h"><span class="no">1</span>Panen hari ini</div><div class="card-b">' +
      '<div class="stat-row"><div class="stat-pill"><b>' + f0(b.ha_aktual) + '</b>Ha aktual</div><div>Luas panen hari ini <b>' + f0(b.ha_aktual) +
      ' Ha</b>, ' + (b.ha_var >= 0 ? 'lebih luas ' : 'kurang ') + '<b>' + f0(Math.abs(b.ha_var)) + ' Ha</b> dari normal (' + f0(b.ha_normal) + ' Ha).</div></div>' +
      '<div class="stat-row"><div class="stat-pill"><b>' + f0(b.ancak) + '</b>Ha ancak</div><div>Ancak tidak selesai' +
      (anc.length ? '; terluas di ' + esc(topList(anc, function (r) { return r.unit + ' (' + f0(r.ancak) + ' Ha)'; }, 2)) +
        '. Estate: ' + esc(topList(ancE, function (r) { return r.unit + ' (' + f0(r.ancak) + ')'; })) : ': tidak ada') + '.</div></div>' +
      '</div></div>';
  }

  function cardPusingan(m) {
    var b = m.bga;
    var r48 = m.regions.filter(function (r) { return r.p48r > 0.5; }).sort(function (a, c) { return c.p48r - a.p48r; });
    var r36 = m.regions.filter(function (r) { return r.p36r > 0.5; }).sort(function (a, c) { return c.p36r - a.p36r; });
    var e48 = m.estates.filter(function (r) { return r.p48r > 0.5; }).sort(function (a, c) { return c.p48r - a.p48r; });
    var e36 = m.estates.filter(function (r) { return r.p36r > 0.5; }).sort(function (a, c) { return c.p36r - a.p36r; });
    return '<div class="card"><div class="card-h"><span class="no">2</span>Pusingan panjang</div><div class="card-b">' +
      '<div class="stat-row"><div class="stat-pill"><b>' + f0(b.p48r) + '</b>Ha 48R</div><div>Umur pusingan ≥9 hari (sistem 48R): ' +
      (r48.length ? esc(topList(r48, function (r) { return r.unit + ' (' + f0(r.p48r) + ')'; }, 4)) + ' Ha. Estate: ' + esc(topList(e48, function (r) { return r.unit; }, 4)) : 'tidak ada') + '.</div></div>' +
      '<div class="stat-row"><div class="stat-pill"><b>' + f0(b.p36r) + '</b>Ha 36R</div><div>Umur pusingan ≥11 hari (sistem 36R): ' +
      (r36.length ? esc(topList(r36, function (r) { return r.unit + ' (' + f0(r.p36r) + ')'; }, 4)) + ' Ha. Estate: ' + esc(topList(e36, function (r) { return r.unit; }, 4)) : 'tidak ada') + '.</div></div>' +
      '</div></div>';
  }

  function cardRestan(m) {
    var b = m.bga;
    var est = m.estates.filter(function (r) { return r.restan > 0.5; }).sort(function (a, c) { return c.restan - a.restan; });
    var pks = m.regions.slice().sort(function (a, c) { return (c.pks_ge18 || 0) - (a.pks_ge18 || 0); });
    return '<div class="card"><div class="card-h"><span class="no">3</span>Restan &amp; transport</div><div class="card-b">' +
      '<div class="stat-row"><div class="stat-pill"><b>' + f0(b.restan) + '</b>Ton restan</div><div>' +
      (est.length ? 'Restan terbesar: ' + esc(topList(est, function (r) { return r.unit + ' (' + f0(r.restan) + ' ton)'; }, 3)) : 'Tidak ada restan') + '.</div></div>' +
      '<div class="stat-row"><div class="stat-pill"><b>' + pct(b.pks_ge18) + '</b>≥18.00</div><div>Penerimaan TBS di PKS setelah jam 18.00 tertinggi: ' +
      esc(topList(pks, function (r) { return r.unit + ' (' + pct(r.pks_ge18) + ')'; }, 2)) + '.</div></div>' +
      '</div></div>';
  }

  function cardHke(m) {
    var b = m.bga;
    var low = m.regions.filter(function (r) { return r.hke_pct > 0; }).sort(function (a, c) { return a.hke_pct - c.hke_pct; });
    var lowE = m.estates.filter(function (r) { return r.hke_pct > 0 && r.hke_pct < m.settings.HKE_MIN; }).sort(function (a, c) { return a.hke_pct - c.hke_pct; });
    return '<div class="card"><div class="card-h"><span class="no">4</span>HKE panen</div><div class="card-b">' +
      '<div class="stat-row"><div class="stat-pill"><b>' + f1(b.hke_pct) + '%</b>HKE BGA</div><div>Region dengan HKE terendah: <b class="neg">' +
      esc(topList(low, function (r) { return r.unit + ' (' + f1(r.hke_pct) + '%)'; }, 3)) + '</b>.</div></div>' +
      '<div class="stat-row"><div class="stat-pill"><b>' + lowE.length + '</b>Estate</div><div>Estate dengan HKE di bawah ' + m.settings.HKE_MIN + '%' +
      (lowE.length ? ': ' + esc(topList(lowE, function (r) { return r.unit + ' (' + f1(r.hke_pct) + '%)'; }, 5)) : ': tidak ada') + '.</div></div>' +
      '</div></div>';
  }

  // =================================================================
  // 2) BEDAH GAP
  // =================================================================
  function renderBedah() {
    var m = state.model, s = state.bedah, b = m.bga;
    var isReg = s.level === 'REGION';
    var pool = isReg ? m.regions : m.estates;
    if (s.filter !== 'Semua') pool = pool.filter(function (u) { return u.wilayah === s.filter || u.parent === s.filter || u.mdo === s.filter; });

    var gapList = pool.filter(function (u) { return isNum(u.gap); }).sort(function (a, c) { return a.gap - c.gap; });
    var varList = pool.filter(function (u) { return isNum(u.var_hl); }).sort(function (a, c) { return a.var_hl - c.var_hl; });

    var neg = m.rank.regionGap.filter(function (r) { return r.gap < 0; });
    var totNeg = neg.reduce(function (a, r) { return a + r.gap; }, 0);
    var top2 = neg.slice(0, 2);
    var top2Share = totNeg ? top2.reduce(function (a, r) { return a + r.gap; }, 0) / totNeg : 0;

    var filters = ['Semua', 'Kalteng', 'Kalbar'].concat(m.mdo.map(function (x) { return x.unit; }));

    var limit = isReg || s.showAll ? 999 : 15;
    var html = '' +
      '<div class="lead">Gap BGA hari ini <b class="' + (b.gap < 0 ? 'neg' : 'pos') + '">' + sgn(b.gap) + ' ton</b> (' + pct(b.ach_harian) + ' dari budget harian ' + f0(b.budget_harian) + ' ton). ' +
      '<b>' + neg.length + ' dari ' + m.regions.length + '</b> region di bawah budget' +
      (top2.length ? '; <b>' + esc(top2.map(function (r) { return r.unit; }).join(' & ')) + '</b> menyumbang ' + pct(top2Share) + ' dari total kekurangan ' + f0(-totNeg) + ' ton.' : '.') + '</div>' +
      '<div class="toolbar"><div class="seg" id="segLevel"><button data-l="REGION" class="' + (isReg ? 'active' : '') + '">Region</button>' +
      '<button data-l="ESTATE" class="' + (!isReg ? 'active' : '') + '">Estate</button></div>' +
      '<div class="filter-chips" id="fBedah">' + filters.map(function (f) {
        return '<button data-f="' + esc(f) + '" class="' + (s.filter === f ? 'active' : '') + '">' + esc(f) + '</button>';
      }).join('') + '</div></div>' +
      '<div class="grid g2">' +
        rankPanel('Jauh dari budget harian', 'Aktual hari ini − budget harian (budget bulan ÷ HKE)', gapList, 'gap', limit, isReg) +
        rankPanel('Turun terbesar dari kemarin', 'Produksi hari ini − hari lalu', varList, 'var_hl', limit, isReg) +
      '</div>' +
      (!isReg && pool.length > 15 ? '<button class="btn ghost more" id="btnAll">' + (s.showAll ? 'Tampilkan 15 teratas' : 'Tampilkan semua ' + pool.length + ' estate') + '</button>' : '') +
      '<p class="small muted" style="margin-top:12px">Label faktor muncul untuk unit yang di bawah budget atau turun dari kemarin. Ambang batas diatur Admin di sheet PENGATURAN (HKE &lt; ' +
      m.settings.HKE_MIN + '%, PKS ≥18.00 &gt; ' + pct(m.settings.PKS_GE18_MAX) + ', AKP turun &gt; ' + pct(m.settings.AKP_DROP_PCT) + ' dari rata-rata bulan).</p>';

    $('#view').innerHTML = html;

    $('#segLevel').addEventListener('click', function (e) {
      var l = e.target.getAttribute('data-l');
      if (!l) return;
      s.level = l; s.showAll = false; render();
    });
    $('#fBedah').addEventListener('click', function (e) {
      var f = e.target.getAttribute('data-f');
      if (!f) return;
      s.filter = f; render();
    });
    var ba = $('#btnAll');
    if (ba) ba.addEventListener('click', function () { s.showAll = !s.showAll; render(); });
    $$('.rank-row[data-u]').forEach(function (row) {
      row.addEventListener('click', function () {
        var u = row.getAttribute('data-u'), k = row.getAttribute('data-k');
        var unit = m.by[u];
        if (unit.level === 'ESTATE') {
          state.drill = { region: unit.parent, estate: u, filter: 'Semua' };
          setView('drill');
          return;
        }
        s.open[k + u] = !s.open[k + u];
        render();
      });
    });
    $$('[data-goest]').forEach(function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        var u = a.getAttribute('data-goest');
        state.drill = { region: m.by[u].parent, estate: u, filter: 'Semua' };
        setView('drill');
      });
    });
  }

  function rankPanel(judul, sub, list, key, limit, isReg) {
    var m = state.model, s = state.bedah;
    var maxAbs = list.reduce(function (a, u) { return Math.max(a, Math.abs(u[key] || 0)); }, 1);
    var rows = list.slice(0, limit).map(function (u, i) {
      var v = u[key];
      var w = Math.min(50, Math.abs(v) / maxAbs * 50);
      var sec = key === 'gap' ? pct(u.ach_harian) + ' dari budget' : pctS(u.var_pct) + ' vs kemarin';
      var showChips = v < 0 || (key === 'gap' && u.var_hl < 0);
      var open = s.open[key + u.unit];
      var sub2 = '';
      if (isReg && open) sub2 = subTable(u, key);
      return '<div class="rank-item"><div class="rank-row" data-u="' + esc(u.unit) + '" data-k="' + key + '" title="' + (isReg ? 'Klik untuk melihat estate penyumbang' : 'Klik untuk detail estate') + '">' +
        '<div class="rk">' + (i + 1) + '</div>' +
        '<div class="nm"><b>' + (isReg ? (open ? '▾ ' : '▸ ') : '') + esc(u.unit) + '</b><span>' + esc(isReg ? (u.wilayah + ' · ' + u.parent) : u.parent) + '</span></div>' +
        '<div class="dbar"><i class="' + (v < 0 ? 'n' : 'p') + '" style="width:' + w.toFixed(1) + '%"></i></div>' +
        '<div class="vv num ' + (v < 0 ? 'neg' : 'pos') + '">' + sgn(v) + ' t<span>' + sec + '</span></div></div>' +
        (showChips ? '<div class="rank-chips"><div class="chips">' + chipsHtml(u.faktor, 'Tidak ada faktor operasional menonjol') + '</div></div>' : '') +
        sub2 + '</div>';
    }).join('');
    return '<div class="card"><div class="card-h">' + esc(judul) + '</div><div class="card-b">' +
      '<div class="small muted" style="margin-bottom:6px">' + esc(sub) + '</div>' + (rows || '<div class="muted">Tidak ada data.</div>') + '</div></div>';
  }

  function subTable(region, key) {
    var m = state.model;
    var kids = (m.children[region.unit] || []).slice().sort(function (a, c) { return (a[key] || 0) - (c[key] || 0); });
    var shareKey = key === 'gap' ? 'shareGap' : 'shareVar';
    return '<div class="sub-table"><table><thead><tr><th>Estate</th><th>' + (key === 'gap' ? 'Gap (t)' : 'Var (t)') + '</th><th>Porsi</th><th>Faktor</th></tr></thead><tbody>' +
      kids.map(function (e) {
        var sh = e[shareKey] || 0;
        return '<tr><td><a href="#" data-goest="' + esc(e.unit) + '"><b>' + esc(e.unit) + '</b></a><div class="small muted">' + (key === 'gap' ? pct(e.ach_harian) : pctS(e.var_pct)) + '</div></td>' +
          '<td class="num ' + (e[key] < 0 ? 'neg' : 'pos') + '">' + sgn(e[key]) + '</td>' +
          '<td class="num">' + (sh > 0 ? '<span class="share" style="width:' + Math.round(sh * 60) + 'px"></span>' + pct(sh) : '-') + '</td>' +
          '<td><div class="chips" style="margin:0">' + (e[key] < 0 ? chipsHtml(e.faktor, 'Tidak ada') : '') + '</div></td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  // =================================================================
  // 3) DRILL-DOWN
  // =================================================================
  var XL_HEAD = '<thead><tr>' +
    '<th rowspan="2">Unit</th><th rowspan="2">Luas TSM<br>(Ha)</th><th colspan="4">Produksi harian (ton)</th>' +
    '<th colspan="3">Vs budget harian</th><th colspan="2">Growth</th><th colspan="2">Aktual vs Budget</th>' +
    '<th rowspan="2">Restan<br>(ton)</th><th colspan="2">Pusingan (Ha)</th><th rowspan="2">% HKE<br>Panen</th>' +
    '<th colspan="3">Luas panen (Ha)</th><th rowspan="2">Ancak tdk<br>selesai (Ha)</th><th colspan="2">TBS di PKS</th>' +
    '<th rowspan="2">AKP</th><th rowspan="2">Faktor penyebab</th></tr>' +
    '<tr><th>HL</th><th>HI</th><th>Var</th><th>sd Hi</th><th>Budget</th><th>Gap</th><th>Capaian</th>' +
    '<th>Bi</th><th>SdBi</th><th>Bi</th><th>SdBi</th><th>48R</th><th>36R</th>' +
    '<th>Normal</th><th>Aktual</th><th>Var</th><th>&lt;18</th><th>≥18</th></tr></thead>';

  function xlRow(u, opts) {
    opts = opts || {};
    var cls = (opts.sum ? 'sum ' : '') + (opts.click ? 'click' : '');
    var showF = !opts.sum && (u.gap < 0 || u.var_hl < 0);
    return '<tr class="' + cls + '"' + (opts.click ? ' data-u="' + esc(u.unit) + '"' : '') + '>' +
      '<td>' + esc(u.unit) + (opts.click ? ' ›' : '') + '</td>' +
      '<td class="num">' + f0(u.luas) + '</td>' +
      '<td class="num">' + f0(u.prod_hl) + '</td>' +
      '<td class="num"><b>' + f0(u.prod_hi) + '</b></td>' +
      '<td class="num ' + (u.var_hl < 0 ? 'neg' : 'pos') + '">' + sgn(u.var_hl) + '</td>' +
      '<td class="num">' + f0(u.sd_hi) + '</td>' +
      '<td class="num">' + f0(u.budget_harian) + '</td>' +
      '<td class="num ' + (u.gap < 0 ? 'neg' : 'pos') + '">' + sgn(u.gap) + '</td>' +
      '<td class="num ' + cAch(u.ach_harian) + '">' + pct(u.ach_harian) + '</td>' +
      '<td class="num ' + cGrowth(u.growth_bi) + '">' + pct(u.growth_bi) + '</td>' +
      '<td class="num ' + cGrowth(u.growth_sdbi) + '">' + pct(u.growth_sdbi) + '</td>' +
      '<td class="num ' + cAch(u.ach_bi) + '">' + pct(u.ach_bi) + '</td>' +
      '<td class="num ' + cAch(u.ach_sdbi) + '">' + pct(u.ach_sdbi) + '</td>' +
      '<td class="num">' + dash(u.restan, f0) + '</td>' +
      '<td class="num">' + dash(u.p48r, f0) + '</td>' +
      '<td class="num">' + dash(u.p36r, f0) + '</td>' +
      '<td class="num ' + cHke(u.hke_pct) + '">' + f1(u.hke_pct) + '</td>' +
      '<td class="num">' + f0(u.ha_normal) + '</td>' +
      '<td class="num">' + f0(u.ha_aktual) + '</td>' +
      '<td class="num ' + (u.ha_var < 0 ? 'neg' : '') + '">' + sgn(u.ha_var) + '</td>' +
      '<td class="num">' + dash(u.ancak, f0) + '</td>' +
      '<td class="num">' + pct(u.pks_lt18) + '</td>' +
      '<td class="num ' + (u.pks_ge18 > state.model.settings.PKS_GE18_MAX ? 't-bad' : '') + '">' + pct(u.pks_ge18) + '</td>' +
      '<td class="num">' + f1(u.akp) + '</td>' +
      '<td class="fk"><div class="chips">' + (showF ? chipsHtml(u.faktor) : '') + '</div></td></tr>';
  }

  function renderDrill() {
    var m = state.model, d = state.drill;
    if (d.estate && m.by[d.estate]) return renderEstate(m.by[d.estate]);

    var crumb = '<div class="crumb"><button data-c="root">BGA</button>' +
      (d.region ? ' › <span>' + esc(d.region) + '</span>' : '') + '</div>';
    var body, judul, sumRows;

    if (d.region && m.by[d.region]) {
      var rg = m.by[d.region];
      judul = esc(d.region) + ' · ' + esc(rg.wilayah) + ' · ' + esc(rg.parent);
      sumRows = xlRow(rg, { sum: true });
      body = (m.children[d.region] || []).map(function (e) { return xlRow(e, { click: true }); }).join('');
    } else {
      var filters = ['Semua', 'Kalteng', 'Kalbar'].concat(m.mdo.map(function (x) { return x.unit; }));
      judul = 'Semua region';
      var regs = m.regions.filter(function (r) {
        return d.filter === 'Semua' || r.wilayah === d.filter || r.parent === d.filter;
      });
      var top = d.filter === 'Semua' ? [m.bga].concat(m.wilayah) : [m.by[d.filter]].filter(Boolean);
      sumRows = top.map(function (u) { return xlRow(u, { sum: true }); }).join('');
      body = regs.map(function (r) { return xlRow(r, { click: true }); }).join('');
      crumb += '<div class="filter-chips" id="fDrill" style="margin-bottom:10px">' + filters.map(function (f) {
        return '<button data-f="' + esc(f) + '" class="' + (d.filter === f ? 'active' : '') + '">' + esc(f) + '</button>';
      }).join('') + '</div>';
    }

    $('#view').innerHTML = crumb +
      '<div class="toolbar"><b style="font-size:15px">' + judul + '</b><span class="muted small">Klik baris untuk masuk lebih dalam</span>' +
      '<button class="btn ghost small" id="btnXls" style="margin-left:auto">Unduh Excel</button></div>' +
      '<div class="table-wrap"><table class="xl" id="xlTable">' + XL_HEAD + '<tbody>' + sumRows + body + '</tbody></table></div>';

    $$('[data-c="root"]').forEach(function (b) {
      b.addEventListener('click', function () { state.drill = { region: null, estate: null, filter: 'Semua' }; render(); });
    });
    var fd = $('#fDrill');
    if (fd) fd.addEventListener('click', function (e) {
      var f = e.target.getAttribute('data-f');
      if (!f) return;
      d.filter = f; render();
    });
    $$('#xlTable tr[data-u]').forEach(function (tr) {
      tr.addEventListener('click', function () {
        var u = m.by[tr.getAttribute('data-u')];
        if (u.level === 'REGION') d.region = u.unit;
        else d.estate = u.unit;
        render();
        window.scrollTo(0, 0);
      });
    });
    $('#btnXls').addEventListener('click', function () {
      if (!window.XLSX) return toast('Pustaka Excel belum termuat.', true);
      var wb = window.XLSX.utils.table_to_book($('#xlTable'), { sheet: 'Laporan' });
      window.XLSX.writeFile(wb, 'LH Produksi ' + (d.region || 'BGA') + ' ' + m.tanggal + '.xlsx');
    });
  }

  function renderEstate(e) {
    var m = state.model;
    var seri = m.series[e.unit] || [];
    var tile = function (l, v, bad) { return '<div class="tile' + (bad ? ' bad' : '') + '"><div class="l">' + esc(l) + '</div><div class="v num">' + v + '</div></div>'; };
    var S = m.settings;

    $('#view').innerHTML =
      '<div class="crumb"><button data-c="root">BGA</button> › <button data-c="reg">' + esc(e.parent) + '</button> › <span>' + esc(e.unit) + '</span></div>' +
      '<div class="lead"><b>' + esc(e.unit) + '</b> (' + esc(e.parent) + ', ' + esc(e.wilayah) + ') hari ini <b>' + f0(e.prod_hi) + ' ton</b>, ' +
      pct(e.ach_harian) + ' dari budget harian ' + f0(e.budget_harian) + ' ton (gap <span class="' + (e.gap < 0 ? 'neg' : 'pos') + '">' + sgn(e.gap) + ' ton</span>); ' +
      (e.var_hl < 0 ? 'turun ' : 'naik ') + f0(Math.abs(e.var_hl)) + ' ton dari kemarin.' +
      (e.shareGap > 0 ? ' Menyumbang ' + pct(e.shareGap) + ' dari kekurangan ' + esc(e.parent) + '.' : '') + '</div>' +
      '<div class="grid g2">' +
        '<div class="card"><div class="card-h">Tren produksi harian ' + esc(namaBulan(m.tanggal)) + '</div><div class="card-b"><div class="chart-box tall"><canvas id="chTrend"></canvas></div></div></div>' +
        '<div class="card"><div class="card-h">Faktor penyebab</div><div class="card-b"><div class="chips">' + chipsHtml(e.faktor, 'Tidak ada faktor operasional menonjol') + '</div>' +
          '<div class="tiles" style="margin-top:14px">' +
            tile('% HKE panen', f1(e.hke_pct) + '%', e.hke_pct > 0 && e.hke_pct < S.HKE_MIN) +
            tile('Ha panen normal', f0(e.ha_normal)) +
            tile('Ha panen aktual', f0(e.ha_aktual), e.ha_var < 0) +
            tile('AKP hari ini', f1(e.akp), e.faktor.some(function (f) { return f.key === 'akp' || f.key === 'akpdrop'; })) +
            tile('AKP rata² bulan', f1(e.akp_rata_bulan)) +
            tile('Ancak tdk selesai', dash(e.ancak, f0) + (e.ancak > 0.5 ? ' Ha' : ''), e.ancak > 0.5) +
            tile('Pusingan 48R / 36R', dash(e.p48r, f0) + ' / ' + dash(e.p36r, f0), (e.p48r || 0) + (e.p36r || 0) > 0.5) +
            tile('Restan', dash(e.restan, f0) + (e.restan > 0.5 ? ' t' : ''), e.restan > 0.5) +
            tile('TBS di PKS ≥18.00', pct(e.pks_ge18), e.pks_ge18 > S.PKS_GE18_MAX) +
            tile('Capaian s.d. hari ini', pct(e.ach_bi)) +
            tile('Growth s.d. hari ini', pct(e.growth_bi)) +
            tile('Capaian s.d. bulan', pct(e.ach_sdbi)) +
          '</div></div></div>' +
      '</div>' +
      '<div class="table-wrap" style="margin-top:14px"><table class="xl">' + XL_HEAD + '<tbody>' + xlRow(m.by[e.parent], { sum: true }) + xlRow(e) + '</tbody></table></div>';

    $('[data-c="root"]').addEventListener('click', function () { state.drill = { region: null, estate: null, filter: 'Semua' }; render(); });
    $('[data-c="reg"]').addEventListener('click', function () { state.drill.estate = null; render(); });

    newChart($('#chTrend'), {
      type: 'bar',
      data: {
        labels: seri.map(function (s) { return Number(s.tanggal.slice(8)); }),
        datasets: [
          { type: 'bar', label: 'Produksi (ton)', data: seri.map(function (s) { return Math.round(s.ton); }),
            backgroundColor: seri.map(function (s) { return s.tanggal === m.tanggal ? '#0c4a24' : '#7fbf8a'; }), borderRadius: 3, order: 2 },
          { type: 'line', label: 'Budget harian', data: seri.map(function () { return Math.round(e.budget_harian); }),
            borderColor: '#d7261e', borderDash: [5, 4], borderWidth: 2, pointRadius: 0, order: 1 }
        ]
      },
      options: Object.assign(baseOpts({ fmt: f0, legend: true, yTitle: 'Ton', noLabels: seri.length > 12 }), {})
    });
  }

  // =================================================================
  // 4) ADMIN
  // =================================================================
  function renderAdmin() {
    if (!state.session || state.session.role !== 'Admin') { setView('ringkasan'); return; }
    var a = state.admin;
    var html = '<div class="grid g2">' +
      '<div class="card" style="grid-column:1/-1"><div class="card-h">Upload data harian</div><div class="card-b">' +
        '<label class="drop" id="drop"><input type="file" id="fileIn" accept=".xlsx,.xlsm">' +
        '<b>Pilih atau seret file "LH Produksi BGA" (.xlsx)</b><div class="small muted" style="margin-top:6px">File dibaca di browser ini; yang dikirim ke server hanya angka hasil bacaan (dan arsip file bila dicentang).</div></label>' +
        '<div id="preview">' + (a.parsed ? previewHtml() : '') + '</div>' +
      '</div></div>' +
      '<div class="card"><div class="card-h">Pengguna &amp; PIN</div><div class="card-b" id="usersBox">' + loadingHtml('Memuat pengguna…') + '</div></div>' +
      '<div class="card"><div class="card-h">Riwayat upload</div><div class="card-b" id="logBox">' + loadingHtml('Memuat riwayat…') + '</div></div>' +
      '</div>';
    $('#view').innerHTML = html;
    bindUpload();
    if (a.parsed) bindPreview();
    loadUsers();
    loadLog();
  }

  function bindUpload() {
    var drop = $('#drop'), inp = $('#fileIn');
    inp.addEventListener('change', function () { if (inp.files[0]) readFile(inp.files[0]); });
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('drag'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('drag'); });
    });
    drop.addEventListener('drop', function (e) {
      var f = e.dataTransfer.files[0];
      if (f) readFile(f);
    });
  }

  function readFile(file) {
    var a = state.admin;
    $('#preview').innerHTML = loadingHtml('Membaca ' + file.name + '…');
    var fr = new FileReader();
    fr.onload = function () {
      try {
        a.file = { name: file.name, buf: fr.result };
        a.wb = window.XLSX.read(new Uint8Array(fr.result), { type: 'array' });
        parseNow();
      } catch (err) {
        $('#preview').innerHTML = '<div class="warn-box"><b>Gagal membaca file.</b> ' + esc(err.message) + '</div>';
      }
    };
    fr.onerror = function () { $('#preview').innerHTML = '<div class="warn-box">File tidak bisa dibaca.</div>'; };
    fr.readAsArrayBuffer(file);
  }

  function parseNow(tglOverride) {
    var a = state.admin;
    try {
      a.parsed = window.LHPParser.parseWorkbook(a.wb, tglOverride);
      var regions = (state.reports[state.tanggal] && state.reports[state.tanggal].regions) || DEFAULT_REGIONS;
      var settings = state.reports[state.tanggal] ? state.reports[state.tanggal].settings : {};
      a.model = A.build({ tanggal: a.parsed.tanggal, rows: a.parsed.rows, series: a.parsed.series, regions: regions, settings: settings });
      a.sorotan = a.model.sorotanAuto.slice();
      $('#preview').innerHTML = previewHtml();
      bindPreview();
    } catch (err) {
      $('#preview').innerHTML = '<div class="warn-box"><b>File tidak sesuai.</b> ' + esc(err.message) + '</div>' +
        (/Tanggal/.test(err.message) ? '<div class="form-row"><label>Tanggal laporan<input type="date" id="tglManual"></label><button class="btn small" id="btnTgl">Baca ulang</button></div>' : '');
      var bt = $('#btnTgl');
      if (bt) bt.addEventListener('click', function () { var v = $('#tglManual').value; if (v) parseNow(v); });
    }
  }

  function previewHtml() {
    var a = state.admin, p = a.parsed, b = a.model.bga;
    var sudahAda = state.dates.indexOf(p.tanggal) >= 0;
    return '<div class="form-row"><label>Tanggal laporan<input type="date" id="tglPrev" value="' + p.tanggal + '"></label>' +
      '<div class="small muted">' + esc(tglPanjang(p.tanggal)) + ' · HKE ' + esc(namaBulan(p.tanggal)) + ': ' + p.info.hke + ' hari</div></div>' +
      (sudahAda ? '<div class="warn-box">Data tanggal ini <b>sudah pernah dipublish</b>. Publish ulang akan <b>menimpa</b> data lama.</div>' : '') +
      '<div class="tiles">' +
        '<div class="tile"><div class="l">Estate terbaca</div><div class="v">' + p.info.estate + '</div></div>' +
        '<div class="tile"><div class="l">Region terbaca</div><div class="v">' + p.info.region + '</div></div>' +
        '<div class="tile"><div class="l">Produksi BGA HI (ton)</div><div class="v num">' + f0(b.prod_hi) + '</div></div>' +
        '<div class="tile"><div class="l">Budget harian (ton)</div><div class="v num">' + f0(b.budget_harian) + '</div></div>' +
        '<div class="tile' + (b.gap < 0 ? ' bad' : '') + '"><div class="l">Gap (ton)</div><div class="v num">' + sgn(b.gap) + '</div></div>' +
        '<div class="tile"><div class="l">Capaian harian</div><div class="v">' + pct(b.ach_harian) + '</div></div>' +
      '</div>' +
      (p.warnings.length ? '<div class="warn-box"><b>' + p.warnings.length + ' peringatan</b> — periksa sebelum publish:<ul>' +
        p.warnings.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul></div>'
        : '<div class="ok-box">✔ Tidak ada peringatan. Total estate cocok dengan baris BGA dan region.</div>') +
      '<label class="small muted" for="sorText" style="display:block;margin-top:10px">Sorotan utama (satu poin per baris, boleh diedit)</label>' +
      '<textarea class="sor" id="sorText">' + esc(a.sorotan.join('\n')) + '</textarea>' +
      '<div class="form-row" style="justify-content:space-between">' +
        '<label style="flex-direction:row;align-items:center;gap:6px;color:var(--ink)"><input type="checkbox" id="arsipChk"' + (a.arsip ? ' checked' : '') + '> Arsipkan file Excel ke Google Drive</label>' +
        '<button class="btn" id="btnPublish">Publish data ' + esc(p.tanggal) + '</button></div>';
  }

  function bindPreview() {
    var a = state.admin;
    $('#tglPrev').addEventListener('change', function () { if (this.value) parseNow(this.value); });
    $('#arsipChk').addEventListener('change', function () { a.arsip = this.checked; });
    $('#sorText').addEventListener('input', function () { a.sorotan = this.value.split('\n'); });
    $('#btnPublish').addEventListener('click', publish);
  }

  function toBase64(buf) {
    var bytes = new Uint8Array(buf), bin = '', chunk = 0x8000;
    for (var i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function publish() {
    var a = state.admin, p = a.parsed;
    var btn = $('#btnPublish');
    btn.disabled = true;
    btn.textContent = 'Mengirim…';
    var payload = {
      tanggal: p.tanggal,
      rows: p.rows,
      series: p.series,
      warnings: p.warnings,
      sorotan: ($('#sorText').value || '').split('\n').map(function (s) { return s.trim(); }).filter(Boolean)
    };
    if (a.arsip && a.file) payload.file = { name: a.file.name, base64: toBase64(a.file.buf) };
    api('publish', payload).then(function (res) {
      toast('✔ Data ' + res.tanggal + ' berhasil dipublish.');
      delete state.reports[res.tanggal];
      a.parsed = null; a.wb = null; a.file = null;
      return api('getDates').then(function (dates) {
        state.dates = dates || [];
        fillDates();
        state.view = 'ringkasan';
        $$('#tabs button').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-view') === 'ringkasan'); });
        loadReport(res.tanggal);
      });
    }).catch(function (err) {
      toast('Gagal publish: ' + err.message, true);
      btn.disabled = false;
      btn.textContent = 'Publish data ' + p.tanggal;
    });
  }

  function loadUsers() {
    api('listUsers').then(function (users) {
      var box = $('#usersBox');
      if (!box) return;
      box.innerHTML = '<table class="simple"><thead><tr><th>Nama</th><th>Peran</th><th>Status</th><th></th></tr></thead><tbody>' +
        users.map(function (u) {
          return '<tr><td>' + esc(u.nama) + '</td><td>' + esc(u.role) + '</td><td>' + (u.aktif ? 'Aktif' : '<span class="neg">Nonaktif</span>') + '</td>' +
            '<td style="text-align:right;white-space:nowrap"><button class="btn ghost small" data-pin="' + esc(u.id) + '">Ganti PIN</button> ' +
            '<button class="btn ghost small" data-akt="' + esc(u.id) + '">' + (u.aktif ? 'Nonaktifkan' : 'Aktifkan') + '</button></td></tr>';
        }).join('') + '</tbody></table>' +
        '<div class="form-row"><label>Nama<input id="uNama" placeholder="mis. RH Reg 3"></label>' +
        '<label>Peran<select id="uRole"><option>Viewer</option><option>Admin</option></select></label>' +
        '<label>PIN (4–8 angka)<input id="uPin" inputmode="numeric" maxlength="8"></label>' +
        '<button class="btn small" id="uAdd">Tambah</button></div>' +
        '<div class="small muted">PIN disimpan dalam bentuk hash; tidak bisa dilihat ulang. Satu PIN hanya untuk satu pengguna.</div>';
      var byId = {};
      users.forEach(function (u) { byId[u.id] = u; });
      $('#uAdd').addEventListener('click', function () {
        saveUser({ nama: $('#uNama').value, role: $('#uRole').value, pin: $('#uPin').value });
      });
      $$('[data-pin]', box).forEach(function (b) {
        b.addEventListener('click', function () {
          var u = byId[b.getAttribute('data-pin')];
          var pin = window.prompt('PIN baru untuk ' + u.nama + ' (4–8 angka):');
          if (pin) saveUser({ id: u.id, nama: u.nama, role: u.role, aktif: u.aktif, pin: pin });
        });
      });
      $$('[data-akt]', box).forEach(function (b) {
        b.addEventListener('click', function () {
          var u = byId[b.getAttribute('data-akt')];
          saveUser({ id: u.id, nama: u.nama, role: u.role, aktif: !u.aktif });
        });
      });
    }).catch(function (err) {
      var box = $('#usersBox');
      if (box) box.innerHTML = '<div class="neg">' + esc(err.message) + '</div>';
    });
  }

  function saveUser(d) {
    api('saveUser', d).then(function () {
      toast('✔ Tersimpan.');
      loadUsers();
    }).catch(function (err) { toast(err.message, true); });
  }

  function loadLog() {
    api('getLog').then(function (log) {
      var box = $('#logBox');
      if (!box) return;
      box.innerHTML = log.length ? '<table class="simple"><thead><tr><th>Tanggal data</th><th>Dipublish</th><th>Oleh</th><th>Catatan</th></tr></thead><tbody>' +
        log.map(function (l) {
          return '<tr><td>' + esc(l.tanggal) + '</td><td class="small">' + esc(new Date(l.waktu).toLocaleString('id-ID')) + '</td><td>' + esc(l.oleh) + '</td><td class="small">' + esc(l.catatan) + '</td></tr>';
        }).join('') + '</tbody></table>' : '<div class="muted">Belum ada upload.</div>';
    }).catch(function (err) {
      var box = $('#logBox');
      if (box) box.innerHTML = '<div class="neg">' + esc(err.message) + '</div>';
    });
  }

  // =================================================================
  // MULAI
  // =================================================================
  var saved = load(TOKEN_KEY);
  if (saved && saved.token && saved.exp > Date.now()) {
    state.session = saved;
    startApp();
  } else {
    showLogin();
  }
})();
