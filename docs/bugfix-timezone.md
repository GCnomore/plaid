# 주간 경계 타임존 버그 수정 (2026-07-31)

## 버그 요약

**심각도**: 🔴 Critical

**증상**: Slack 알림의 주간 예산 계산이 뒤죽박죽이 되고, 실제 지출과 예산이 맞지 않음

**영향 범위**:
- 주간 경계 계산 (월요일~일요일)
- 주간 지출 합계
- Carryover 계산
- 모든 Slack 알림의 예산 정보

**근본 원인**: `getWeekDateRange()` 함수가 타임존 기준 날짜를 구하지만 UTC 기준 요일을 사용하여, LA 타임존 기준 주간 경계가 항상 **하루씩 틀어짐**

---

## 기술적 분석

### 문제 코드 (수정 전)

```typescript
// supabase/functions/_shared/budget.ts
export function getWeekDateRange(timezone: string): WeekDateRange {
  const now = new Date();

  // 1. 타임존 기준 날짜 구함 (예: "2026-07-31")
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const todayStr = formatter.format(now); // '2026-07-31'

  // 2. 문자열을 Date 객체로 변환 (❌ 문제 발생)
  const [y, m, d] = todayStr.split('-').map(Number);
  const todayLocal = new Date(y, m - 1, d);  // ❌ UTC 자정으로 해석됨

  // 3. 요일 구하기 (❌ UTC 기준 요일!)
  const dayOfWeek = todayLocal.getDay();  // ❌ UTC 기준
  const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;

  // 4. 월요일 계산 (결과적으로 하루 틀어짐)
  const monday = new Date(todayLocal);
  monday.setDate(todayLocal.getDate() - daysFromMonday);

  // ...
}
```

### 버그 시나리오

```
현재 시각: 2026-07-31 12:00:00 (LA 타임존, 금요일 정오)
UTC 시각:   2026-07-31 19:00:00 (금요일 저녁)

[잘못된 계산]
1. todayStr = "2026-07-31" (LA 기준 날짜) ✅
2. todayLocal = new Date(2026, 6, 31)
   → UTC 2026-07-31 00:00:00 (금요일 자정)
3. todayLocal.getDay() = 5 (금요일) ✅ 겉보기엔 맞음
4. daysFromMonday = 4
5. monday = 2026-07-31 - 4일 = 2026-07-27 ✅ 겉보기엔 맞음

하지만...

현재 시각: 2026-08-01 00:30:00 (LA 토요일 새벽)
UTC 시각:   2026-08-01 07:30:00 (토요일 아침)

[버그 발생!]
1. todayStr = "2026-08-01" (LA 기준 토요일) ✅
2. todayLocal = new Date(2026, 7, 1)
   → UTC 2026-08-01 00:00:00 (토요일 자정)
3. todayLocal.getDay() = 6 (토요일) ❌ 하지만 LA는 아직 금요일 밤!
4. daysFromMonday = 5
5. monday = 2026-08-01 - 5일 = 2026-07-27 ❌ 틀렸다!

정답: 2026-07-26 (실제 LA 기준 이번 주 월요일)
```

**핵심 문제**: `new Date(year, month, day)`는 **실행 환경의 로컬 타임존**(Edge Function에서는 UTC)으로 해석되고, `getDay()`도 **UTC 기준** 요일을 반환합니다. 하지만 우리는 **LA 타임존 기준** 요일이 필요합니다.

---

## 수정 내용

### 수정된 코드

```typescript
export function getWeekDateRange(timezone: string): WeekDateRange {
  const now = new Date();

  // 1. 타임존 기준 날짜 구함
  const dateFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const todayStr = dateFormatter.format(now); // 'YYYY-MM-DD'

  // 2. ✅ 타임존 기준 요일을 직접 구함 (핵심 수정!)
  const weekdayFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
  });
  const weekdayStr = weekdayFormatter.format(now); // 'Friday', 'Saturday', etc.

  // 3. ✅ 요일 문자열을 숫자로 변환
  const weekdayMap: Record<string, number> = {
    'Monday': 0,
    'Tuesday': 1,
    'Wednesday': 2,
    'Thursday': 3,
    'Friday': 4,
    'Saturday': 5,
    'Sunday': 6,
  };
  const daysFromMonday = weekdayMap[weekdayStr];

  // 4. ✅ Date.UTC()를 사용하여 타임존 shift 방지
  const [y, m, d] = todayStr.split('-').map(Number);
  const todayDate = new Date(Date.UTC(y, m - 1, d));

  const mondayDate = new Date(todayDate);
  mondayDate.setUTCDate(todayDate.getUTCDate() - daysFromMonday);

  const sundayDate = new Date(mondayDate);
  sundayDate.setUTCDate(mondayDate.getUTCDate() + 6);

  // 5. ✅ UTC 기준으로 날짜 문자열 생성
  const toIsoDate = (dt: Date): string => {
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(dt.getUTCDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
  };

  const monStr = toIsoDate(mondayDate);
  const sunStr = toIsoDate(sundayDate);

  const labelFormatter = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: timezone,
  });
  const label = `Mon ${labelFormatter.format(mondayDate)} - Sun ${labelFormatter.format(sundayDate)}`;

  return { monday: monStr, sunday: sunStr, label };
}
```

### 핵심 변경사항

1. **타임존 기준 요일 직접 계산**: `Intl.DateTimeFormat`의 `weekday` 옵션 사용
2. **Date.UTC() 사용**: 날짜 산술 시 타임존 shift 방지
3. **UTC 메서드 사용**: `getUTCFullYear()`, `setUTCDate()` 등 사용

---

## 검증

### 테스트 케이스

```typescript
// 경계 케이스 테스트
testCase('2026-08-02T06:59:00Z', '2026-07-27', '2026-08-02');
// LA 토요일 밤 11:59 PM → 이번 주 월~일

testCase('2026-08-03T07:00:00Z', '2026-08-03', '2026-08-09');
// LA 월요일 자정 → 다음 주 월~일

testCase('2026-08-03T07:01:00Z', '2026-08-03', '2026-08-09');
// LA 월요일 새벽 → 다음 주 월~일
```

**결과**: ✅ 모든 경계 케이스 통과

---

## 배포 체크리스트

### 1. Edge Functions 재배포 (필수!)

```bash
# 공유 로직이 변경되었으므로 두 함수 모두 재배포
supabase functions deploy plaid-sync
supabase functions deploy plaid-webhook
```

### 2. DB 상태 수정 (필수!)

```sql
-- 현재 저장된 week_monday 확인
SELECT id, carryover, week_monday, updated_at
FROM plaid_sync_state
WHERE id = 1;

-- 잘못된 week_monday 수정
-- 예: 2026-07-27이 저장되어 있고 실제 월요일이 2026-07-26이면
UPDATE plaid_sync_state
SET week_monday = '2026-07-26',  -- 올바른 월요일로 수정
    updated_at = NOW()
WHERE id = 1;
```

**올바른 week_monday 구하는 방법**:
1. LA 타임존 기준 오늘 날짜 확인
2. 오늘이 무슨 요일인지 확인
3. 이번 주 월요일 날짜 계산

예시:
```
오늘: 2026-07-31 (LA 기준 금요일)
→ 이번 주 월요일: 2026-07-27

오늘: 2026-08-01 (LA 기준 토요일)
→ 이번 주 월요일: 2026-07-27

오늘: 2026-08-03 (LA 기준 월요일)
→ 이번 주 월요일: 2026-08-03
```

### 3. Carryover 재계산 (선택사항)

잘못된 주간 경계로 인해 carryover가 틀어졌을 수 있습니다.

```sql
-- 지난 주(실제 주간 경계 기준) 지출 확인
SELECT SUM(amount) as total_spent
FROM plaid_budget_ledger
WHERE status IN ('pending', 'posted')
  AND transaction_date >= '2026-07-19'  -- 지난 주 월요일
  AND transaction_date <= '2026-07-25'; -- 지난 주 일요일

-- 수동으로 carryover 재계산
-- carryover = (지난 주 예산 + 지난 주 carryover) - 지난 주 지출
UPDATE plaid_sync_state
SET carryover = 380.00,  -- 계산된 값
    updated_at = NOW()
WHERE id = 1;
```

### 4. 동기화 테스트

```bash
# 로컬에서 수동 동기화 테스트
make sync-notify

# 또는
npm run sync:notify
```

예상 결과:
- 올바른 주간 경계로 계산됨
- 이번 주 지출 정확히 표시
- Slack 알림의 예산 정보 정상

---

## 영향 받은 기능

### 직접 영향

1. **주간 예산 계산**: 주간 경계가 틀어져 지출 합계 오류
2. **Carryover 계산**: 주가 바뀔 때 잘못된 경계로 계산
3. **Slack 알림**: 모든 알림의 예산 정보 부정확
4. **주간 요약**: `plaid_weekly_budget_summaries` 테이블에 잘못된 데이터 저장

### 간접 영향

- 사용자가 예산 관리를 신뢰할 수 없게 됨
- 잘못된 알림으로 인한 혼란
- 수동 예산 조정 필요

---

## 예방 조치

### 1. 타임존 테스트 추가

프로덕션 배포 전 경계 케이스 테스트:
```bash
deno run --allow-env test-week-edge-cases.ts
```

### 2. 모니터링

주간 경계 전환 시점(일요일 밤 11:59 PM ~ 월요일 12:01 AM LA 시간) 알림 확인

### 3. DB 검증 쿼리

정기적으로 실행:
```sql
-- week_monday가 실제 월요일인지 확인
SELECT
  week_monday,
  EXTRACT(DOW FROM week_monday) as day_of_week,  -- 1=Monday
  updated_at
FROM plaid_sync_state
WHERE id = 1;

-- day_of_week가 1이 아니면 버그!
```

---

## 참고 자료

- [MDN: Intl.DateTimeFormat](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat)
- [MDN: Date.getDay()](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/getDay)
- [Timezone-aware date calculations](https://stackoverflow.com/questions/15141762/how-to-initialize-a-javascript-date-to-a-particular-time-zone)

---

**수정일**: 2026-07-31
**커밋**: 65f7996
**영향 받은 파일**: `supabase/functions/_shared/budget.ts`
