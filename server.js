// 한국투자증권 Open API 프록시 서버
// 역할: 앱키/시크릿을 안전하게 서버에만 보관하고, 토큰 발급/갱신을 대신 처리해서
//       휴대폰 웹앱이 "/price/:code" 만 호출하면 현재가를 돌려주도록 중계합니다.

const express = require("express");
const cors = require("cors");
const pushAddon = require('./push-addon');


const app = express();
app.use('/api', require('./industryAverage.route'));

app.use(cors()); // 개인용 조회 전용 서버라 전체 허용. 필요하면 특정 origin만 허용하도록 좁힐 수 있음.
const KIWOOM_APP_KEY = process.env.KIWOOM_APP_KEY;
const KIWOOM_APP_SECRET = process.env.KIWOOM_APP_SECRET;
const KIWOOM_ACCOUNT_NO = process.env.KIWOOM_ACCOUNT_NO;
const KIWOOM_BASE_URL = "https://api.kiwoom.com"; // 실전투자

let kiwoomTokenCache = { token: null, expiresAt: 0 };

async function getKiwoomToken() {
  const now = Date.now();
  if (kiwoomTokenCache.token && now < kiwoomTokenCache.expiresAt) {
    return kiwoomTokenCache.token;
  }
  const res = await fetch(`${KIWOOM_BASE_URL}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json;charset=UTF-8" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      appkey: KIWOOM_APP_KEY,
      secretkey: KIWOOM_APP_SECRET,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`키움 토큰 발급 실패: ${res.status} ${text}`);
  }
    const data = await res.json();
  if (!data.token || data.return_code !== 0) {
    throw new Error(`키움 토큰 발급 실패: return_code=${data.return_code} msg=${data.return_msg}`);
  }
  kiwoomTokenCache = {
    token: data.token,
    expiresAt: now + 23 * 60 * 60 * 1000,
  };
  return kiwoomTokenCache.token;
}

const APP_KEY = process.env.KIS_APP_KEY;
const APP_SECRET = process.env.KIS_APP_SECRET;
// 모의투자면 https://openapivts.koreainvestment.com:29443
// 실전투자면 https://openapi.koreainvestment.com:9443
const BASE_URL = process.env.KIS_BASE_URL || "https://openapi.koreainvestment.com:9443";

let tokenCache = { token: null, expiresAt: 0 };

async function getToken() {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expiresAt) {
    return tokenCache.token;
  }
  const res = await fetch(`${BASE_URL}/oauth2/tokenP`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      appkey: APP_KEY,
      appsecret: APP_SECRET,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`토큰 발급 실패: ${res.status} ${text}`);
  }
  const data = await res.json();
  tokenCache = {
    token: data.access_token,
    // 24시간 유효, 여유를 두고 23시간으로 캐시
    expiresAt: now + 23 * 60 * 60 * 1000,
  };
  return tokenCache.token;
}

app.get("/price/:code", async (req, res) => {
  const code = decodeURIComponent(req.params.code || "").trim().split(/[\s(]/)[0];
  if (!APP_KEY || !APP_SECRET) {
    return res.status(500).json({ error: "서버에 KIS_APP_KEY / KIS_APP_SECRET 환경변수가 설정되지 않았습니다." });
  }
  try {
    const token = await getToken();
    const url = `${BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}`;
    const r = await fetch(url, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${token}`,
        appkey: APP_KEY,
        appsecret: APP_SECRET,
        tr_id: "FHKST01010100",
      },
    });
    if (!r.ok) {
      const text = await r.text();
      return res.status(502).json({ error: `KIS API 오류: ${r.status} ${text}` });
    }
    const data = await r.json();
    const price = data?.output?.stck_prpr;
    if (!price) {
      return res.status(502).json({ error: "가격 데이터를 찾을 수 없습니다.", raw: data });
    }
    res.json({ code, price: Number(price), prevClose: data.output.stck_sdpr ? Number(data.output.stck_sdpr) : null, name: data.output.hts_kor_isnm || null, industryName: data.output.bstp_kor_isnm || null, marketCap: data.output.hts_avls ? Number(data.output.hts_avls) : null });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});
app.get("/index/:code", async (req, res) => {
  const code = decodeURIComponent(req.params.code || "").trim().split(/[\s(]/)[0];
 // 0001=코스피, 1001=코스닥
  if (!APP_KEY || !APP_SECRET) {
    return res.status(500).json({ error: "서버에 KIS_APP_KEY/SECRET이 설정되지 않았습니다." });
  }
  try {
    const token = await getToken();
    const url = `${BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-index-price?FID_COND_MRKT_DIV_CODE=U&FID_INPUT_ISCD=${code}`;
    const r = await fetch(url, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${token}`,
        appkey: APP_KEY,
        appsecret: APP_SECRET,
        tr_id: "FHPUP02100000",
      },
    });
    if (!r.ok) {
      const text = await r.text();
      return res.status(502).json({ error: `KIS API 오류: ${r.status} ${text}` });
    }
    const data = await r.json();
    const price = data.output?.bstp_nmix_prpr;
    if (!price) {
      return res.status(502).json({ error: "지수 데이터를 찾을 수 없습니다." });
    }
    res.json({
      code,
      price: Number(price),
      change: data.output?.bstp_nmix_prdy_vrss ? Number(data.output.bstp_nmix_prdy_vrss) : null,
      changeRate: data.output?.bstp_nmix_prdy_ctrt ? Number(data.output.bstp_nmix_prdy_ctrt) : null,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});
app.get("/index-history/:code", async (req, res) => {
  const code = decodeURIComponent(req.params.code || "").trim().split(/[\s(]/)[0];
 // 0001=코스피, 1001=코스닥
  if (!APP_KEY || !APP_SECRET) {
    return res.status(500).json({ error: "서버에 KIS_APP_KEY/SECRET이 설정되지 않았습니다." });
  }
  // period: D=일봉, W=주봉, M=월봉, Y=년봉 (미지정 시 기존 동작대로 W)
  const periodRaw = String(req.query.period || "W").toUpperCase();
  const period = ["D", "W", "M", "Y"].includes(periodRaw) ? periodRaw : "W";
  const defaultDays = { D: 200, W: 220, M: 1100, Y: 4000 };
  const days = Number(req.query.days) > 0 ? Math.min(Number(req.query.days), 7300) : defaultDays[period];
  try {
    const token = await getToken();
    const today = new Date();
    const end = today.toISOString().slice(0, 10).replace(/-/g, "");
    const startDate = new Date(today);
    startDate.setDate(startDate.getDate() - days);
    const start = startDate.toISOString().slice(0, 10).replace(/-/g, "");

    const url = `${BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-daily-indexchartprice?FID_COND_MRKT_DIV_CODE=U&FID_INPUT_ISCD=${code}&FID_INPUT_DATE_1=${start}&FID_INPUT_DATE_2=${end}&FID_PERIOD_DIV_CODE=${period}`;
    const r = await fetch(url, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${token}`,
        appkey: APP_KEY,
        appsecret: APP_SECRET,
        tr_id: "FHKUP03500100",
      },
    });
    if (!r.ok) {
      const text = await r.text();
      return res.status(502).json({ error: `KIS API 오류: ${r.status} ${text}` });
    }
    const data = await r.json();
    const rows = data.output2 || [];
    // 날짜 오름차순(과거→최근) 정렬 + 종가만 추출 (5주/20주 이동평균 계산은 앱에서 처리)
    const candles = rows
      .map((row) => ({ date: row.stck_bsop_date, close: row.bstp_nmix_prpr }))
      .filter((c) => c.date && c.close)
      .sort((a, b) => a.date.localeCompare(b.date));

    res.json({ code, period, candles });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});
app.get("/stock-history/:code", async (req, res) => {
  const code = decodeURIComponent(req.params.code || "").trim().split(/[\s(]/)[0];

  if (!APP_KEY || !APP_SECRET) {
    return res.status(500).json({ error: "서버에 KIS_APP_KEY/SECRET이 설정되지 않았습니다." });
  }
  // period: D=일봉, W=주봉, M=월봉, Y=년봉 (미지정 시 기존 동작대로 W)
  const periodRaw = String(req.query.period || "W").toUpperCase();
  const period = ["D", "W", "M", "Y"].includes(periodRaw) ? periodRaw : "W";
  // days: 조회할 과거 일수 (미지정 시 기간별 기본값)
  const defaultDays = { D: 200, W: 220, M: 1100, Y: 4000 };
  const days = Number(req.query.days) > 0 ? Math.min(Number(req.query.days), 7300) : defaultDays[period];
  try {
    const token = await getToken();
    const today = new Date();
    const end = today.toISOString().slice(0, 10).replace(/-/g, "");
    const startDate = new Date(today);
    startDate.setDate(startDate.getDate() - days);
    const start = startDate.toISOString().slice(0, 10).replace(/-/g, "");

    const url = `${BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}&FID_INPUT_DATE_1=${start}&FID_INPUT_DATE_2=${end}&FID_PERIOD_DIV_CODE=${period}&FID_ORG_ADJ_PRC=0`;
    const r = await fetch(url, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${token}`,
        appkey: APP_KEY,
        appsecret: APP_SECRET,
        tr_id: "FHKST03010100",
      },
    });
    if (!r.ok) {
      const text = await r.text();
      return res.status(502).json({ error: `KIS API 오류: ${r.status} ${text}` });
    }
    const data = await r.json();
    const rows = data.output2 || [];
    const candles = rows
      .map((row) => ({ date: row.stck_bsop_date, close: row.stck_clpr }))
      .filter((c) => c.date && c.close)
      .sort((a, b) => a.date.localeCompare(b.date));

    res.json({ code, period, candles });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// [진단용] 업종지수 코드를 훑어서 "실제로 존재하는 코드와 그 업종 이름"을 알아낸다.
// 사용법: /index-scan?from=1&to=60&market=U   (코스피/코스닥 업종 코드 탐색)
// 결과의 name이 실제 KIS가 돌려주는 업종명이므로, 이 값을 그대로 앱의 업종 목록에 쓰면 된다.
app.get("/index-scan", async (req, res) => {
  if (!APP_KEY || !APP_SECRET) {
    return res.status(500).json({ error: "서버에 KIS_APP_KEY/SECRET이 설정되지 않았습니다." });
  }
  const from = Math.max(0, Number(req.query.from) || 1);
  const to = Math.min(from + 199, Number(req.query.to) || 60); // 한 번에 최대 200개까지만
  const prefix = String(req.query.prefix || "0"); // "0"=코스피계열, "1"=코스닥계열
  try {
    const token = await getToken();
    const codes = [];
    for (let i = from; i <= to; i++) {
      codes.push(prefix + String(i).padStart(3, "0"));
    }
    const results = [];
    // 동시에 너무 많이 던지면 KIS가 막으므로 10개씩 나눠서 순차 처리
    for (let i = 0; i < codes.length; i += 10) {
      const batch = codes.slice(i, i + 10);
      const batchOut = await Promise.all(
        batch.map(async (code) => {
          try {
            const url = `${BASE_URL}/uapi/domestic-stock/v1/quotations/inquire-index-price?FID_COND_MRKT_DIV_CODE=U&FID_INPUT_ISCD=${code}`;
            const r = await fetch(url, {
              headers: {
                "content-type": "application/json; charset=utf-8",
                authorization: `Bearer ${token}`,
                appkey: APP_KEY,
                appsecret: APP_SECRET,
                tr_id: "FHPUP02100000",
              },
            });
            if (!r.ok) return { code, ok: false, status: r.status };
            const data = await r.json();
            const out = data.output || {};
            // 업종명이 담길 만한 필드를 전부 후보로 확인한다 (KIS 응답 스펙이 TR마다 조금씩 다름)
            const name = out.hts_kor_isnm || out.bstp_kor_isnm || out.bstp_cls_code_name || null;
            const price = out.bstp_nmix_prpr ? Number(out.bstp_nmix_prpr) : null;
            if (!price) return { code, ok: false, reason: "가격 없음" };
            return { code, ok: true, name, price };
          } catch (e) {
            return { code, ok: false, reason: String(e.message || e) };
          }
        })
      );
      results.push(...batchOut);
      await new Promise((r) => setTimeout(r, 120)); // 유량 제한 여유
    }
    const found = results.filter((r) => r.ok);
    res.json({
      prefix,
      scanned: codes.length,
      foundCount: found.length,
      found,                                   // 실제로 존재하는 코드 + 이름
      notFound: results.filter((r) => !r.ok).map((r) => r.code),
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// [진단용] 한국투자증권이 공식 배포하는 "업종코드 마스터 파일"을 직접 받아서 파싱한다.
// 출처: koreainvestment/open-trading-api 공식 GitHub 샘플(stocks_info/sector_code.py)에 나온 방식과 동일.
// 이게 추측이 아니라 진짜 정답 코드/이름 목록이다.
// 사용법: /sector-master  →  { count, sectors: [{ code, name }, ...] }
app.get("/sector-master", async (req, res) => {
  try {
    const iconv = require("iconv-lite"); // package.json에 이미 포함되어 있음 (확인됨)
    const zlib = require("zlib");

    const zipRes = await fetch("https://new.real.download.dws.co.kr/common/master/idxcode.mst.zip");
    if (!zipRes.ok) {
      return res.status(502).json({ error: `마스터 파일 다운로드 실패: ${zipRes.status}` });
    }
    const zipBuf = Buffer.from(await zipRes.arrayBuffer());

    // --- 아주 단순한 ZIP 파서 (파일이 1개뿐인 표준 zip이라고 가정) ---
    // End Of Central Directory 찾기 (시그니처 0x06054b50)
    let eocdOffset = -1;
    for (let i = zipBuf.length - 22; i >= 0; i--) {
      if (zipBuf.readUInt32LE(i) === 0x06054b50) { eocdOffset = i; break; }
    }
    if (eocdOffset === -1) return res.status(500).json({ error: "ZIP 파일 형식을 인식할 수 없어요 (EOCD 없음)." });
    const cdOffset = zipBuf.readUInt32LE(eocdOffset + 16);

    // Central Directory의 첫 번째 항목만 사용 (파일이 1개뿐이라고 가정)
    if (zipBuf.readUInt32LE(cdOffset) !== 0x02014b50) {
      return res.status(500).json({ error: "ZIP Central Directory를 찾을 수 없어요." });
    }
    const compMethod = zipBuf.readUInt16LE(cdOffset + 10);
    const compSize = zipBuf.readUInt32LE(cdOffset + 20);
    const lfhOffset = zipBuf.readUInt32LE(cdOffset + 42);

    // Local File Header에서 실제 데이터 시작 위치 계산
    if (zipBuf.readUInt32LE(lfhOffset) !== 0x04034b50) {
      return res.status(500).json({ error: "ZIP Local File Header를 찾을 수 없어요." });
    }
    const nameLen = zipBuf.readUInt16LE(lfhOffset + 26);
    const extraLen = zipBuf.readUInt16LE(lfhOffset + 28);
    const dataStart = lfhOffset + 30 + nameLen + extraLen;
    const compData = zipBuf.subarray(dataStart, dataStart + compSize);

    let rawBuf;
    if (compMethod === 0) rawBuf = compData; // 무압축(store)
    else if (compMethod === 8) rawBuf = zlib.inflateRawSync(compData); // deflate
    else return res.status(500).json({ error: `지원하지 않는 압축방식(${compMethod})이에요.` });

    // cp949(한글 EUC-KR 계열) 인코딩으로 디코딩
    const text = iconv.decode(rawBuf, "cp949");
    const lines = text.split(/\r?\n/).filter((l) => l.length > 10);

    // 공식 샘플과 동일한 방식으로 파싱: 업종코드=row[1:5], 업종명=row[3:43].rstrip()
    const sectors = lines.map((row) => ({
      code: row.slice(1, 5),
      name: row.slice(3, 43).trim(),
    })).filter((s) => s.code && s.name);

    res.json({ count: sectors.length, sectors });
  } catch (e) {
    if (String(e.message || e).includes("Cannot find module 'iconv-lite'")) {
      return res.status(500).json({ error: "서버에 iconv-lite 패키지가 없어요. package.json에 'iconv-lite'를 추가하고 다시 배포해 주세요." });
    }
    res.status(500).json({ error: String(e.message || e) });
  }
});

// [진단용] 네이버 금융의 업종별 페이지를 스크래핑해서, 업종마다 상위 3종목을 가져온다.
// 한 번에 다 긁으면 타임아웃이 나므로, offset/limit으로 나눠서 여러 번 호출하는 구조로 바꿨다.
//
// 사용법 (2단계):
//  1) /sector-reps?listOnly=1                → 전체 업종 목록(번호+이름)만 빠르게 확인 (1번만 호출하면 됨)
//  2) /sector-reps?offset=0&limit=8           → 그 목록 중 0~7번째 업종의 대표종목을 가져옴 (몇 초 안에 끝남)
//     /sector-reps?offset=8&limit=8           → 8~15번째 ... 이런 식으로 나눠서 여러 번 호출
app.get("/sector-reps", async (req, res) => {
  try {
    const axios = require("axios");
    const cheerio = require("cheerio");
    const iconv = require("iconv-lite");
  


    async function fetchPage(url) {
      const r = await axios.get(url, {
        responseType: "arraybuffer",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Referer": "https://finance.naver.com/",
          "Accept-Language": "ko-KR,ko;q=0.9",
        },
        timeout: 8000,
      });
      return iconv.decode(r.data, "EUC-KR");
    }

    // 1단계: 업종 전체 목록 (이건 항상 빠르게 끝남 - 페이지 1개만 가져오면 됨)
    const listHtml = await fetchPage("https://finance.naver.com/sise/sise_group.naver?type=upjong");
    const $list = cheerio.load(listHtml);
    const industries = [];
    $list('a[href*="sise_group_detail"]').each((_, el) => {
      const href = $list(el).attr("href") || "";
      const m = href.match(/no=(\d+)/);
      const name = $list(el).text().trim();
      if (m && name) industries.push({ no: m[1], name });
    });

    if (industries.length === 0) {
      return res.status(502).json({ error: "업종 목록을 찾지 못했어요. 네이버 페이지 구조가 바뀌었을 수 있어요.", htmlSnippet: listHtml.slice(0, 800) });
    }

    if (req.query.listOnly) {
      return res.json({ count: industries.length, industries });
    }

    const offset = Math.max(0, Number(req.query.offset) || 0);
    const limit = Math.min(10, Math.max(1, Number(req.query.limit) || 8)); // 한 번에 최대 10개까지만
    const slice = industries.slice(offset, offset + limit);

    // 2단계: 이번 배치에 해당하는 업종만 병렬로 가져온다 (전체를 순차로 돌리지 않아서 훨씬 빠름)
    const results = await Promise.all(
      slice.map(async (ind) => {
        try {
          const detailHtml = await fetchPage(`https://finance.naver.com/sise/sise_group_detail.naver?type=upjong&no=${ind.no}`);
          const $d = cheerio.load(detailHtml);
          const names = [];
          $d("table.type_5 a").each((_, a) => {
            const t = $d(a).text().trim();
            if (t && t.length <= 20 && !/더보기|전체|공시|검색/.test(t)) names.push(t);
          });
          return { no: ind.no, name: ind.name, stocks: [...new Set(names)].slice(0, 10) };
        } catch (e) {
          return { no: ind.no, name: ind.name, stocks: [], error: String(e.message || e) };
        }
      })
    );

    res.json({
      totalIndustries: industries.length,
      offset,
      limit,
      nextOffset: offset + limit < industries.length ? offset + limit : null, // 다음에 이어서 호출할 offset (더 없으면 null)
      industries: results,
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// [재무비율 조회] ROE와 주당매출액(PSR 계산용)을 한투 공식 재무비율 API에서, 분기별로 최근 10년치까지 가져온다.
// ⚠️ 이 TR_ID/URL은 KIS Developers 포털에서 직접 한 번 검증해 주세요.
app.get("/stock-fundamentals/:code", async (req, res) => {
  const code = decodeURIComponent(req.params.code || "").trim().split(/[\s(]/)[0];
  if (!APP_KEY || !APP_SECRET) {
    return res.status(500).json({ error: "서버에 KIS_APP_KEY/SECRET이 설정되지 않았습니다." });
  }
  try {
    const token = await getToken();
    async function callRatio(divCode) {
      const url = `${BASE_URL}/uapi/domestic-stock/v1/finance/financial-ratio?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${code}&FID_DIV_CLS_CODE=${divCode}`;
      const r = await fetch(url, {
        headers: {
          "content-type": "application/json; charset=utf-8",
          authorization: `Bearer ${token}`,
          appkey: APP_KEY,
          appsecret: APP_SECRET,
          tr_id: "FHKST66430300",
        },
      });
      if (!r.ok) return null;
      const data = await r.json();
      return Array.isArray(data.output) ? data.output : null;
    }

    // 1=분기, 0=연간. 분기 데이터가 비어있으면 연간으로 한 번 더 시도해본다 (일부 종목은 분기 미제공일 수 있음).
    let rows = await callRatio(1);
    let divUsed = "quarter";
    if (!rows || rows.length === 0) {
      rows = await callRatio(0);
      divUsed = "annual";
    }
    if (!rows || rows.length === 0) {
      return res.status(502).json({ error: "재무비율 데이터를 찾을 수 없습니다 (해당 종목은 제공되지 않을 수 있어요)." });
    }

    // 과거→최근 순으로 정렬 + 최근 10년(분기면 40개, 연간이면 10개)까지만
    const sorted = rows
      .filter((r) => r.stac_yymm)
      .sort((a, b) => a.stac_yymm.localeCompare(b.stac_yymm));
    const limit = divUsed === "quarter" ? 40 : 10;
    const trimmed = sorted.slice(-limit);

    const periods = trimmed.map((r) => ({
      period: r.stac_yymm,
      roe: r.roe_val ? Number(r.roe_val) : null,
      sps: r.sps ? Number(r.sps) : null,
      eps: r.eps ? Number(r.eps) : null,
      bps: r.bps ? Number(r.bps) : null,
      debtRatio: r.lblt_rate ? Number(r.lblt_rate) : null,
      revenueGrowth: r.grs ? Number(r.grs) : null, // 매출액증가율(%)
    }));

    res.json({ code, divUsed, periods, latest: periods[periods.length - 1] || null });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// [종목지표 전체] 매출액, 당좌비율을 추가로 가져온다 (기존 재무비율 API와 합쳐서 종목지표 화면에 씀).
app.get("/stock-extra-fundamentals/:code", async (req, res) => {
  const code = decodeURIComponent(req.params.code || "").trim().split(/[\s(]/)[0];
  if (!APP_KEY || !APP_SECRET) {
    return res.status(500).json({ error: "서버에 KIS_APP_KEY/SECRET이 설정되지 않았습니다." });
  }
  try {
    const token = await getToken();
    async function callFinance(path, trId, divCode) {
      const url = `${BASE_URL}/uapi/domestic-stock/v1/finance/${path}?FID_DIV_CLS_CODE=${divCode}&fid_cond_mrkt_div_code=J&fid_input_iscd=${code}`;
      const r = await fetch(url, {
        headers: {
          "content-type": "application/json; charset=utf-8",
          authorization: `Bearer ${token}`,
          appkey: APP_KEY,
          appsecret: APP_SECRET,
          tr_id: trId,
        },
      });
      if (!r.ok) return null;
      const data = await r.json();
      return Array.isArray(data.output) ? data.output : null;
    }

    // 분기(1) 우선 시도, 없으면 연간(0)
    let divCode = 1;
    let [balanceRows, incomeRows] = await Promise.all([
      callFinance("balance-sheet", "FHKST66430100", divCode),
      callFinance("income-statement", "FHKST66430200", divCode),
    ]);
    let divUsed = "quarter";
    if ((!balanceRows || balanceRows.length === 0) && (!incomeRows || incomeRows.length === 0)) {
      divCode = 0;
      [balanceRows, incomeRows] = await Promise.all([
        callFinance("balance-sheet", "FHKST66430100", divCode),
        callFinance("income-statement", "FHKST66430200", divCode),
      ]);
      divUsed = "annual";
    }

    const byPeriod = {};
    (balanceRows || []).forEach((r) => {
      if (!r.stac_yymm) return;
      byPeriod[r.stac_yymm] = byPeriod[r.stac_yymm] || {};
      const curAsset = r.cras ? Number(r.cras) : null;
      const curLblt = r.flow_lblt ? Number(r.flow_lblt) : null;
      byPeriod[r.stac_yymm].quickRatio = curAsset && curLblt ? Number(((curAsset / curLblt) * 100).toFixed(2)) : null; // 근사치: 유동자산/유동부채 (재고자산 분리 불가로 당좌비율 근사)
    });
    (incomeRows || []).forEach((r) => {
      if (!r.stac_yymm) return;
      byPeriod[r.stac_yymm] = byPeriod[r.stac_yymm] || {};
      byPeriod[r.stac_yymm].revenue = r.sale_account ? Number(r.sale_account) : null; // 매출액 (백만원 단위로 추정)
      byPeriod[r.stac_yymm].opProfit = r.op_prfi ? Number(r.op_prfi) : null; // 영업이익
      byPeriod[r.stac_yymm].netIncome = r.thtr_ntin ? Number(r.thtr_ntin) : null; // 당기순이익
    });

    const periods = Object.keys(byPeriod).sort().map((period) => ({ period, ...byPeriod[period] }));
    res.json({ code, divUsed, periods });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/holdings", async (req, res) => {
  if (!KIWOOM_APP_KEY || !KIWOOM_APP_SECRET) {
    return res.status(500).json({ error: "서버에 KIWOOM_APP_KEY/SECRET이 설정되지 않았습니다." });
  }
  try {
    const token = await getKiwoomToken();
    const r = await fetch(`${KIWOOM_BASE_URL}/api/dostk/acnt`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json;charset=UTF-8",
        authorization: `Bearer ${token}`,
        "cont-yn": "N",
        "next-key": "",
        "api-id": "kt00018",
      },
      body: JSON.stringify({ qry_tp: "1", dmst_stex_tp: "KRX" }),
    });
    if (!r.ok) {
      const text = await r.text();
      return res.status(502).json({ error: `키움 API 오류: ${r.status} ${text}` });
    }
    
     const data = await r.json();
    if (data.return_code !== 0) {
      return res.status(502).json({ error: "키움 응답 오류", return_code: data.return_code, return_msg: data.return_msg, raw: data });
    }
    const list = (data.acnt_evlt_remn_indv_tot || []).map((it) => ({

      code: it.stk_cd?.replace(/^A/, ""),
      name: it.stk_nm,
      qty: Number(it.rmnd_qty),
      avgPrice: Number(it.pur_pric),
      curPrice: Number(it.cur_prc),
      prevClose: Number(it.pred_close_pric),
    }));
    res.json({ holdings: list });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/", (req, res) => res.send("KIS proxy is running."));

const PORT = process.env.PORT || 3000;
app.use(pushAddon);
app.listen(PORT, () => console.log(`KIS proxy listening on ${PORT}`));
