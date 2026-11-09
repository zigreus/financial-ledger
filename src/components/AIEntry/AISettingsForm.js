import React, { useState, useRef, useEffect, useCallback } from 'react';
import { PROVIDERS, getAIConfig, updateAIConfig, activeAI, listModels } from '../../services/aiClient';
import { syncAISettings, onAISettingsPulled } from '../../services/aiSettingsSync';
import { currentDriveName } from '../../services/storage/driveName';
import './AIEntry.css';

// 이미 열려 있는 다른 기기의 앱은 앱으로 돌아오거나 다시 열 때 드라이브(OneDrive·Google Drive)를 확인한다 (App)
const LATER = '앱으로 돌아오거나 다시 열면';
const saveFail = () => `이 기기에는 저장했지만 ${currentDriveName()}에 올리지 못했습니다 — 앱으로 돌아오거나 다시 열 때 다시 올립니다`;
const deleteFail = () => `이 기기에서는 지웠지만 ${currentDriveName()}에 알리지 못했습니다 — 앱으로 돌아오거나 다시 열 때 다시 시도합니다`;
const NO_KEY_HINT = '다른 기기에 키를 넣어 두었다면, 그 기기에서 가계부 앱을 한 번 연 뒤 이 화면을 다시 열면 자동으로 채워집니다';

const hasAnyKey = c => Object.values(c.keys).some(k => k.trim());
// provider: 이 공급자 칸을 보고 있음(받아 온 값이 화면을 돌리지 않게), picked: 공급자 버튼을 직접 누름
const noEdits = () => ({ provider: false, picked: false, keys: {}, models: {} });

/**
 * AI 설정 — 공급자 선택, API 키, 모델.
 * 설정 화면과 AI 입력(처음 사용할 때) 양쪽에서 쓴다.
 * 저장·삭제는 같은 Microsoft 계정의 다른 기기에도 반영된다 (OneDrive의 별도 설정 파일, aiSettingsSync).
 *
 * 사용자가 손댄 칸만 기억한다(edited). 다른 기기 설정을 받아 오면 손대지 않은 칸만 새 값으로 바꾸고,
 * 저장할 때도 손댄 칸만 저장한다 — 화면에 남아 있던 옛 값으로 다른 기기의 변경(키 삭제 등)을 되돌리지 않게.
 */
export default function AISettingsForm({ onSaved, onCancel, compact = false }) {
  const [config, setConfig] = useState(getAIConfig);
  const [models, setModels] = useState([]);
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState(null); // { ok, text }
  // 진행 중인 '연결 확인' — 공급자나 키를 바꾸면 취소해, 이전 공급자의 모델 목록이 새 공급자에 섞이지 않게 한다
  const checkRef = useRef(null);
  const editedRef = useRef(noEdits());
  const mountedRef = useRef(false);
  const shareSeqRef = useRef(0);       // 마지막으로 시작한 공유 — 앞선 공유의 결과가 상태를 덮지 않게

  const isEdited = () => {
    const e = editedRef.current;
    return e.provider || Object.keys(e.keys).length > 0 || Object.keys(e.models).length > 0;
  };

  /** 저장된 최신 값으로 화면을 바꾸되, 사용자가 손댄 칸은 그대로 둔다 */
  const refresh = useCallback(() => {
    const fresh = getAIConfig();
    const e = editedRef.current;
    setConfig(c => {
      const pick = (field, edited) => Object.fromEntries(
        Object.keys(fresh[field]).map(p => [p, edited[p] ? c[field][p] : fresh[field][p]]),
      );
      return { ...fresh, provider: e.provider ? c.provider : fresh.provider, keys: pick('keys', e.keys), models: pick('models', e.models) };
    });
  }, []);

  // 열 때 OneDrive의 최신 설정을 확인하고, 열려 있는 동안 다른 동기화(앱 시작·앱으로 돌아옴)가 받아 온 값도 보인다.
  // 앱을 열자마자 AI 입력을 눌러 시작 동기화보다 먼저 이 화면이 열려도 다른 기기에서 넣은 키를 다시 입력하지 않게.
  useEffect(() => {
    mountedRef.current = true;
    const hadKey = hasAnyKey(getAIConfig());
    const unsubscribe = onAISettingsPulled(() => { if (mountedRef.current) refresh(); });
    syncAISettings()
      .catch(() => { /* 오프라인 등 — 직접 입력하면 된다 */ })
      .then(() => {
        if (!mountedRef.current) return;
        refresh();
        if (isEdited()) return;
        const now = getAIConfig();
        if (!hadKey && activeAI(now)) {
          setStatus({
            ok: true,
            text: `다른 기기에서 저장한 AI 설정을 불러왔습니다${compact ? ' — 저장하고 계속을 누르세요' : ''}`,
          });
        } else if (!hasAnyKey(now)) {
          setStatus({ ok: true, text: NO_KEY_HINT });
        }
      });
    return () => { mountedRef.current = false; unsubscribe(); };
  }, [compact, refresh]);

  const cancelCheck = () => {
    if (checkRef.current) checkRef.current.abort();
    checkRef.current = null;
    setChecking(false);
  };
  useEffect(() => () => { if (checkRef.current) checkRef.current.abort(); }, []);

  const provider = config.provider;
  // 공급자가 바뀌면(직접 고르거나 받아 온 값으로) 이전 공급자의 모델 목록을 비운다
  // (받아 온 값으로 바뀐 경우에도 진행 중인 '연결 확인'을 취소해, 이전 공급자의 모델 목록이 섞이지 않게 한다)
  useEffect(() => {
    if (checkRef.current) {
      checkRef.current.abort();
      checkRef.current = null;
      setChecking(false);
    }
    setModels([]);
  }, [provider]);
  const info = PROVIDERS[provider];
  const apiKey = config.keys[provider] || '';
  const model = config.models[provider] || info.defaultModel;

  const update = (patch) => {
    const e = editedRef.current;
    // 키·모델을 고치는 중이면 그 공급자를 고른 것으로 본다 — 받아 온 값이 다른 공급자로 화면을 돌리지 않게
    if (patch.provider || patch.keys || patch.models) e.provider = true;
    if (patch.provider) e.picked = true;
    Object.keys(patch.keys || {}).forEach(p => { e.keys[p] = true; });
    Object.keys(patch.models || {}).forEach(p => { e.models[p] = true; });
    setConfig(c => ({
      ...c,
      provider: patch.provider ?? c.provider,
      keys: { ...c.keys, ...(patch.keys || {}) },
      models: { ...c.models, ...(patch.models || {}) },
    }));
  };

  const switchProvider = (p) => {
    if (p === provider) return;
    cancelCheck();
    update({ provider: p });
    setStatus(null);
  };

  const checkConnection = async () => {
    cancelCheck();
    const controller = new AbortController();
    checkRef.current = controller;
    const checkedProvider = provider;
    setChecking(true);
    setStatus(null);
    try {
      const list = await listModels(checkedProvider, apiKey.trim(), { signal: controller.signal });
      if (controller.signal.aborted) return;
      setModels(list);
      if (list.length && !list.includes(config.models[checkedProvider])) {
        update({ models: { [checkedProvider]: list[0] } });
      }
      setStatus({ ok: true, text: `연결됨 · 사용 가능한 모델 ${list.length}개` });
    } catch (e) {
      if (controller.signal.aborted || e.name === 'AbortError') return;
      setStatus({ ok: false, text: e.message });
    } finally {
      if (checkRef.current === controller) {
        checkRef.current = null;
        setChecking(false);
      }
    }
  };

  /** 이 기기에 저장한 뒤 OneDrive와 맞춘다. 실패해도 이 기기는 바로 쓸 수 있고, 올릴 것은 남아 다음에 다시 올린다 */
  const share = (doneText, failText) => {
    const seq = ++shareSeqRef.current;
    syncAISettings()
      .then(result => {
        if (!mountedRef.current) return;
        refresh();
        if (seq !== shareSeqRef.current) return;   // 그 사이 또 저장했으면 마지막 저장의 결과만 보인다
        const left = Object.keys(getAIConfig().pending).length > 0;
        setStatus(result === 'offline' || result === 'cancelled' || left
          ? { ok: false, text: failText }
          : { ok: true, text: doneText });
      })
      .catch(() => { if (mountedRef.current && seq === shareSeqRef.current) setStatus({ ok: false, text: failText }); });
  };

  const save = () => {
    cancelCheck();
    // 손댄 칸만 저장한다 — 고른 공급자, 그리고 키·모델을 고친 공급자마다 (다른 공급자 칸에 넣던 키도 버리지 않는다)
    const e = editedRef.current;
    const patch = { keys: {}, models: {} };
    if (e.provider) patch.provider = provider;
    // 빈 칸은 저장하지 않는다 — 키 삭제는 확인을 받는 '키 삭제'로만 (보이는 칸은 비어 있으면 저장 버튼이 꺼진다)
    Object.keys(e.keys).forEach(p => { if ((config.keys[p] || '').trim()) patch.keys[p] = config.keys[p]; });
    Object.keys(e.models).forEach(p => { patch.models[p] = config.models[p] || ''; });
    const stored = updateAIConfig(patch, { pickProvider: e.picked });
    editedRef.current = noEdits();
    refresh();
    setStatus({ ok: true, text: '저장했습니다' });
    if (Object.keys(stored.pending).length) {
      // 고른 공급자도 함께 맞추는 설정이라, 공급자를 바꿨으면 모든 기기가 그 공급자를 쓴다고 알린다
      const shared = stored.pending.provider
        ? `같은 계정으로 로그인한 모든 기기가 이제 ${PROVIDERS[stored.provider].label.split(' ')[0]}를 씁니다`
        : '같은 계정으로 로그인한 휴대폰·PC에서도 쓸 수 있습니다';
      share(`저장했습니다 — ${shared} (이미 열려 있는 앱은 ${LATER} 반영)`, saveFail());
    }
    if (onSaved) onSaved(stored);
  };

  const removeKey = () => {
    const name = info.label.split(' ')[0];
    if (!window.confirm(
      `${name} API 키를 이 기기와 ${currentDriveName()}에서 지웁니다.\n`
      + '같은 계정으로 로그인한 다른 기기(가족 휴대폰 포함)에서도 앱으로 돌아오거나 다시 열면 지워집니다.\n지울까요?',
    )) return;
    cancelCheck();
    updateAIConfig({ keys: { [provider]: '' } });
    editedRef.current = noEdits();
    refresh();
    setModels([]);
    setStatus({ ok: true, text: `${name} 키를 이 기기에서 지웠습니다` });
    share(`${name} 키를 이 기기와 ${currentDriveName()}에서 지웠습니다 — 다른 기기는 ${LATER} 지워집니다`, deleteFail());
  };

  const modelOptions = models.length ? models : [model];
  const storedKey = getAIConfig().keys[provider]; // 삭제는 저장된 키가 있을 때만

  return (
    <div className={`ai-settings${compact ? ' ai-settings--compact' : ''}`}>
      <div className="ai-field">
        <label>사용할 AI</label>
        <div className="ai-provider-row">
          {Object.entries(PROVIDERS).map(([key, p]) => (
            <button
              key={key}
              type="button"
              className={`ai-provider${provider === key ? ' active' : ''}`}
              onClick={() => switchProvider(key)}
            >{p.label}</button>
          ))}
        </div>
      </div>

      <div className="ai-field">
        <label>API 키</label>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={apiKey}
          onChange={e => { cancelCheck(); update({ keys: { [provider]: e.target.value } }); setStatus(null); }}
          placeholder={info.keyPlaceholder}
        />
        <span className="ai-help">{info.keyHelp}</span>
      </div>

      <div className="ai-field">
        <label>모델</label>
        <div className="ai-model-row">
          <select value={model} onChange={e => update({ models: { [provider]: e.target.value } })}>
            {modelOptions.map(m => (
              <option key={m} value={m}>{m}{m === info.defaultModel ? ' (추천)' : ''}</option>
            ))}
          </select>
          <button type="button" className="ai-btn-secondary" disabled={!apiKey.trim() || checking} onClick={checkConnection}>
            {checking ? '확인 중…' : '연결 확인'}
          </button>
        </div>
        {status && <span className={`ai-status${status.ok ? ' ok' : ' err'}`}>{status.text}</span>}
      </div>

      <div className="ai-privacy">
        영수증 사진과 함께 <b>결제수단·카테고리 목록</b>과 <b>최근 세부내역 입력 습관</b>(가게 이름·분류·횟수)이
        선택한 AI로 전송됩니다. API 키는 가계부 파일과 따로, 로그인한 계정의 {currentDriveName()} 설정 파일에 저장되어
        <b> 같은 계정으로 로그인한 휴대폰·PC에서는 다시 입력하지 않아도 됩니다.</b>
      </div>

      <div className="ai-actions">
        {storedKey && !compact && (
          <button type="button" className="ai-btn-danger" onClick={removeKey}>키 삭제 (모든 기기)</button>
        )}
        {onCancel && <button type="button" className="ai-btn-secondary" onClick={onCancel}>취소</button>}
        <button type="button" className="ai-btn-primary" disabled={!apiKey.trim()} onClick={save}>
          {compact ? '저장하고 계속' : '저장'}
        </button>
      </div>
    </div>
  );
}
