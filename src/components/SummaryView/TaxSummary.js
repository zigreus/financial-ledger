import React, { useMemo, useState } from 'react';
import {
  getTaxSummary, getTaxClassification, setPaymentMethodTaxType, setCategoryTaxTag, setSubCategoryTaxTag,
  TAX_TYPES, TAX_TAGS, TAX_TAG_NONE,
} from '../../services/dbManager';
import { formatAmount } from '../../services/formulaEvaluator';
import { useDbSnapshot } from '../../hooks/useDbSnapshot';
import './TaxSummary.css';

const won = n => `${formatAmount(Math.round(n))}원`;

/**
 * 요약 › 연말정산 (I-029, ROADMAP C-10) — 한 해 결제를 결제수단 유형·항목(의료비 등)별로 더한 참고 합계.
 * 공제액은 계산하지 않는다. 결제수단 유형과 카테고리 항목은 아래 '분류 정하기'에서 고른다(가족 공통, 가계부에 저장).
 * years: 고를 수 있는 해(새 것부터), year: 보는 해, onYearChange(y), onChanged: 분류를 바꾼 뒤 저장 알림
 */
export default function TaxSummary({ db, dataVersion, year, years, onYearChange, onChanged }) {
  const live = useDbSnapshot(db, dataVersion);
  const summary = useMemo(() => getTaxSummary(live.db, year), [live, year]);
  const classes = useMemo(() => getTaxClassification(live.db), [live]);
  const [openType, setOpenType] = useState(null);
  const [editing, setEditing] = useState(false);
  const [subsOpen, setSubsOpen] = useState(() => new Set());   // 세부카테고리까지 펼친 카테고리(화면에서만)
  const yearList = years.includes(year) ? years : [year, ...years].sort().reverse();

  const changeType = (name, type) => { setPaymentMethodTaxType(db, name, type); onChanged && onChanged(); };
  const changeCatTag = (name, tag) => { setCategoryTaxTag(db, name, tag); onChanged && onChanged(); };
  const changeSubTag = (cat, sub, tag) => { setSubCategoryTaxTag(db, cat, sub, tag); onChanged && onChanged(); };

  // 분류 정하기: 숨긴 결제수단·카테고리는 이 해에 쓴 것이거나 이미 정해 둔 것만
  const usedMethods = new Set(summary.types.flatMap(t => t.methods.map(m => m.name)));
  const usedCategories = new Set(summary.usedCategories);
  const methods = classes.methods.filter(m => !m.hidden || usedMethods.has(m.name) || m.taxType);
  const categories = classes.categories.filter(c => !c.hidden || usedCategories.has(c.name) || c.taxTag || c.subs.some(s => s.taxTag));

  return (
    <div className="tax">
      <div className="tax-head">
        <select value={year} onChange={e => onYearChange(e.target.value)} aria-label="연도">
          {yearList.map(y => <option key={y} value={y}>{y}년</option>)}
        </select>
        <span className="tax-head-note">공제액은 계산하지 않아요 — 홈택스 연말정산 간소화 자료와 견주어 보는 참고 합계예요.</span>
      </div>

      {summary.total.count === 0 && summary.foreign.count === 0 ? (
        <div className="tax-empty">{year}년에는 거래가 없어요.</div>
      ) : (
        <>
          <div className="tax-total">
            <strong>{won(summary.total.amount)}</strong>
            <span> · {summary.total.count}건 결제</span>
            {summary.total.discount > 0 && (
              <div className="tax-sub">
                할인 {won(summary.total.discount)}을 빼기 전 결제액이에요(카드 할인은 대부분 나중에 돌려받아서).
                결제할 때 바로 깎인 할인(즉시할인·쿠폰)이면 홈택스 금액은 그만큼 적을 수 있어요.
              </div>
            )}
            {summary.upcoming.count > 0 && (
              <div className="tax-sub">
                오늘 이후 날짜로 미리 등록된 {summary.upcoming.count}건({won(summary.upcoming.amount)})은 아직 내지 않아 뺐어요.
              </div>
            )}
          </div>

          {summary.untypedMethods.length > 0 && (
            <div className="tax-warn" role="note">
              유형을 정하지 않은 결제수단이 있어요: {summary.untypedMethods.join(', ')} — 아래 &apos;분류 정하기&apos;에서 고르세요.
            </div>
          )}
          {summary.missingMethods.length > 0 && (
            <div className="tax-warn" role="note">
              결제수단 목록에 없는 결제수단으로 쓴 거래가 있어요: {summary.missingMethods.join(', ')} — 설정 › 결제수단에 같은 이름으로 다시 추가하면 유형을 고를 수 있어요.
            </div>
          )}

          <div className="tax-block">
            <div className="tax-block-title">결제수단 유형별</div>
            <ul className="tax-list">
              {summary.types.filter(t => t.count > 0).map(t => (
                <li key={t.key || 'none'}>
                  <button
                    type="button"
                    className="tax-row tax-row-btn"
                    onClick={() => setOpenType(openType === t.key ? null : t.key)}
                    aria-expanded={openType === t.key}
                  >
                    <span className="tax-row-name">
                      {t.label}{(t.key === 'cash' || t.key === 'other') && <small> · 카드 공제 대상 아님</small>}
                      {t.discount > 0 && <small> · 할인 {won(t.discount)} 빼기 전</small>}
                    </span>
                    <span className="tax-row-value">{won(t.amount)} <small>{t.count}건</small></span>
                  </button>
                  {openType === t.key && (
                    <ul className="tax-sublist">
                      {t.methods.map(m => (
                        <li key={m.name} className="tax-row tax-row--sub">
                          <span className="tax-row-name">{m.name}</span>
                          <span className="tax-row-value">{won(m.amount)} <small>{m.count}건</small></span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </div>

          <div className="tax-block">
            <div className="tax-block-title">항목별</div>
            {summary.tags.length === 0 ? (
              <div className="tax-muted">
                항목을 정한 카테고리가 없어요 — 의료비·교육비·대중교통처럼 따로 볼 카테고리를 &apos;분류 정하기&apos;에서 고르세요.
              </div>
            ) : (
              <ul className="tax-list">
                {summary.tags.map(g => (
                  <li key={g.tag}>
                    <div className="tax-row">
                      <span className="tax-row-name">
                        <b>{g.tag}</b>
                        {g.notCard !== 0 && <small> · 카드·현금영수증으로 정하지 않은 결제 {won(g.notCard)} 포함</small>}
                      </span>
                      <span className="tax-row-value">{won(g.amount)} <small>{g.count}건</small></span>
                    </div>
                    <ul className="tax-sublist">
                      {g.parts.map(p => (
                        <li key={`${p.category}/${p.sub}`} className="tax-row tax-row--sub">
                          <span className="tax-row-name">{p.category}{p.sub ? ` › ${p.sub}` : ''}</span>
                          <span className="tax-row-value">{won(p.amount)}</span>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {summary.foreign.count > 0 && (
            <div className="tax-muted">
              해외 결제(외화 금액이 있는 거래) {won(summary.foreign.amount)} · {summary.foreign.count}건은 카드 소득공제에서 빠지는 결제라 위 합계에서 뺐어요.
            </div>
          )}
        </>
      )}

      <button type="button" className="tax-edit-toggle" onClick={() => setEditing(v => !v)} aria-expanded={editing}>
        {editing ? '분류 정하기 닫기' : '분류 정하기'}
      </button>
      {editing && (
        <div className="tax-edit">
          <div className="tax-block-title">결제수단 유형</div>
          <ul className="tax-list">
            {methods.map(m => (
              <li key={m.name} className="tax-row">
                <span className="tax-row-name">{m.name}{m.hidden && <small> · 숨김</small>}</span>
                <select
                  aria-label={`${m.name} 유형`}
                  value={m.taxType}
                  onChange={e => changeType(m.name, e.target.value)}
                >
                  <option value="">유형 미정</option>
                  {TAX_TYPES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
                </select>
              </li>
            ))}
          </ul>
          <div className="tax-block-title" style={{ marginTop: 12 }}>카테고리 항목</div>
          <div className="tax-muted">
            세부카테고리는 따로 고르지 않으면 카테고리를 따라가요(예: 교통은 대중교통, 교통 › 택시는 해당 없음).
            전통시장처럼 카테고리로 나뉘지 않는 것은 세부카테고리(예: 장보기 › 전통시장)를 만들어 고르세요.
            항목별 합계는 결제수단과 관계없이 더해요 — 대중교통·전통시장·문화는 홈택스에서 카드·현금영수증 사용분만 잡혀요.
          </div>
          <ul className="tax-list">
            {categories.map(c => (
              <li key={c.name}>
                <div className="tax-row">
                  <span className="tax-row-name">{c.name}{c.hidden && <small> · 숨김</small>}</span>
                  <select aria-label={`${c.name} 항목`} value={c.taxTag} onChange={e => changeCatTag(c.name, e.target.value)}>
                    <option value="">해당 없음</option>
                    {TAX_TAGS.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                {c.subs.length > 0 && (c.taxTag || c.subs.some(s => s.taxTag) || subsOpen.has(c.name)) && (
                  <ul className="tax-sublist">
                    {c.subs.map(s => (
                      <li key={s.name} className="tax-row tax-row--sub">
                        <span className="tax-row-name">{s.name}{s.hidden && <small> · 숨김</small>}</span>
                        <select
                          aria-label={`${c.name} › ${s.name} 항목`}
                          value={s.taxTag}
                          onChange={e => changeSubTag(c.name, s.name, e.target.value)}
                        >
                          <option value="">카테고리 따라감{c.taxTag ? ` · ${c.taxTag}` : ''}</option>
                          <option value={TAX_TAG_NONE}>해당 없음</option>
                          {TAX_TAGS.map(t => <option key={t} value={t}>{t}</option>)}
                        </select>
                      </li>
                    ))}
                  </ul>
                )}
                {c.subs.length > 0 && !c.taxTag && !c.subs.some(s => s.taxTag) && !subsOpen.has(c.name) && (
                  <button type="button" className="tax-link" onClick={() => setSubsOpen(prev => new Set([...prev, c.name]))}>
                    세부카테고리별로 고르기
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
