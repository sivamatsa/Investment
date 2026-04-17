/**
 * OxyLoans Portfolio — Storage Manager
 * Supports: localStorage (always), JSONBin.io (cloud), Google Sheets (via Apps Script)
 * Auto-falls back through layers if a method fails.
 */

const STORAGE_KEY   = 'oxyloans_portfolio';
const SETTINGS_KEY  = 'oxyloans_settings';
const TS_KEY        = STORAGE_KEY + '_ts';

/* ─── SETTINGS ─────────────────────────────────────────────── */
function getSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { return {}; }
}
function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

/* ─── LOCAL STORAGE (always-on layer) ──────────────────────── */
const Local = {
  save(data) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      localStorage.setItem(TS_KEY, new Date().toISOString());
      return true;
    } catch (e) {
      console.warn('localStorage save failed:', e);
      return false;
    }
  },
  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  },
  timestamp() {
    return localStorage.getItem(TS_KEY) || null;
  }
};

/* ─── JSONBIN.IO LAYER ──────────────────────────────────────── */
const JsonBin = {
  BASE: 'https://api.jsonbin.io/v3',

  async save(data) {
    const s = getSettings();
    if (!s.jsonbinApiKey || !s.jsonbinBinId) return false;
    try {
      const r = await fetch(`${this.BASE}/b/${s.jsonbinBinId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Master-Key': s.jsonbinApiKey
        },
        body: JSON.stringify({ data, savedAt: new Date().toISOString() })
      });
      return r.ok;
    } catch (e) {
      console.warn('JSONBin save failed:', e);
      return false;
    }
  },

  async load() {
    const s = getSettings();
    if (!s.jsonbinApiKey || !s.jsonbinBinId) return null;
    try {
      const r = await fetch(`${this.BASE}/b/${s.jsonbinBinId}/latest`, {
        headers: { 'X-Master-Key': s.jsonbinApiKey }
      });
      if (!r.ok) return null;
      const json = await r.json();
      return json?.record?.data || null;
    } catch (e) {
      console.warn('JSONBin load failed:', e);
      return null;
    }
  },

  async createBin(apiKey, name = 'OxyLoans Portfolio') {
    try {
      const r = await fetch(`${this.BASE}/b`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Master-Key': apiKey,
          'X-Bin-Name': name,
          'X-Bin-Private': 'true'
        },
        body: JSON.stringify({ data: [], savedAt: new Date().toISOString() })
      });
      if (!r.ok) return null;
      const json = await r.json();
      return json?.metadata?.id || null;
    } catch { return null; }
  }
};

/* ─── GOOGLE SHEETS LAYER ───────────────────────────────────── */
const GSheets = {
  async save(data) {
    const s = getSettings();
    if (!s.gsheetsUrl) return false;
    try {
      await fetch(s.gsheetsUrl, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'save', data })
      });
      return true; // no-cors means we can't read response, assume ok
    } catch (e) {
      console.warn('GSheets save failed:', e);
      return false;
    }
  },

  async load() {
    const s = getSettings();
    if (!s.gsheetsUrl) return null;
    try {
      const url = s.gsheetsUrl + '?action=load&t=' + Date.now();
      const r = await fetch(url);
      if (!r.ok) return null;
      const json = await r.json();
      return json?.data || null;
    } catch (e) {
      console.warn('GSheets load failed:', e);
      return null;
    }
  }
};

/* ─── AUTO EXCEL BACKUP ─────────────────────────────────────── */
const ExcelBackup = {
  autoDownload: false,

  trigger(data) {
    const s = getSettings();
    if (!s.autoExcelBackup) return;
    this.download(data);
  },

  download(data) {
    if (typeof XLSX === 'undefined') {
      console.warn('XLSX library not loaded for backup');
      return;
    }
    try {
      const headers = [
        'Deal ID','Deal Name','Participated Amount','Days to End','Days to Receive IR',
        'IR Date Day','Monthly IR','Interest Received','Comments IR','IR Start Date',
        'IR End Date','Oxyloans Credit Amt','Invest Debit Amt','Interest Paid to Oxy',
        'Wallet Balance','Participated Date','ROI','Months','Total Interest to Receive',
        'Balance IR from Oxy','Deal Status','Payout Type','Deal Open Closed','Deal User ID','Name'
      ];
      const keys = [
        'dealId','dealName','participatedAmount','daysToEnd','daysToReceiveIR','irDateDay',
        'monthlyIR','interestReceived','commentsIR','irStartDate','irEndDate','oxyloansCreditAmt',
        'investDebitAmt','interestPaidToOxy','walletBalance','participatedDate','roi','months',
        'totalInterestToReceive','balanceIRFromOxy','dealStatus','payoutType','dealOpenClosed',
        'dealUserId','name'
      ];
      const rows = [headers, ...data.map(d => keys.map(k => d[k] ?? ''))];
      const ws   = XLSX.utils.aoa_to_sheet(rows);
      const wb   = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Portfolio');
      const ts = new Date().toISOString().slice(0, 10);
      XLSX.writeFile(wb, `OxyLoans_Backup_${ts}.xlsx`);
    } catch (e) {
      console.warn('Excel backup failed:', e);
    }
  }
};

/* ─── MAIN STORAGE API ──────────────────────────────────────── */
const Storage = {
  _listeners: [],

  onChange(fn) { this._listeners.push(fn); },
  _notify(data) { this._listeners.forEach(fn => fn(data)); },

  /** Load: JSONBin → GSheets → localStorage (whichever has data first) */
  async load() {
    // Always load localStorage first for instant display
    const local = Local.load();
    const s = getSettings();

    // If cloud configured, try to get fresher data
    if (s.jsonbinApiKey && s.jsonbinBinId) {
      const cloud = await JsonBin.load();
      if (cloud && Array.isArray(cloud) && cloud.length > 0) {
        // Use whichever is newer
        const cloudTs = cloud._ts || 0;
        const localTs = Local.timestamp() ? new Date(Local.timestamp()).getTime() : 0;
        const winner = (cloudTs > localTs) ? cloud : (local || cloud);
        Local.save(winner); // keep local in sync
        return winner;
      }
    }

    if (s.gsheetsUrl) {
      const cloud = await GSheets.load();
      if (cloud && Array.isArray(cloud) && cloud.length > 0) {
        Local.save(cloud);
        return cloud;
      }
    }

    return local || [];
  },

  /** Save to ALL configured layers */
  async save(data) {
    const ts = new Date().toISOString();
    const tagged = data.map(d => ({ ...d })); // shallow copy

    // 1. Always save locally first (instant)
    Local.save(tagged);

    // 2. Cloud saves (async, non-blocking)
    const s = getSettings();
    const results = { local: true, jsonbin: false, gsheets: false };

    if (s.jsonbinApiKey && s.jsonbinBinId) {
      results.jsonbin = await JsonBin.save(tagged);
    }
    if (s.gsheetsUrl) {
      results.gsheets = await GSheets.save(tagged);
    }

    // 3. Auto Excel backup
    ExcelBackup.trigger(tagged);

    this._notify(tagged);
    return results;
  },

  async clear() {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(TS_KEY);
    const s = getSettings();
    if (s.jsonbinApiKey && s.jsonbinBinId) {
      await JsonBin.save([]);
    }
    this._notify([]);
  },

  timestamp() {
    return Local.timestamp();
  },

  activeLayer() {
    const s = getSettings();
    if (s.jsonbinApiKey && s.jsonbinBinId) return 'jsonbin';
    if (s.gsheetsUrl) return 'gsheets';
    return 'local';
  }
};

/* ─── STORAGE STATUS BADGE ──────────────────────────────────── */
function renderStorageBadge(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  const layer = Storage.activeLayer();
  const icons  = { local: '💾', jsonbin: '☁️', gsheets: '📊' };
  const labels = { local: 'Local Only', jsonbin: 'Cloud Sync', gsheets: 'Google Sheets' };
  const colors = { local: '#c9a84c', jsonbin: '#00c9a7', gsheets: '#4c9be8' };
  el.innerHTML = `<span style="display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:20px;font-size:11px;font-weight:600;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.1);color:${colors[layer]};cursor:pointer" onclick="window.location='storage-setup.html'" title="Configure Storage">
    ${icons[layer]} ${labels[layer]} ⚙
  </span>`;
}
