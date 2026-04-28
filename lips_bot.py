import os
import re
import logging
from slack_bolt import App
from slack_bolt.adapter.socket_mode import SocketModeHandler

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = App(token=os.environ["SLACK_BOT_TOKEN"])


# ── 금액 파싱 ──────────────────────────────────────────────

def parse_amount(text: str) -> int | None:
    """한국어 금액 표현 → 원 단위 정수 변환
    지원 형식: 10억, 10억원, 1.8억, 8000만, 8000만원, 8,000만원
    """
    text = str(text).replace(",", "").strip()
    m = re.search(r"([\d.]+)\s*억", text)
    if m:
        return int(float(m.group(1)) * 100_000_000)
    m = re.search(r"([\d.]+)\s*만", text)
    if m:
        return int(float(m.group(1)) * 10_000)
    m = re.search(r"(\d+)", text)
    if m:
        return int(m.group(1))
    return None


def fmt(amount: float) -> str:
    """원 단위 포맷 (세 자리 콤마)"""
    return f"{int(round(amount)):,}원"


# ── 명령어 파싱 ─────────────────────────────────────────────

def parse_lips_command(text: str) -> dict | None:
    """
    입력 예시:
    !lips LIPS1 2개사 10억원 기업가형1개, LIPS2 시드2개 8000만원 스케일업3개 1.8억원 기업가형2개
    """
    text = re.sub(r"^!lips\s*", "", text.strip(), flags=re.IGNORECASE)

    # LIPS1: 기업 수, 총 융자금액, 기업가형 수
    m1 = re.search(
        r"LIPS\s*1[^\d]*(\d+)\s*개[^\d,]*([\d.,]+\s*(?:억|만)[원]?)[^,LIPS]*?(?:기업가형\s*(\d+))?",
        text, re.IGNORECASE,
    )
    if not m1:
        return None

    lips1_count     = int(m1.group(1))
    lips1_amount    = parse_amount(m1.group(2))
    lips1_enterprise = int(m1.group(3)) if m1.group(3) else 0

    # 시드립스: 기업 수, 기업당 배정금액
    ms = re.search(
        r"시드\s*(\d+)\s*개[^\d,]*([\d.,]+\s*(?:억|만)[원]?)",
        text, re.IGNORECASE,
    )
    if not ms:
        return None

    seed_count       = int(ms.group(1))
    seed_per_company = parse_amount(ms.group(2))

    # 스케일업립스: 기업 수, 기업당 배정금액
    mu = re.search(
        r"스케일업\s*(\d+)\s*개[^\d,]*([\d.,]+\s*(?:억|만)[원]?)",
        text, re.IGNORECASE,
    )
    if not mu:
        return None

    scaleup_count       = int(mu.group(1))
    scaleup_per_company = parse_amount(mu.group(2))

    # LIPS2 기업가형: LIPS1 섹션 이후에서 탐색
    lips2_section = text[m1.end():]
    me = re.search(r"기업가형\s*(\d+)", lips2_section, re.IGNORECASE)
    lips2_enterprise = int(me.group(1)) if me else 0

    if None in (lips1_amount, seed_per_company, scaleup_per_company):
        return None

    return dict(
        lips1_count=lips1_count,
        lips1_amount=lips1_amount,
        lips1_enterprise=lips1_enterprise,
        seed_count=seed_count,
        seed_per_company=seed_per_company,
        scaleup_count=scaleup_count,
        scaleup_per_company=scaleup_per_company,
        lips2_enterprise=lips2_enterprise,
    )


# ── LIPS 사업비 계산 ────────────────────────────────────────

SEED_CAP    = 100_000_000   # 시드립스 기업당 상한 1억원
SCALEUP_CAP = 200_000_000   # 스케일업립스 기업당 상한 2억원

def calculate_lips(
    lips1_count, lips1_amount, lips1_enterprise,
    seed_count, seed_per_company,
    scaleup_count, scaleup_per_company,
    lips2_enterprise,
) -> dict:

    # 기본 사업비
    lips1_base      = lips1_amount * 0.02
    seed_total      = seed_count    * min(seed_per_company,    SEED_CAP)
    scaleup_total   = scaleup_count * min(scaleup_per_company, SCALEUP_CAP)
    lips2_seed_base    = seed_total    * 0.08
    lips2_scaleup_base = scaleup_total * 0.08
    lips2_base      = lips2_seed_base + lips2_scaleup_base
    unit_total      = lips1_base + lips2_base

    # 기업가형 할증
    total_enterprise = lips1_enterprise + lips2_enterprise
    if total_enterprise > 0:
        lips1_premium = lips1_base * (lips1_enterprise / total_enterprise) * 0.2
        lips2_premium = lips2_base * (lips2_enterprise / total_enterprise) * 0.2
    else:
        lips1_premium = lips2_premium = 0.0

    total_premium = lips1_premium + lips2_premium
    total         = unit_total + total_premium
    direct        = total * 0.3
    indirect      = total * 0.7

    return dict(
        lips1_count=lips1_count,           lips1_amount=lips1_amount,
        lips1_enterprise=lips1_enterprise, lips1_base=lips1_base,
        seed_count=seed_count,             seed_per_company=seed_per_company,
        lips2_seed_base=lips2_seed_base,
        scaleup_count=scaleup_count,       scaleup_per_company=scaleup_per_company,
        lips2_scaleup_base=lips2_scaleup_base,
        lips2_base=lips2_base,
        unit_total=unit_total,
        lips1_enterprise=lips1_enterprise, lips2_enterprise=lips2_enterprise,
        total_enterprise=total_enterprise,
        lips1_premium=lips1_premium,       lips2_premium=lips2_premium,
        total_premium=total_premium,
        total=total,
        direct=direct,                     indirect=indirect,
    )


# ── 결과 포맷 ───────────────────────────────────────────────

def format_result(r: dict) -> str:
    lip1_ent_ratio = (
        f"{r['lips1_enterprise']}/{r['total_enterprise']}"
        if r["total_enterprise"] > 0 else "0/0"
    )
    lip2_ent_ratio = (
        f"{r['lips2_enterprise']}/{r['total_enterprise']}"
        if r["total_enterprise"] > 0 else "0/0"
    )

    return (
        f"📊 *LIPS 운영 사업비 계산 결과*\n\n"
        f"*[입력 요약: LIPS1 {r['lips1_count']}개사(총 {fmt(r['lips1_amount'])}), "
        f"LIPS2 시드 {r['seed_count']}개(기업당 {fmt(r['seed_per_company'])}) / "
        f"스케일업 {r['scaleup_count']}개(기업당 {fmt(r['scaleup_per_company'])}), "
        f"기업가형 총 {r['total_enterprise']}개]*\n\n"
        f"---\n\n"
        f"*1️⃣ 사업비 계산*\n\n"
        f"*기본 사업비 (LIPS1, LIPS2)*\n"
        f"| 항목 | 기업 수 | 금액 계산 | 사업비 |\n"
        f"|---|---|---|---|\n"
        f"| *LIPS1* 융자 매칭 | {r['lips1_count']}개 | {fmt(r['lips1_amount'])} × 2% | {fmt(r['lips1_base'])} |\n"
        f"| *LIPS2 시드* | {r['seed_count']}개 | ({r['seed_count']}개 × {fmt(r['seed_per_company'])}) × 8% | {fmt(r['lips2_seed_base'])} |\n"
        f"| *LIPS2 스케일업* | {r['scaleup_count']}개 | ({r['scaleup_count']}개 × {fmt(r['scaleup_per_company'])}) × 8% | {fmt(r['lips2_scaleup_base'])} |\n"
        f"| *소계 (기본)* | | | *{fmt(r['unit_total'])}* |\n\n"
        f"*할증 사업비 (기업가형 소상공인)*\n"
        f"| 항목 | 기업가형 수 | 비율 | 할증액 |\n"
        f"|---|---|---|---|\n"
        f"| *LIPS1 할증* | {r['lips1_enterprise']}개 | {lip1_ent_ratio} × 20% | {fmt(r['lips1_premium'])} |\n"
        f"| *LIPS2 할증* | {r['lips2_enterprise']}개 | {lip2_ent_ratio} × 20% | {fmt(r['lips2_premium'])} |\n"
        f"| *소계 (할증)* | | | *{fmt(r['total_premium'])}* |\n\n"
        f"---\n\n"
        f"*💰 총 사업비*\n"
        f"| 항목 | 금액 |\n"
        f"|---|---|\n"
        f"| 기본 사업비 (LIPS1, LIPS2) | {fmt(r['unit_total'])} |\n"
        f"| 기업가형 소상공인 할증 | +{fmt(r['total_premium'])} |\n"
        f"| *총 사업비* | *{fmt(r['total'])}* |\n\n"
        f"---\n\n"
        f"*2️⃣ 직/간접비 구성*\n"
        f"| 항목 | 계산식 | 금액 |\n"
        f"|---|---|---|\n"
        f"| *직접비 (30%)* | 총 사업비 × 30% | {fmt(r['direct'])} |\n"
        f"| *간접비 (70%)* | 총 사업비 × 70% | {fmt(r['indirect'])} |\n\n"
        f"_※ 기업성장지원비는 총 사업예산 내 배정범위에서 변경될 수 있습니다._"
    )


ERROR_MSG = (
    "안녕하세요! LIPS 사업비 계산봇입니다. 🤖\n"
    "입력 형식을 확인해 주세요.\n\n"
    "*올바른 형식 예시:*\n"
    "`!lips LIPS1 2개사 10억원 기업가형1개, LIPS2 시드2개 8000만원 스케일업3개 1.8억원 기업가형2개`\n\n"
    "*항목 설명:*\n"
    "• LIPS1: 매칭기업 수, 총 융자 집행금액, 기업가형 소상공인 수\n"
    "• LIPS2 시드: 기업 수, 기업당 배정금액 (상한 1억원)\n"
    "• LIPS2 스케일업: 기업 수, 기업당 배정금액 (상한 2억원)\n"
    "• 기업가형: 전체 중 기업가형 소상공인 합계 수"
)


# ── Slack 이벤트 핸들러 ─────────────────────────────────────

@app.message(re.compile(r"^!lips", re.IGNORECASE))
def handle_lips(message, say):
    thread_ts = message.get("thread_ts") or message["ts"]
    text      = message.get("text", "")

    try:
        parsed = parse_lips_command(text)
        if not parsed:
            say(text=ERROR_MSG, thread_ts=thread_ts)
            return

        result   = calculate_lips(**parsed)
        response = format_result(result)
        say(text=response, thread_ts=thread_ts)
        logger.info(f"계산 완료 — ts={message['ts']}")

    except Exception as exc:
        logger.exception(f"처리 중 오류: {exc}")
        say(text=ERROR_MSG, thread_ts=thread_ts)


# ── 진입점 ──────────────────────────────────────────────────

if __name__ == "__main__":
    SocketModeHandler(app, os.environ["SLACK_APP_TOKEN"]).start()
