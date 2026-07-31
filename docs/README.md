# 문서 디렉토리

Plaid Weekly Budget Tracker 프로젝트의 모든 문서를 모아놓은 디렉토리입니다.

---

## 📖 주요 문서

### 시스템 이해하기

- **[overview.md](./overview.md)** - 시스템 전체 개요
  - 아키텍처 다이어그램 및 데이터 흐름
  - 핵심 컴포넌트 설명
  - 예산 시스템 작동 원리
  - DB 스키마 및 환경 변수

### 배포 및 운영

- **[deployment-guide.md](./deployment-guide.md)** - 배포 가이드
  - Edge Functions 배포 절차
  - DB 마이그레이션 및 pg_cron 설정
  - 배포 후 검증 및 롤백 절차
  - 일반적인 배포 이슈 해결

---

## 🐛 버그 수정 내역

### Critical Bugs (2026-07-31)

- **[bugfix-timezone.md](./bugfix-timezone.md)** - 주간 경계 타임존 버그
  - UTC vs LA 타임존 요일 혼용 문제
  - 주간 경계가 하루씩 틀어지는 버그
  - 수정 전/후 코드 비교 및 배포 체크리스트

- **[bug-duplicate-ledger.md](./bug-duplicate-ledger.md)** - Pending → Posted 중복 Ledger 버그
  - 멱등성 위반으로 인한 중복 계산 문제
  - 발생 시나리오 및 DB 검증 쿼리
  - 수정 방안 비교 및 권장사항

---

## 📝 변경 이력

- **[CHANGELOG.md](./CHANGELOG.md)** - 전체 변경 이력
  - 버그 수정 상세 내역
  - 아키텍처 개선 사항
  - 문서 및 스크립트 추가 내역

---

## 🔗 관련 문서

프로젝트 루트의 문서도 참고하세요:

- **[../README.md](../README.md)** - 프로젝트 Quick Start
- **[../scripts/README.md](../scripts/README.md)** - 예산 조정 스크립트 가이드

---

## 📌 빠른 참조

### 처음 시작하는 경우
1. [overview.md](./overview.md) 읽기
2. [deployment-guide.md](./deployment-guide.md) 참고하여 배포
3. 환경 변수 설정 및 pg_cron 스케줄 등록

### 문제 해결
1. [CHANGELOG.md](./CHANGELOG.md)에서 최근 버그 수정 확인
2. 증상에 맞는 버그 문서 참고:
   - 예산 금액이 이상함 → [bugfix-timezone.md](./bugfix-timezone.md) 또는 [bug-duplicate-ledger.md](./bug-duplicate-ledger.md)
   - 배포 실패 → [deployment-guide.md](./deployment-guide.md)
3. [overview.md](./overview.md)의 트러블슈팅 체크리스트

### 코드 수정 후
1. 공유 모듈(`_shared/`) 수정 시 → 두 함수 모두 재배포 필수
2. DB 스키마 변경 시 → 마이그레이션 생성 및 실행
3. 환경 변수 추가 시 → Secrets 설정 및 함수 재배포

---

**문서 버전**: 1.0
**마지막 업데이트**: 2026-07-31
