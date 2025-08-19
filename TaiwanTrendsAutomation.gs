// ===== Taiwan Trends → Weekly/Monthly Ideas Automation (Google Apps Script) =====
// Author: Medelin + ChatGPT
// Schedule: Mon 08:00, Wed 09:00 (Asia/Taipei)
// Outputs: Email to ksi.medelin@gmail.com + Google Sheet logs
// Notes: Set Script Properties -> GEMINI_API_KEY (required), RECIPIENT_EMAIL (optional)

/***** CONFIG *****/
const CONFIG = {
  GEO: 'TW',                 // Taiwan
  HL: 'zh-TW',               // Traditional Chinese
  IDEAS_PER_TREND: 5,        // >= 5 ideas per topic
  WEEKLY_TOP_N: 3,           // pick top N from last 7 days
  MONTHLY_TOP_N: 3,          // pick top N from last 30 days
  EMAIL_SUBJECT_PREFIX: '台灣科技趨勢內容靈感（週/月＋通用話題）',
  OUTPUT_LANG: 'zh-TW',
  WRITE_TO_SHEET: true,
  HARVEST_SHEET: 'TrendsHarvest', // raw realtime log
  IDEAS_SHEET: 'TrendIdeasLog',   // ideas archive

  // Add any extra RSS feeds you like (tech news, alerts, etc.). May be empty.
  EXTRA_RSS: [
    // 'https://www.cwb.gov.tw/rss/forecast/36_08.xml', // CWB alerts example
    // 'https://news.google.com/rss/search?q=SaaS%20Taiwan&hl=zh-TW&gl=TW&ceid=TW:zh-Hant',
    // 'https://feeds.feedburner.com/TechOrange',
  ],

  // Always-available seeds (evergreen reminders)
  MANUAL_SEEDS: [
    '防詐騙提醒（釣魚簡訊與假投資）',
    '雲端資安健檢（兩步驟驗證＆密碼管理）',
    'AI 在餐飲/零售的實用案例'
  ],

  // Max distinct topics per email (mixed from realtime + RSS + cues + seeds)
  MAX_EMAIL_TOPICS: 6,

  // Soft priority keywords to bubble tech-ish topics earlier
  TECH_PRIORITY_KEYWORDS: ['AI','雲端','SaaS','FinTech','電商','資安','5G','晶片','半導體','遊戲','硬體','自動化']
};

const DEFAULT_RECIPIENT = 'ksi.medelin@gmail.com';

// System brief (tone + audience + domains)
const SYSTEM_BRIEF = `
You are a social media content expert specializing in technology and SaaS content for the Taiwan market. Create engaging, culturally relevant content that resonates with Taiwan's tech community. Focus on trends that are popular in Taiwan's technology sector including AI, fintech, e-commerce, gaming, and hardware innovation. Make the content informative yet engaging, suitable for both Facebook and Instagram audiences.
`;

/***** SCHEDULING *****/
// Run once to install triggers: Monday 08:00 and Wednesday 09:00 (Asia/Taipei)
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(tr => ScriptApp.deleteTrigger(tr));
  ScriptApp.newTrigger('runWeeklyMonthly')
    .timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(8).create();
  ScriptApp.newTrigger('runWeeklyMonthly')
    .timeBased().onWeekDay(ScriptApp.WeekDay.WEDNESDAY).atHour(9).create();
}
// Manual test
function runNowOnce(){ runWeeklyMonthly(); }

/***** MAIN *****/
function runWeeklyMonthly() {
  const props = PropertiesService.getScriptProperties();
  const API_KEY = props.getProperty('GEMINI_API_KEY');
  if (!API_KEY) throw new Error('Missing GEMINI_API_KEY in Script properties.');
  const RECIPIENT = props.getProperty('RECIPIENT_EMAIL') || DEFAULT_RECIPIENT;

  // 1) Harvest realtime trends (Google Trends → Realtime RSS)
  const realtime = fetchRealtimeTrends(CONFIG.GEO, CONFIG.HL);
  if (CONFIG.WRITE_TO_SHEET) harvestLog_(realtime);

  // 2) Weekly / Monthly from our harvest history
  const weekly  = topTrendsFromHarvest_(7,  CONFIG.WEEKLY_TOP_N);
  const monthly = topTrendsFromHarvest_(30, CONFIG.MONTHLY_TOP_N);

  // 3) Mixed candidates for THIS run (always produce content)
  const mixedCandidates = buildCandidateTopics_(realtime.map(r => r.keyword));

  const weeklyIdeas = weekly.length
    ? weekly.map(tr => ({ trend: tr, ideas: generateIdeasFor_(tr.keyword) }))
    : mixedCandidates.slice(0, Math.min(3, mixedCandidates.length))
        .map(k => ({ trend: { keyword: k, hits: 1 }, ideas: generateIdeasFor_(k) }));

  const monthlyIdeas = monthly.length
    ? monthly.map(tr => ({ trend: tr, ideas: generateIdeasFor_(tr.keyword) }))
    : mixedCandidates.slice(3, Math.min(6, mixedCandidates.length))
        .map(k => ({ trend: { keyword: k, hits: 1 }, ideas: generateIdeasFor_(k) }));

  // 4) Email
  const subject = `${CONFIG.EMAIL_SUBJECT_PREFIX} · ${formatDate_(new Date())}`;
  const html = renderEmailHtml_(weeklyIdeas, monthlyIdeas);
  MailApp.sendEmail({ to: RECIPIENT, subject, htmlBody: html });

  // 5) Archive ideas
  if (CONFIG.WRITE_TO_SHEET) appendIdeas_(weeklyIdeas, monthlyIdeas, subject);
}

/***** FETCH: Realtime Trends RSS *****/
// Example: https://trends.google.com/trends/trendingsearches/realtime/rss?geo=TW&hl=zh-TW&cat=all
function fetchRealtimeTrends(geo, hl, cat='all') {
  const url = `https://trends.google.com/trends/trendingsearches/realtime/rss?geo=${encodeURIComponent(geo)}&hl=${encodeURIComponent(hl)}&cat=${encodeURIComponent(cat)}`;
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) return [];
  const xml = res.getContentText();
  if (!xml) return [];
  const doc = XmlService.parse(xml);
  const channel = doc.getRootElement().getChild('channel');
  const items = channel ? (channel.getChildren('item') || []) : [];
  return items.map(item => {
    const title = getTextSafe_(item, 'title');
    const pubDate = getTextSafe_(item, 'pubDate') || '';
    const approxTraffic = getTextSafeNs_(item, 'ht', 'approx_traffic') || '';
    return { keyword: title, pubDate, approxTraffic, source: 'realtime' };
  }).filter(x => x.keyword);
}
function getTextSafe_(parent, tag) {
  const el = parent.getChild(tag);
  return el ? el.getText() : '';
}
function getTextSafeNs_(parent, prefix, local) {
  const ns = XmlService.getNamespace(prefix, 'http://www.google.com/trends/hottrends');
  const el = parent.getChild(local, ns);
  return el ? el.getText() : '';
}

/***** HARVEST LOG & LEADERBOARDS *****/
function getOrCreateSheet_(name) {
  const ss = SpreadsheetApp.getActive() || SpreadsheetApp.create('TrendAutomations');
  return ss.getSheetByName(name) || ss.insertSheet(name);
}
function harvestLog_(rows) {
  const sh = getOrCreateSheet_(CONFIG.HARVEST_SHEET);
  if (sh.getLastRow() === 0) sh.appendRow(['Timestamp','Keyword','ApproxTraffic','Source']);
  const ts = new Date();
  const data = rows.map(r => [ts, r.keyword, r.approxTraffic, r.source]);
  if (data.length) sh.getRange(sh.getLastRow()+1,1,data.length,4).setValues(data);
}
function topTrendsFromHarvest_(daysBack, topN) {
  const sh = getOrCreateSheet_(CONFIG.HARVEST_SHEET);
  const lastRow = sh.getLastRow();
  if (lastRow <= 1) return [];
  const values = sh.getRange(2,1,lastRow-1,4).getValues(); // Timestamp, Keyword, Traffic, Source
  const cutoff = Date.now() - daysBack*24*3600*1000;
  const freq = new Map();
  const maxTraffic = new Map();
  values.forEach(([ts, kw, traffic]) => {
    const t = (ts instanceof Date) ? ts.getTime() : new Date(ts).getTime();
    if (!kw || isNaN(t) || t < cutoff) return;
    const k = String(kw).trim();
    freq.set(k, 1 + (freq.get(k)||0));
    const numericTraffic = parseTraffic_(traffic);
    if (!isNaN(numericTraffic)) {
      maxTraffic.set(k, Math.max(numericTraffic, maxTraffic.get(k)||0));
    }
  });
  const ranked = [...freq.entries()]
    .map(([k, f]) => ({ keyword: k, hits: f, score: f*1000 + (maxTraffic.get(k)||0) }))
    .sort((a,b) => b.score - a.score)
    .slice(0, topN);
  return ranked;
}
function parseTraffic_(s) {
  if (!s) return NaN;
  const n = String(s).replace(/[+,]/g,'').toUpperCase();
  if (n.endsWith('K')) return parseFloat(n)*1000;
  if (n.endsWith('M')) return parseFloat(n)*1e6;
  return parseFloat(n);
}

/***** TOPIC BUILDER: realtime + RSS + cues + seeds *****/
function buildCandidateTopics_(realtimeKeywords) {
  const now = new Date();
  const cues = taiwanDateCues_(now);
  const extras = fetchExtraRssTitles_();
  const seeds  = CONFIG.MANUAL_SEEDS || [];
  const pool = []
    .concat(realtimeKeywords || [])
    .concat(extras || [])
    .concat(cues || [])
    .concat(seeds || []);
  // dedup
  const dedup = [];
  const seen = new Set();
  pool.map(s => String(s || '').trim()).forEach(s => {
    if (!s) return;
    if (seen.has(s)) return;
    seen.add(s);
    dedup.push(s);
  });
  // soft priority for tech-ish keywords
  const priority = (kw) => CONFIG.TECH_PRIORITY_KEYWORDS.some(t => kw.includes(t));
  const prioritized = dedup.sort((a,b) => (priority(b) - priority(a)));
  return prioritized.slice(0, CONFIG.MAX_EMAIL_TOPICS);
}
function fetchExtraRssTitles_() {
  const urls = CONFIG.EXTRA_RSS || [];
  const titles = [];
  urls.forEach(url => {
    try {
      const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (res.getResponseCode() !== 200) return;
      const doc = XmlService.parse(res.getContentText());
      const channel = doc.getRootElement().getChild('channel');
      const items = channel ? channel.getChildren('item') : [];
      (items || []).slice(0, 5).forEach(item => {
        const t = item.getChild('title')?.getText();
        if (t) titles.push(String(t).trim());
      });
    } catch (e) { /* ignore */ }
  });
  return titles;
}
function taiwanDateCues_(now) {
  const arr = [];
  const m = now.getMonth() + 1; // 1–12
  const d = now.getDate();
  if (m >= 7 && m <= 10) {
    arr.push('颱風季備案：企業備援與資料備份（UPS/雲端備援/異地備份）');
    arr.push('颱風前後社群貼文：營業時間調整與外送/到店安全提醒');
  }
  const isOdd = (m % 2 === 1);
  if (isOdd && d >= 22 && d <= 27) {
    arr.push('統一發票中獎號碼公布提醒：如何用雲端發票與工具快速對獎');
  }
  if (d <= 3 || d >= 28) {
    arr.push('月初/月底資安檢查：權限盤點、雙重驗證、備份演練');
  }
  arr.push('防詐騙提醒：假投資與釣魚簡訊（含 LINE 與 FB 粉專冒名）');
  arr.push('熱門歌單/短影音趨勢：如何套用到品牌貼文的 Hook 與節奏');
  return arr;
}

/***** AI (Gemini) *****/
function generateIdeasFor_(keyword) {
  const props = PropertiesService.getScriptProperties();
  const apiKey = props.getProperty('GEMINI_API_KEY');
  const model = 'gemini-1.5-flash-latest';
  const prompt = [
    SYSTEM_BRIEF.trim(),
    `語言：${CONFIG.OUTPUT_LANG}`,
    `任務：以台灣趨勢關鍵字「${keyword}」為主題，產出至少 ${CONFIG.IDEAS_PER_TREND} 則社群貼文構想，適用 Facebook 與 Instagram。`,
    `每則請單行輸出（避免代碼區塊），並包含以下欄位：`,
    `Title：7~14字吸睛標題｜Description：2~3句、具行動力與互動引導｜Hashtags：3~6個 #繁中｜WhyRelevant：1句，說明與台灣科技/SaaS社群的關聯（AI/FinTech/電商/遊戲/硬體創新）。`,
    `Category：請在 Tech／Civic／Entertainment／Other 四類中選最適合的類別`,
    `SuggestedCTA：一句明確的行動呼籲，鼓勵互動或 SaaS 工具嘗試（如「留言分享你的看法」、「立即試用雲端工具」、「轉發提醒好友」等）`,
    `限制：避免誇大與醫療宣稱；避免政治與仇恨；語氣專業且有熱情。`,
    `輸出格式範例：`,
    `- Idea 1｜Title：...｜Description：...｜Hashtags：#...｜WhyRelevant：...｜Category：Tech｜SuggestedCTA：...`
  ].join('\n');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const payload = { contents: [{ parts: [{ text: prompt }]}] };
  const res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  const safeFail = () => [{
    Title: '[AI錯誤]', Description: '無法生成內容', Hashtags: '#錯誤', WhyRelevant: '請檢查API或配額', Category: 'Other', SuggestedCTA: '回覆此郵件以協助除錯'
  }];
  if (res.getResponseCode() !== 200) return safeFail();
  const data = JSON.parse(res.getContentText());
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const lines = text.split('\n').filter(l => l.trim().startsWith('-'));
  const ideas = lines.map(parseIdeaLine_).filter(Boolean);
  return ideas.slice(0, Math.max(CONFIG.IDEAS_PER_TREND, 5)) || safeFail();
}
function parseIdeaLine_(line) {
  try {
    const normalized = line.replace(/^-\s*Idea\s*\d+\s*[|｜]?\s*/i, '');
    const parts = normalized.split(/[|｜]/).map(s => s.trim());
    const Title = pickField_(parts, 'Title') || '';
    const Description = pickField_(parts, 'Description') || '';
    const Hashtags = (pickField_(parts, 'Hashtags') || '').replace(/\s+/g,' ').trim();
    const WhyRelevant = pickField_(parts, 'WhyRelevant') || '';
    const Category = pickField_(parts, 'Category') || 'Other';
    const SuggestedCTA = pickField_(parts, 'SuggestedCTA') || '';
    if (!Title && !Description) return null;
    return { Title, Description, Hashtags, WhyRelevant, Category, SuggestedCTA };
  } catch(e){ return null; }
}
function pickField_(parts, label) {
  const p = parts.find(s => s.startsWith(`${label}：`) || s.startsWith(`${label}:`));
  if (!p) return '';
  return p.replace(`${label}：`, '').replace(`${label}:`, '').trim();
}

/***** EMAIL RENDER *****/
function renderEmailHtml_(weeklyIdeas, monthlyIdeas) {
  const css = `
  <style>
    body{margin:0;padding:0;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111;}
    .wrap{max-width:900px;margin:0 auto;padding:16px;background:#f6f7f9;}
    .card{background:#fff;border:1px solid #eceff3;border-radius:12px;margin:12px 0;overflow:hidden;}
    .hd{padding:14px 16px;border-bottom:1px solid #eceff3;font-weight:700}
    .bd{padding:12px 16px;}
    .meta{color:#6b7280;font-size:12px;margin-bottom:8px}
    .idea{padding:10px 0;border-top:1px dashed #eceff3;}
    .title{font-weight:700}
    .desc{margin:6px 0}
    .tags{color:#374151;font-size:13px}
    .why{color:#6b7280;font-size:12px;margin-top:4px}
    .foot{color:#6b7280;font-size:12px;padding:12px 16px}
    @media (prefers-color-scheme: dark){
      body{background:#0b0b0c;color:#eee}
      .wrap{background:#0b0b0c}
      .card{background:#121316;border-color:#2a2b2f}
      .hd{border-color:#2a2b2f}
      .meta{color:#9aa0a6}
      .why,.foot{color:#9aa0a6}
    }
  </style>`;

  const section = (title, rows) => `
    <div class="card">
      <div class="hd">${title}</div>
      <div class="bd">
        ${rows.map(({trend, ideas}) => `
          <div style="margin:10px 0 6px;font-weight:700">🔥 趨勢：${escapeHtml_(trend.keyword)}${trend.hits ? '（命中：'+trend.hits+'）' : ''}</div>
          ${ideas.map(i => `
            <div class="idea">
              <div class="title">• ${escapeHtml_(i.Title)}</div>
              <div class="desc">${escapeHtml_(i.Description)}</div>
              <div class="tags">${escapeHtml_(i.Hashtags)}</div>
              <div class="why">為何相關：${escapeHtml_(i.WhyRelevant)}</div>
              <div class="meta">分類：${escapeHtml_(i.Category)} ｜ CTA：${escapeHtml_(i.SuggestedCTA)}</div>
            </div>`).join('')}
        `).join('')}
      </div>
    </div>`;

  const weeklyBlock = weeklyIdeas.length ? section('📈 本週熱搜關鍵字（7日匯總／或即時替代）', weeklyIdeas) : '';
  const monthlyBlock = monthlyIdeas.length ? section('🗓️ 本月熱搜關鍵字（30日匯總／或即時替代）', monthlyIdeas) : '';

  return `
    ${css}
    <div class="wrap">
      <div class="card">
        <div class="hd">📬 ${CONFIG.EMAIL_SUBJECT_PREFIX} · ${formatDate_(new Date())}</div>
        <div class="bd">
          <div class="meta">來源：Google Trends（Realtime RSS 累積）｜ 語言：${escapeHtml_(CONFIG.OUTPUT_LANG)}</div>
          <p style="margin:8px 0 0">每則包含 Title／Description／Hashtags／為何與台灣科技與SaaS社群相關／分類／建議CTA。</p>
        </div>
      </div>
      ${weeklyBlock}
      ${monthlyBlock}
      <div class="foot">自動產生 · 排程：週一08:00＋週三09:00（Asia/Taipei）</div>
    </div>`;
}

/***** IDEAS ARCHIVE *****/
function appendIdeas_(weeklyIdeas, monthlyIdeas, subject) {
  const sh = getOrCreateSheet_(CONFIG.IDEAS_SHEET);
  if (sh.getLastRow() === 0) {
    sh.appendRow(['Timestamp','Subject','WindowDays','Trend','Title','Description','Hashtags','WhyRelevant','Category','SuggestedCTA']);
  }
  const ts = formatDate_(new Date());
  const rows = [];
  weeklyIdeas.forEach(({trend, ideas}) => {
    ideas.forEach(i => rows.push([ts, subject, 7, trend.keyword, i.Title, i.Description, i.Hashtags, i.WhyRelevant, i.Category, i.SuggestedCTA]));
  });
  monthlyIdeas.forEach(({trend, ideas}) => {
    ideas.forEach(i => rows.push([ts, subject, 30, trend.keyword, i.Title, i.Description, i.Hashtags, i.WhyRelevant, i.Category, i.SuggestedCTA]));
  });
  if (rows.length) sh.getRange(sh.getLastRow()+1,1,rows.length,10).setValues(rows);
}

/***** UTILS *****/
function escapeHtml_(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function formatDate_(d){ return Utilities.formatDate(d, 'Asia/Taipei', 'yyyy/MM/dd HH:mm'); }
