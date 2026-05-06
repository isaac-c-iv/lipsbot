// LIPS 사업비 계산봇 — Cloudflare Workers
// 지원: Slash Command (/lips), Events API (!lips 메시지), Workflow Webhook (JSON)

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
  // !lips 또는 /lips 접두사 제거
  text = text.replace(/^[!/]?\s*lips\s*/i, '').trim();

  // 억/만 단위 금액 추출 (콤마 포함 숫자 지원)
  function findAmount(str) {
    const m = str.match(/([\d,]+(?:\.\d+)?)\s*(억|만)/);
    if (!m) return null;
    const num = parseFloat(m[1].replace(/,/g, ''));
    return m[2] === '억' ? Math.round(num * 100_000_000) : Math.round(num * 10_000);
  }

  // LIPS1 / LIPS2 섹션 분리
  const l2Match = text.match(/LIPS\s*2/i);
  const l2Pos   = l2Match ? l2Match.index : -1;
  const lips1Str = l2Pos >= 0 ? text.slice(0, l2Pos) : text;
  const lips2Str = l2Pos >= 0 ? text.slice(l2Pos)    : '';
  if (!lips2Str) return null;

  // ── LIPS1 파싱 ──
  const l1Match = lips1Str.match(/LIPS\s*1/i);
  if (!l1Match) return null;
  const l1Body = lips1Str.slice(l1Match.index + l1Match[0].length);

  const l1CntM = l1Body.match(/(\d+)\s*개/);
  if (!l1CntM) return null;
  const lips1Count  = parseInt(l1CntM[1]);
  const lips1Amount = findAmount(l1Body);
  if (!lips1Amount) return null;

  const ent1M           = l1Body.match(/기업가형\s*(\d+)/i);
  const lips1Enterprise = ent1M ? parseInt(ent1M[1]) : 0;

  // ── LIPS2 시드 파싱 ──
  const seedM = lips2Str.match(/시드\s*(\d+)\s*개/i);
  if (!seedM) return null;
  const seedCount  = parseInt(seedM[1]);
  const afterSeed  = lips2Str.slice(seedM.index + seedM[0].length)
                              .replace(/^\s*시드\s*/i, '');
  const seedPerCompany = findAmount(afterSeed);
  if (!seedPerCompany) return null;

  // ── LIPS2 스케일업 파싱 ──
  const scaleM = lips2Str.match(/스케일업\s*(\d+)\s*개/i);
  if (!scaleM) return null;
  const scaleupCount = parseInt(scaleM[1]);
  const afterScale   = lips2Str.slice(scaleM.index + scaleM[0].length);
  const scaleupPerCompany = findAmount(afterScale);
  if (!scaleupPerCompany) return null;

  // ── LIPS2 기업가형 ──
  const ent2M           = lips2Str.match(/기업가형\s*(\d+)/i);
  const lips2Enterprise = ent2M ? parseInt(ent2M[1]) : 0;

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

  return `📊 *LIPS 운영 사업비*
_LIPS1 ${r.lips1Count}개사 / 시드 ${r.seedCount}개 / 스케일업 ${r.scaleupCount}개 / 기업가형 ${r.totalEnterprise}개_

💰 *총 사업비　　${fmt(r.total)}*
　직접비 (30%)　${fmt(r.direct)}
　간접비 (70%)　${fmt(r.indirect)}

> *산출 내역*
> • LIPS1　　　${fmt(r.lips1Amount)} × 2% = ${fmt(r.lips1Base)}
> • LIPS2 시드　(${fmt(r.seedPerCompany)} × ${r.seedCount}개) × 8% = ${fmt(r.lips2SeedBase)}
> • LIPS2 스케일업　(${fmt(r.scaleupPerCompany)} × ${r.scaleupCount}개) × 8% = ${fmt(r.lips2ScaleupBase)}
> • 기본 소계　${fmt(r.unitTotal)}
> • 기업가형 할증　LIPS1(${l1R}×20%) +${fmt(r.lips1Premium)} / LIPS2(${l2R}×20%) +${fmt(r.lips2Premium)}
> • 할증 소계　+${fmt(r.totalPremium)}
>
> _※ 기업성장지원비는 총 사업예산 내 배정범위에서 변경될 수 있습니다._`;
}

const ERROR_MSG = `안녕하세요! LIPS 사업비 계산봇입니다. 🤖
입력 형식을 확인해 주세요.

*올바른 형식 예시:*
\`!lips LIPS1 2개사 10억원 기업가형1개, LIPS2 시드2개 8000만원 스케일업3개 1.8억원 기업가형2개\`

*항목 설명:*
- LIPS1: 매칭기업 수, 총 융자 집행금액, 기업가형 소상공인 수
- LIPS2 시드: 기업 수, 기업당 배정금액 (상한 1억원)
- LIPS2 스케일업: 기업 수, 기업당 배정금액 (상한 2억원)
- 기업가형: 전체 중 기업가형 소상공인 합계 수`;

// ── 허용 채널 설정 ──────────────────────────────────────────
const ALLOWED_CHANNEL_ID = 'C08FY586YPR'; // #투자부문_립스

// ── Slack chat.postMessage 호출 ─────────────────────────────
async function postMessage(token, channel, text, threadTs) {
  const payload = { channel, text };
  if (threadTs) payload.thread_ts = threadTs;

  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

// ── Cloudflare Worker 진입점 ────────────────────────────────
export default {
  async fetch(request, env) {
    if (request.method === 'GET') {
      return new Response('LIPS Calculator Bot is running! ✅');
    }
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const contentType = request.headers.get('content-type') || '';

    // ── JSON body 처리 ───────────────────────────────────────
    if (contentType.includes('application/json')) {
      const body = await request.json();

      // 1) Events API URL 인증 challenge
      if (body.type === 'url_verification') {
        return Response.json({ challenge: body.challenge });
      }

      // 2) Events API — 채널 메시지 (!lips 로 시작하는 메시지)
      if (body.type === 'event_callback' && body.event?.type === 'message') {
        const event = body.event;

        // 봇 자신의 메시지 무시 (무한루프 방지)
        if (event.bot_id || event.subtype) {
          return new Response('OK');
        }

        const msgText   = (event.text || '').trim();
        const channelId = event.channel;

        // 허용 채널 외 무시
        if (channelId !== ALLOWED_CHANNEL_ID) {
          return new Response('OK');
        }

        // !lips 또는 /lips 로 시작하는 메시지만 처리
        if (!/^[!/]lips\s/i.test(msgText)) {
          return new Response('OK');
        }

        const parsed = parseLipsCommand(msgText);
        const replyText = parsed
          ? formatResult(calculateLips(parsed))
          : ERROR_MSG;

        // 같은 채널에 스레드로 답변
        await postMessage(env.SLACK_BOT_TOKEN, channelId, replyText, event.ts);
        return new Response('OK');
      }

      // 3) 워크플로 웹훅 — 개별 파라미터 직접 전달
      const parsed = {
        lips1Count:        parseInt(body.lips1_count)           || 0,
        lips1Amount:       parseAmount(body.lips1_amount)       || 0,
        lips1Enterprise:   parseInt(body.lips1_enterprise)      || 0,
        seedCount:         parseInt(body.seed_count)            || 0,
        seedPerCompany:    parseAmount(body.seed_amount)        || 0,
        scaleupCount:      parseInt(body.scaleup_count)         || 0,
        scaleupPerCompany: parseAmount(body.scaleup_amount)     || 0,
        lips2Enterprise:   parseInt(body.lips2_enterprise)      || 0,
      };

      if (!parsed.lips1Amount || !parsed.seedPerCompany || !parsed.scaleupPerCompany) {
        return Response.json({ text: ERROR_MSG });
      }

      return Response.json({ text: formatResult(calculateLips(parsed)) });
    }

    // ── 슬래시 명령어 처리 (form-urlencoded) ────────────────
    const formData = await request.formData();
    const channelId = formData.get('channel_id') || '';

    if (channelId && channelId !== ALLOWED_CHANNEL_ID) {
      return Response.json({
        response_type: 'ephemeral',
        text: '⚠️ `/lips` 명령어는 *#투자부문_립스* 채널에서만 사용할 수 있습니다.',
      });
    }

    const text = (formData.get('text') || '').trim();

    if (!text) {
      return Response.json({ response_type: 'ephemeral', text: ERROR_MSG });
    }

    const parsed = parseLipsCommand(text);
    if (!parsed) {
      return Response.json({ response_type: 'ephemeral', text: ERROR_MSG });
    }

    return Response.json({
      response_type: 'in_channel',
      text: formatResult(calculateLips(parsed)),
    });
  },
};
