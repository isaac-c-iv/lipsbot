// LIPS 사업비 계산봇 — Cloudflare Workers (Slack Slash Command /lips)

// ── 금액 파싱 ──────────────────────────────────────────────
function parseAmount(text) {
  text = String(text).replace(/,/g, '').trim();
  let m = text.match(/([\d.]+)\s*억/);
  if (m) return Math.round(parseFloat(m[1]) * 100_000_000);
  m = text.match(/([\d.]+)\s*만/);
  if (m) return Math.round(parseFloat(m[1]) * 10_000);
  m = text.match(/(\d+)/);
  if (m) return parseInt(m[1]);
  return null;
}

function fmt(amount) {
  return Math.round(amount).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '원';
}

// ── 명령어 파싱 ─────────────────────────────────────────────
function parseLipsCommand(text) {
  // /lips 또는 !lips 접두사 제거
  text = text.replace(/^[!/]?\s*lips\s*/i, '').trim();

  const m1 = text.match(
    /LIPS\s*1[^\d]*(\d+)\s*개[^\d,]*([\d.,]+\s*(?:억|만)[원]?)[^,LIPS]*?(?:기업가형\s*(\d+))?/i
  );
  if (!m1) return null;

  const lips1Count      = parseInt(m1[1]);
  const lips1Amount     = parseAmount(m1[2]);
  const lips1Enterprise = m1[3] ? parseInt(m1[3]) : 0;

  const ms = text.match(/시드\s*(\d+)\s*개[^\d,]*([\d.,]+\s*(?:억|만)[원]?)/i);
  if (!ms) return null;
  const seedCount      = parseInt(ms[1]);
  const seedPerCompany = parseAmount(ms[2]);

  const mu = text.match(/스케일업\s*(\d+)\s*개[^\d,]*([\d.,]+\s*(?:억|만)[원]?)/i);
  if (!mu) return null;
  const scaleupCount      = parseInt(mu[1]);
  const scaleupPerCompany = parseAmount(mu[2]);

  const lips2Section   = text.slice(m1.index + m1[0].length);
  const me             = lips2Section.match(/기업가형\s*(\d+)/i);
  const lips2Enterprise = me ? parseInt(me[1]) : 0;

  if (!lips1Amount || !seedPerCompany || !scaleupPerCompany) return null;

  return {
    lips1Count, lips1Amount, lips1Enterprise,
    seedCount, seedPerCompany,
    scaleupCount, scaleupPerCompany,
    lips2Enterprise,
  };
}

// ── LIPS 사업비 계산 ────────────────────────────────────────
const SEED_CAP    = 100_000_000;
const SCALEUP_CAP = 200_000_000;

function calculateLips(p) {
  const lips1Base        = p.lips1Amount * 0.02;
  const seedTotal        = p.seedCount    * Math.min(p.seedPerCompany,    SEED_CAP);
  const scaleupTotal     = p.scaleupCount * Math.min(p.scaleupPerCompany, SCALEUP_CAP);
  const lips2SeedBase    = seedTotal    * 0.08;
  const lips2ScaleupBase = scaleupTotal * 0.08;
  const lips2Base        = lips2SeedBase + lips2ScaleupBase;
  const unitTotal        = lips1Base + lips2Base;

  const totalEnterprise = p.lips1Enterprise + p.lips2Enterprise;
  const lips1Premium = totalEnterprise > 0
    ? lips1Base * (p.lips1Enterprise / totalEnterprise) * 0.2 : 0;
  const lips2Premium = totalEnterprise > 0
    ? lips2Base * (p.lips2Enterprise / totalEnterprise) * 0.2 : 0;
  const totalPremium = lips1Premium + lips2Premium;
  const total        = unitTotal + totalPremium;

  return {
    ...p,
    lips1Base, lips2SeedBase, lips2ScaleupBase, lips2Base,
    unitTotal, totalEnterprise,
    lips1Premium, lips2Premium, totalPremium,
    total, direct: total * 0.3, indirect: total * 0.7,
  };
}

// ── 결과 포맷 ───────────────────────────────────────────────
function formatResult(r) {
  const l1R = r.totalEnterprise > 0 ? `${r.lips1Enterprise}/${r.totalEnterprise}` : '0/0';
  const l2R = r.totalEnterprise > 0 ? `${r.lips2Enterprise}/${r.totalEnterprise}` : '0/0';

  return `📊 *LIPS 운영 사업비 계산 결과*

*[입력 요약: LIPS1 ${r.lips1Count}개사(총 ${fmt(r.lips1Amount)}), LIPS2 시드 ${r.seedCount}개(기업당 ${fmt(r.seedPerCompany)}) / 스케일업 ${r.scaleupCount}개(기업당 ${fmt(r.scaleupPerCompany)}), 기업가형 총 ${r.totalEnterprise}개]*

---

*1️⃣ 사업비 계산*

*기본 사업비 (LIPS1, LIPS2)*
| 항목 | 기업 수 | 금액 계산 | 사업비 |
|---|---|---|---|
| *LIPS1* 융자 매칭 | ${r.lips1Count}개 | ${fmt(r.lips1Amount)} × 2% | ${fmt(r.lips1Base)} |
| *LIPS2 시드* | ${r.seedCount}개 | (${r.seedCount}개 × ${fmt(r.seedPerCompany)}) × 8% | ${fmt(r.lips2SeedBase)} |
| *LIPS2 스케일업* | ${r.scaleupCount}개 | (${r.scaleupCount}개 × ${fmt(r.scaleupPerCompany)}) × 8% | ${fmt(r.lips2ScaleupBase)} |
| *소계 (기본)* | | | *${fmt(r.unitTotal)}* |

*할증 사업비 (기업가형 소상공인)*
| 항목 | 기업가형 수 | 비율 | 할증액 |
|---|---|---|---|
| *LIPS1 할증* | ${r.lips1Enterprise}개 | ${l1R} × 20% | ${fmt(r.lips1Premium)} |
| *LIPS2 할증* | ${r.lips2Enterprise}개 | ${l2R} × 20% | ${fmt(r.lips2Premium)} |
| *소계 (할증)* | | | *${fmt(r.totalPremium)}* |

---

*💰 총 사업비*
| 항목 | 금액 |
|---|---|
| 기본 사업비 (LIPS1, LIPS2) | ${fmt(r.unitTotal)} |
| 기업가형 소상공인 할증 | +${fmt(r.totalPremium)} |
| *총 사업비* | *${fmt(r.total)}* |

---

*2️⃣ 직/간접비 구성*
| 항목 | 계산식 | 금액 |
|---|---|---|
| *직접비 (30%)* | 총 사업비 × 30% | ${fmt(r.direct)} |
| *간접비 (70%)* | 총 사업비 × 70% | ${fmt(r.indirect)} |

_※ 기업성장지원비는 총 사업예산 내 배정범위에서 변경될 수 있습니다._`;
}

const ERROR_MSG = `안녕하세요! LIPS 사업비 계산봇입니다. 🤖
입력 형식을 확인해 주세요.

*올바른 형식 예시:*
\`/lips LIPS1 2개사 10억원 기업가형1개, LIPS2 시드2개 8000만원 스케일업3개 1.8억원 기업가형2개\`

*항목 설명:*
• LIPS1: 매칭기업 수, 총 융자 집행금액, 기업가형 소상공인 수
• LIPS2 시드: 기업 수, 기업당 배정금액 (상한 1억원)
• LIPS2 스케일업: 기업 수, 기업당 배정금액 (상한 2억원)
• 기업가형: 전체 중 기업가형 소상공인 합계 수`;

// ── Cloudflare Worker 진입점 ────────────────────────────────
export default {
  async fetch(request) {
    if (request.method === 'GET') {
      return new Response('LIPS Calculator Bot is running! ✅');
    }
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const formData = await request.formData();
    const text = (formData.get('text') || '').trim();

    if (!text) {
      return Response.json({ response_type: 'ephemeral', text: ERROR_MSG });
    }

    const parsed = parseLipsCommand(text);
    if (!parsed) {
      return Response.json({ response_type: 'ephemeral', text: ERROR_MSG });
    }

    const result   = calculateLips(parsed);
    const response = formatResult(result);

    return Response.json({ response_type: 'in_channel', text: response });
  },
};
