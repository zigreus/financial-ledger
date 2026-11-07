import React, { useState, useRef, useEffect } from 'react';
import { PROVIDERS, getAIConfig, saveAIConfig, listModels } from '../../services/aiClient';
import { syncAISettings, pushAISettings } from '../../services/aiSettingsSync';
import './AIEntry.css';

const SHARE_FAIL = '이 기기에는 저장했지만 다른 기기 공유는 실패했습니다 — 다음에 앱을 열 때 다시 시도합니다';

/**
 * AI 설정 — 공급자 선택, API 키, 모델.
 * 설정 화면과 AI 입력(처음 사용할 때) 양쪽에서 쓴다.
 * 저장·삭제는 같은 Microsoft 계정의 다른 기기에도 반영된다 (OneDrive의 별도 설정 파일).
 */
export default function AISettingsForm({ onSaved, onCancel, compact = false }) {
  const [config, setConfig] = useState(getAIConfig);
  const [models, setModels] = useState([]);
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState(null); // { ok, text }
  // 진행 중인 '연결 확인' — 공급자나 키를 바꾸면 취소해, 이전 공급자의 모델 목록이 새 공급자에 섞이지 않게 한다
  const checkRef = useRef(null);
  const editedRef = useRef(false);   // 사용자가 손대기 시작했으면 불러온 값으로 덮어쓰지 않는다
  const mountedRef = useRef(true);

  useEffect(() => () => { mountedRef.current = false; }, []);

  // 이 기기에 키가 없으면 다른 기기에서 저장한 설정이 있는지 먼저 확인한다
  // (앱을 열자마자 AI 입력을 눌러 시작 동기화보다 먼저 이 화면이 열린 경우)
  useEffect(() => {
    if (Object.values(getAIConfig().keys).some(k => k.trim())) return;
    syncAISettings()
      .then(result => {
        if (result !== 'pulled' || !mountedRef.current || editedRef.current) return;
        setConfig(getAIConfig());
        setStatus({
          ok: true,
          text: `다른 기기에서 저장한 AI 설정을 불러왔습니다${compact ? ' — 저장하고 계속을 누르세요' : ''}`,
        });
      })
      .catch(() => { /* 오프라인 등 — 직접 입력하면 된다 */ });
  }, [compact]);

  const cancelCheck = () => {
    if (checkRef.current) checkRef.current.abort();
    checkRef.current = null;
    setChecking(false);
  };
  useEffect(() => () => { if (checkRef.current) checkRef.current.abort(); }, []);

  const provider = config.provider;
  const info = PROVIDERS[provider];
  const apiKey = config.keys[provider] || '';
  const model = config.models[provider] || info.defaultModel;

  const update = (patch) => {
    editedRef.current = true;
    setConfig(c => ({
      provider: patch.provider ?? c.provider,
      keys: { ...c.keys, ...(patch.keys || {}) },
      models: { ...c.models, ...(patch.models || {}) },
    }));
  };

  const switchProvider = (p) => {
    if (p === provider) return;
    cancelCheck();
    update({ provider: p });
    setModels([]);
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

  const save = () => {
    cancelCheck();
    const next = {
      ...config,
      keys: { ...config.keys, [provider]: apiKey.trim() },
      models: { ...config.models, [provider]: model },
    };
    saveAIConfig(next);
    setStatus({ ok: true, text: '저장했습니다' });
    // 다른 기기 공유는 뒤에서 — 실패해도 이 기기는 바로 쓸 수 있고, 다음에 앱을 열 때 다시 올린다
    pushAISettings()
      .then(shared => {
        if (shared && mountedRef.current) {
          setStatus({ ok: true, text: '저장했습니다 — 같은 계정으로 로그인한 휴대폰·PC에서도 바로 쓸 수 있습니다' });
        }
      })
      .catch(() => { if (mountedRef.current) setStatus({ ok: false, text: SHARE_FAIL }); });
    if (onSaved) onSaved(next);
  };

  const removeKey = () => {
    cancelCheck();
    const next = { ...config, keys: { ...config.keys, [provider]: '' } };
    saveAIConfig(next);
    setConfig(next);
    setModels([]);
    setStatus({ ok: true, text: '키를 삭제했습니다' });
    pushAISettings()
      .then(shared => {
        if (shared && mountedRef.current) setStatus({ ok: true, text: '모든 기기에서 키를 삭제했습니다' });
      })
      .catch(() => {
        if (mountedRef.current) {
          setStatus({ ok: false, text: '이 기기에서는 지웠지만 다른 기기에 알리지 못했습니다 — 다음에 앱을 열 때 다시 시도합니다' });
        }
      });
  };

  const modelOptions = models.length ? models : [model];

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
        선택한 AI로 전송됩니다. API 키는 가계부 파일과 따로, 이 Microsoft 계정의 OneDrive 설정 파일에 저장되어
        <b> 같은 계정으로 로그인한 휴대폰·PC에서는 다시 입력하지 않아도 됩니다.</b>
      </div>

      <div className="ai-actions">
        {config.keys[provider] && !compact && (
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
