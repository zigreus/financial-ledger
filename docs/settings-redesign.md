# 설정 UI 개편 설계서

> 작성일: 2026-04-12
> 상태: 검토 완료 → 구현 대기
> 관련 문서: [calendar-events-system-design.md](./calendar-events-system-design.md)

---

## 현재 문제

| 항목 | 현황 |
|---|---|
| 설정 탭 개수 | 가로 탭 5개 (결제수단, 카테고리, 여행, 예산, 정기지출) |
| 확장성 | 가져오기 추가 시 6개, 이후 계속 늘어날 구조 |
| PC/모바일 | 가로 탭이 좁은 화면에서 잘리거나 줄바꿈 발생 |
| 여행 탭 | 캘린더 탭 신설 후 중복 → 제거 또는 통합 필요 |

---

## 채택 방안: iOS Settings 스타일 목록 내비게이션

앱 전체가 max-width 640px 단일 레이아웃 (PC/모바일 동일)이므로,  
사이드바 방식보다 **세로 목록 + 드릴다운** 방식이 일관성 있고 확장 제한 없음.

### 변경 전/후 비교

**현재**
```
┌──────────────────────────────────┐
│ [결제수단][카테고리][여행][예산][정기지출] │  ← 가로 탭
└──────────────────────────────────┘
│  섹션 본문                         │
```

**변경 후**
```
┌──────────────────────────────────┐
│ 설정                              │
├──────────────────────────────────┤
│ 마스터 데이터                      │  ← 그룹 레이블
│  결제수단                    >    │
│  카테고리                    >    │
├──────────────────────────────────┤
│ 재무 설정                          │
│  예산                        >    │
│  정기지출                    >    │
├──────────────────────────────────┤
│ 데이터 관리                        │
│  가져오기                    >    │
│  (내보내기 — 추후 추가 가능)  >    │
└──────────────────────────────────┘
```

각 행 탭 시 → 해당 섹션 화면으로 전환 (기존 drilldown 패턴과 동일)  
상단에 `< 설정` 뒤로가기 버튼으로 복귀.

---

## 세부 구조

### 그룹 1: 마스터 데이터

| 항목 | 현재 섹션명 | 변경 없는 기능 |
|---|---|---|
| 결제수단 | `payment` | 그대로 |
| 카테고리 | `category` | 그대로 |

> ⚠️ **여행** 섹션은 캘린더 탭으로 이관 후 **설정에서 제거**.  
> trips 테이블 자체는 레거시로 DB에 보존.

### 그룹 2: 재무 설정

| 항목 | 현재 섹션명 | 변경 없는 기능 |
|---|---|---|
| 예산 | `budget` | 그대로 |
| 정기지출 | `recurring` | 그대로 |

### 그룹 3: 데이터 관리

| 항목 | 현재 위치 | 변경 |
|---|---|---|
| 가져오기 | 하단 네비 전용 버튼 → 전체 모달 | 설정 내 섹션으로 이동 |
| 내보내기 | 미구현 | 추후 확장 슬롯 확보 |

---

## 컴포넌트 변경 계획

### App.js
- `settingsSection` 초기값: `'list'` (목록 화면)
- 섹션 전환 시 기존 `onSectionChange` 그대로 활용
- `'list'` → 목록 화면 렌더링 (신규)
- `'payment'` / `'category'` / `'budget'` / `'recurring'` → 기존 섹션 그대로 렌더링
- `'import'` → ImportModal 대신 인라인 섹션으로 렌더링

### SettingsView.js

**현재**: 상단 탭 바 → 섹션 본문  
**변경**: 
```
activeSection === 'list'   → <SettingsList /> (새 목록 컴포넌트)
activeSection === 'payment' → 기존 결제수단 섹션
activeSection === 'category'→ 기존 카테고리 섹션
activeSection === 'budget'  → 기존 예산 섹션
activeSection === 'recurring'→ 기존 정기지출 섹션
activeSection === 'import'  → ImportModal 인라인 버전
```

- 기존 `<div className="settings-tabs">` 삭제
- `showDrilldownBack` 조건에 `'list'` 제외 (목록 화면에서는 back 버튼 없음)

### SettingsView.css
- `.settings-tabs` 관련 스타일 → 삭제
- 목록 스타일 추가 (그룹 레이블, 행, 화살표)

---

## 목록 UI 스타일 가이드

```css
/* 그룹 레이블 */
.settings-group-label {
  padding: 16px 16px 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

/* 개별 항목 행 */
.settings-list-item {
  display: flex;
  align-items: center;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  cursor: pointer;
  gap: 12px;
}
.settings-list-item:active { background: var(--bg); }

/* 항목 아이콘 */
.settings-list-icon { font-size: 18px; flex-shrink: 0; }

/* 항목 라벨 */
.settings-list-label { flex: 1; font-size: 15px; font-weight: 500; }

/* 우측 화살표 */
.settings-list-chevron { color: var(--text-muted); }
```

---

## 가져오기 이관 처리

현재 흐름:
```
하단 네비 "가져오기" 버튼 → navigate({ showImport: true })
→ <ImportModal> 전체화면 모달
```

변경 흐름:
```
설정 목록 > "가져오기" 행 탭 → settingsSection = 'import'
→ SettingsView 내부에서 ImportModal 콘텐츠 인라인 렌더링
→ 완료 시 onChanged() 호출 (기존과 동일)
```

App.js에서 `showImport` state 및 `<ImportModal>` 렌더링 제거.  
ImportModal 컴포넌트는 재사용하거나 SettingsView 내부로 흡수.

---

## 구현 시 주의사항

- `settingsDrilldownCategory`, `settingsDrilldownTrip`, `settingsDrilldownPayment` 등  
  기존 drilldown state는 유지하되, `settingsSection = 'list'` 일 때는 모두 null로 초기화
- 브라우저 뒤로가기 지원: 현재 `navigate()` 패턴 그대로 사용하므로 자동 지원
- 설정 목록 화면 스크롤은 App.js의 `.app-main` 스크롤과 동일

---

> 관련 문서: [calendar-events-system-design.md](./calendar-events-system-design.md)
