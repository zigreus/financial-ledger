import React, { useMemo, useState } from 'react';
import ModalOverlay from '../common/ModalOverlay';
import { categoryColor } from '../common/categoryColor';
import { STARTER_TEMPLATES } from '../../data/starterTemplates';
import { applyStarterSetup, starterSetupProblems, STARTER_NAME_MAX } from '../../services/dbManager';
import './Onboarding.css';

const toItems = (names) => names.map(name => ({ name, on: true }));

/**
 * 첫 실행 안내 (ROADMAP F-3, I-019) — 새 가계부에 기본 카테고리·결제수단을 넣는다.
 *  1) 가구 유형 고르기  2) 넣을 항목 다듬기  3) 확정할 때 한 번에 쓰기(그 전에는 가계부에 아무것도 쓰지 않는다, §2-3)
 * App은 가계부가 비어 있을 때(isBlankLedger)만 이 화면을 보여 준다.
 *
 * accountLabel: 새 가계부가 만들어진 곳(예: 'me@outlook.com의 OneDrive') — 가족이 쓰는 계정과 다른 계정으로 잘못
 *   로그인한 사람이 두 번째 가계부를 꾸미지 않게 알려 준다(가족은 같은 계정으로 로그인해 한 가계부를 쓴다)
 * onDone(counts): 넣은 뒤 — { categories, subCategories, paymentMethods }
 * onClose(): 이번만 닫는다(✕·뒤로가기) — 다음에 열 때 다시 보여 준다
 * onLater(): 이 기기에서 다음부터 저절로 열지 않는다(거래내역 빈 화면에서 다시 열 수 있다)
 * onOpenImport(): 이미 쓰던 가계부를 CSV로 가져온다
 */
export default function Onboarding({ db, accountLabel, onDone, onClose, onLater, onOpenImport }) {
  const [template, setTemplate] = useState(null);
  const [categories, setCategories] = useState([]); // [{ name, on, subs: [{ name, on }] }]
  const [payments, setPayments] = useState([]);     // [{ name, on }]
  const [newPayment, setNewPayment] = useState('');
  const [error, setError] = useState('');

  const pick = (t) => {
    setTemplate(t);
    setCategories(t.categories.map(c => ({ name: c.name, on: true, subs: toItems(c.subs) })));
    setPayments(toItems(t.paymentMethods));
    setNewPayment('');
    setError('');
  };

  const setup = useMemo(() => ({
    categories: categories.filter(c => c.on).map(c => ({ name: c.name, subs: c.subs.filter(s => s.on).map(s => s.name) })),
    paymentMethods: payments.filter(p => p.on).map(p => p.name),
  }), [categories, payments]);
  const problems = useMemo(() => starterSetupProblems(setup), [setup]);

  const toggleCategory = (ci) => {
    setCategories(list => list.map((c, i) => (i === ci ? { ...c, on: !c.on } : c)));
  };
  const toggleSub = (ci, si) => {
    setCategories(list => list.map((c, i) => (i !== ci ? c : {
      ...c, subs: c.subs.map((s, j) => (j === si ? { ...s, on: !s.on } : s)),
    })));
  };
  const togglePayment = (pi) => {
    setPayments(list => list.map((p, i) => (i === pi ? { ...p, on: !p.on } : p)));
  };
  const addPayment = () => {
    const name = newPayment.trim();
    if (!name) return;
    setPayments(list => (list.some(p => p.name === name)
      ? list.map(p => (p.name === name ? { ...p, on: true } : p))
      : [...list, { name, on: true }]));
    setNewPayment('');
  };

  const confirm = () => {
    if (problems.length) return;
    try {
      const counts = applyStarterSetup(db, setup);
      onDone(counts);
    } catch (e) {
      setError(e.message);
    }
  };

  const chosenCount = setup.categories.length;

  return (
    <ModalOverlay className="modal-overlay" panelClassName="modal-content onboarding">
      <div className="modal-header">
        <h2>{template ? `${template.icon} ${template.label}` : '가계부를 시작해요'}</h2>
        <button className="modal-close" onClick={onClose} aria-label="닫기">✕</button>
      </div>

      {!template ? (
        <div className="onb-body">
          <p className="onb-lead">
            어떤 살림인지 고르면 자주 쓰는 카테고리와 결제수단을 넣어 드려요.
            다음 화면에서 필요 없는 항목은 빼고 쓰는 카드는 더할 수 있어요. 넣은 뒤에도 설정에서 언제든 바꿀 수 있어요.
          </p>
          {accountLabel && (
            <p className="onb-account">
              <strong>{accountLabel}</strong>에 새 가계부가 만들어졌어요.
              가족이 이미 이 앱으로 가계부를 쓰고 있다면 여기서 꾸미지 말고, 가족이 쓰는 계정으로 다시 로그인하세요.
            </p>
          )}
          <div className="onb-templates">
            {STARTER_TEMPLATES.map(t => (
              <button key={t.id} type="button" className="onb-template" onClick={() => pick(t)}>
                <span className="onb-template-icon" aria-hidden="true">{t.icon}</span>
                <span className="onb-template-body">
                  <strong>{t.label}</strong>
                  <span className="onb-template-desc">{t.description}</span>
                  <span className="onb-template-cats">{t.categories.map(c => c.name).join(' · ')}</span>
                </span>
              </button>
            ))}
          </div>
          <div className="onb-alt">
            <button type="button" className="onb-link" onClick={onOpenImport}>이미 쓰던 가계부(CSV)가 있어요 — 가져오기</button>
            <button type="button" className="onb-link" onClick={onLater}>나중에 할게요</button>
          </div>
        </div>
      ) : (
        <div className="onb-body">
          <p className="onb-lead">모두 넣을 준비가 되어 있어요. 필요 없는 항목만 눌러서 빼세요 — 줄이 그어진 항목은 넣지 않아요.</p>

          <section className="onb-section">
            <h3>카테고리 <span className="onb-count">{chosenCount}개</span></h3>
            {categories.map((c, ci) => (
              <div key={c.name} className={`onb-cat${c.on ? '' : ' off'}`}>
                <label className="onb-cat-head">
                  <input type="checkbox" checked={c.on} onChange={() => toggleCategory(ci)} />
                  <span className="onb-dot" style={{ background: categoryColor(c.name) }} aria-hidden="true" />
                  {c.name}
                </label>
                <div className="onb-chips">
                  {c.subs.map((s, si) => (
                    <button
                      key={s.name}
                      type="button"
                      className={`onb-chip${s.on && c.on ? ' on' : ''}`}
                      aria-pressed={s.on && c.on}
                      disabled={!c.on}
                      onClick={() => toggleSub(ci, si)}
                    >
                      {s.name}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </section>

          <section className="onb-section">
            <h3>결제수단 <span className="onb-count">{setup.paymentMethods.length}개</span></h3>
            <div className="onb-chips">
              {payments.map((p, pi) => (
                <button
                  key={p.name}
                  type="button"
                  className={`onb-chip${p.on ? ' on' : ''}`}
                  aria-pressed={p.on}
                  onClick={() => togglePayment(pi)}
                >
                  {p.name}
                </button>
              ))}
            </div>
            <div className="onb-add">
              <input
                type="text"
                value={newPayment}
                maxLength={STARTER_NAME_MAX}
                placeholder="카드 이름 추가 (예: 신한카드)"
                aria-label="결제수단 이름"
                onChange={e => setNewPayment(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addPayment(); } }}
              />
              <button type="button" className="btn-secondary" onClick={addPayment} disabled={!newPayment.trim()}>추가</button>
            </div>
            <p className="onb-hint">카드별로 나눠 보고 싶으면 쓰는 카드 이름을 더하세요. 나중에 설정 › 결제수단에서도 더할 수 있어요.</p>
          </section>

          {/* 시작 버튼이 왜 안 눌리는지 버튼 바로 위에 보인다 — 긴 목록을 스크롤해 찾지 않게 */}
          <div className="onb-footer">
            {(problems.length > 0 || error) && (
              <p className="onb-problem" role="alert">{error || problems[0]}</p>
            )}
            <div className="onb-actions">
              <button type="button" className="btn-secondary" onClick={() => { setTemplate(null); setError(''); }}>이전</button>
              <button type="button" className="btn-primary" onClick={confirm} disabled={problems.length > 0}>
                이대로 시작하기
              </button>
            </div>
          </div>
        </div>
      )}
    </ModalOverlay>
  );
}
